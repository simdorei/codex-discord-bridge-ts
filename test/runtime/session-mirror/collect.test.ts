import test from 'node:test';
import assert from 'node:assert/strict';
import {collectSessionItems as collect,formatMirrorItem} from '../../../src/runtime/session-mirror/collect.ts';
const event=(type:string,payload:unknown,timestamp='1')=>({type,payload,timestamp});
const msg=(text:string)=>event('event_msg',{type:'agent_message',message:text});
const started=(id:string)=>event('event_msg',{type:'task_started',turn_id:id});
const terminal=(id:string,type='task_complete',extra:Record<string,unknown>={})=>event('event_msg',{type,turn_id:id,...extra});

test('source literal commentary goldens and normal visible kinds',()=>{
  const events=[event('event_msg',{type:'user_message',message:'from app'}),event('response_item',{type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'working'}]},'2'),event('response_item',{type:'reasoning',summary:[{type:'summary_text',text:'checking'}]},'3'),event('response_item',{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'duplicate final'}]},'4'),terminal('turn-1','task_complete',{last_agent_message:'done'})];
  const send=collect('thread-1',events,'Send').items;
  assert.deepEqual(send.map(i=>[i.kind,i.text]),[['User','from app'],['Commentary','working'],['Final','done']]);
  assert.equal(send[1]!.digest,'771270a7b689873878753c03a9a8c01b8d8a0b94b11060d99479e3a27ca44c4f');
  assert.equal(collect('thread-1',[msg('working')],'Send').items[0]!.digest,'36357d4878fa5dbf0c7fb367a21205f3d801c53cb0a8e2319c53bb358b69aa01');
  assert.ok(collect('thread-1',events,'All').items.some(i=>i.text==='checking'));
});
test('source indexed activity goldens retain intentional identical parts',()=>{
  const items=collect('thread-1',[event('response_item',{type:'reasoning',summary:[{text:'checking'},{text:'checking'}]},'2')],'All').items;
  assert.deepEqual(items.map(i=>i.digest),['c8dea18ba5692261e9d7044748b921d649f5ac8e6824dc317b0375f8cbaa8673','bc830572b59debef8929edca66645494ff13e7b59225c4e241b2ed6c2951064c']);
  assert.ok(items.every(i=>!i.dedupeRecentText));
});
test('equivalent user shapes dedupe one occurrence but preserve later repeats',()=>{
  const response=event('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'same'}]});
  const user=event('event_msg',{type:'user_message',message:'same'});
  const out=collect('t',[response,user,{...user,timestamp:'2'}],'Send').items;
  assert.equal(out.length,2);assert.notEqual(out[0]!.digest,out[1]!.digest);
});
test('turn identity attaches before dedupe and persists across poll boundaries',()=>{
  const one=collect('t',[started('one'),msg('same'),started('two'),msg('same')],'Send');
  assert.equal(one.items.length,2);assert.notEqual(one.items[0]!.digest,one.items[1]!.digest);assert.equal(one.currentTurn,'two');
  assert.deepEqual(collect('t',[msg('same')],'Send','two').items,[one.items[1]]);
  assert.equal(collect('t',[event('turn_context',{turn_id:'three'}),event('event_msg',{type:'task_started',turn_id:''})],'Send','two').currentTurn,'three');
});
test('one terminal per explicit turn regardless of timestamp/text/error; other turns remain distinct',()=>{
  const out=collect('t',[terminal('one','task_complete',{last_agent_message:'done'}),terminal('one','task_aborted'),terminal('two','task_cancelled')],'Send').items;
  assert.deepEqual(out.map(i=>i.kind),['Final','Aborted']);assert.notEqual(out[0]!.digest,out[1]!.digest);
  const again=collect('t',[{...terminal('one','task_complete',{error:{message:'different'}}),timestamp:'later'}],'Send').items[0]!;
  assert.equal(again.digest,out[0]!.digest);assert.equal(again.kind,'Failed');
});
test('empty explicit terminal inherits context with event digest and completion fallback differs from whitespace',()=>{
  assert.equal(collect('t',[terminal('')],'Send','inherited').items[0]!.turnId,'inherited');
  assert.equal(collect('t',[terminal('')],'Send').items[0]!.text,'Codex turn completed without a visible reply.');
  assert.equal(collect('t',[terminal('one','task_complete',{last_agent_message:'  '}),terminal('one','task_aborted')],'Send').items.length,0);
});
test('internal prefix filtering uses Rust whitespace: NEL strips, BOM stays visible',()=>{
  for(const prefix of ['# AGENTS.md instructions','<INSTRUCTIONS>','<environment_context','<codex_internal_context']){
    assert.equal(collect('t',[event('event_msg',{type:'user_message',message:'\u0085 '+prefix})],'Send').items.length,0);
    assert.equal(collect('t',[event('event_msg',{type:'user_message',message:'\uFEFF'+prefix})],'Send').items.length,1);
  }
});
test('message content joins only nonempty input/output text and excludes assistant analysis and provisional final',()=>{
  const payload={type:'message',role:'assistant',phase:'commentary',content:[{type:'input_text',text:' a '},{type:'image',text:'secret'},{type:'output_text',text:''},{type:'output_text',text:'b '}]};
  assert.equal(collect('t',[event('response_item',payload)],'All').items[0]!.text,'a \nb');
  for(const phase of ['analysis','final_answer',''])assert.equal(collect('t',[event('response_item',{...payload,phase})],'All').items.length,0);
  assert.equal(collect('t',[event('event_msg',{type:'agent_message',phase:'final_answer',message:'premature'})],'All').items.length,0);
});
test('All activity keeps raw whitespace, explicit tool names and lossless fallback JSON',()=>{
  const es=[event('response_item',{type:'reasoning',summary:['  a  ',{text:'b'},null,1n]}),event('response_item',{type:'function_call',name:'run'}),event('response_item',{type:'custom_tool_call_output',output:{z:18446744073709551615n,a:true}})];
  const items=collect('t',es,'All').items;assert.deepEqual(items.map(i=>i.text),['  a  ','b','Tool call: run','Tool output:\n{"a":true,"z":18446744073709551615}']);assert.equal(collect('t',es,'Send').items.length,0);
});
test('known error envelopes peel at most four and preserve blocking non-string nested message',()=>{
  const error=(raw:unknown)=>collect('t',[terminal('v','task_complete',{error:raw})],'Send').items[0]?.text;
  assert.equal(error({message:'{"error":{"message":"real"}}'}),'real');
  assert.equal(error({message:'{"error":{"message":null},"message":"must not fall back"}'}),'{"error":{"message":null},"message":"must not fall back"}');
  let raw='problem';for(let i=0;i<5;i++)raw=JSON.stringify({message:raw});assert.equal(error({message:raw}),'{"message":"problem"}');
  assert.equal(error({message:'   '}),undefined);
});
test('snapshot rejects arbitrary accessors/proxies without hooks and does not mutate caller events',()=>{
  let calls=0;const bad={get payload(){calls++;return {};}};assert.throws(()=>collect('t',[bad],'Send'),TypeError);
  const proxy=new Proxy({},{get(){calls++;throw Error('trap');}});assert.throws(()=>collect('t',[proxy],'Send'),TypeError);assert.equal(calls,0);
  const input=[msg('hello')],before=structuredClone(input),out=collect('t',input,'Send');assert.deepEqual(input,before);assert.ok(Object.isFrozen(out)&&Object.isFrozen(out.items)&&Object.isFrozen(out.items[0]));
  assert.throws(()=>collect('t',[null],'Send'),TypeError);assert.throws(()=>collect('\uD800',[],'Send'),TypeError);
});
test('source presentation prefixes for all kinds and unmodified aborted headline',()=>{
  const items=collect('t',[event('event_msg',{type:'user_message',message:'u'}),msg('c'),terminal('1'),terminal('2','task_complete',{error:{message:'e'}}),terminal('3','turn_aborted'),terminal('4','task_aborted'),terminal('5','task_cancelled')],'Send').items;
  assert.deepEqual(items.map(formatMirrorItem),['Codex app user\n\nu','In progress\n\nc','Final\n\nCodex turn completed without a visible reply.','Failed\n\ne','Codex turn aborted.','Codex task aborted.','Codex task cancelled.']);
});
