import {it} from 'node:test';import assert from 'node:assert/strict';
import {RemoteMutationCache,RemoteMutationCacheBusyError} from '../../src/remote-agent/mutation-cache.ts';
import {parseGatewayCommand,type GatewayCommand} from '../../src/remote-agent/gateway-command.ts';
import {parseBridgeInboundMessage,type BridgeResult} from '../../src/remote-agent/bridge-inbound.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const equal=(a:unknown,b:unknown)=>assert.deepEqual(structuredClone(a),structuredClone(b));
const command=(request_id='r',extra:object={})=>parseGatewayCommand(JSON.stringify({type:'write_file',request_id,thread_id:'t',path:'a',content:'한글',...extra}),12_000_000,0);
const result=(request_id='r',path='a'):BridgeResult=>parseBridgeInboundMessage(serializeSerdeValue({type:'write_file_result',request_id,output:{path,sha256:'a'.repeat(64),bytes_written:18446744073709551615n,created:false}}),12_000_000) as BridgeResult;
const error=(request_id='r'):BridgeResult=>parseBridgeInboundMessage(JSON.stringify({type:'operation_error',request_id,error_code:'failed',message:'failure'}),1000) as BridgeResult;
it('same identity and changed deadline replay isolated immutable native result, content conflicts do not replace it',async()=>{
 const cache=new RemoteMutationCache(),c=command(),r=result();assert.equal(await cache.lookup(c),null);assert.equal(await cache.remember(c,r),'Retained');
 const a=await cache.lookup(command('r',{deadline_at:'2030-01-01T00:00:00Z'}));equal(a,r);assert.notEqual(a,r);assert.ok(Object.isFrozen(a));assert.ok(Object.isFrozen((a as typeof r & {output:object}).output));
 const conflict=await cache.lookup(command('r',{content:'changed'}));assert.equal(conflict?.type,'operation_error');if(conflict?.type==='operation_error'){assert.equal(conflict.error_code,'request_id_conflict');assert.equal(conflict.message,'The request ID was reused with different command content.');}
 equal(await cache.lookup(c),r);assert.equal(cache.size,1);
});
it('tuple keys isolate thread, optional session and request without delimiter collisions',async()=>{
 const cache=new RemoteMutationCache();const cases=[command('a|b',{thread_id:'c'}),command('b',{thread_id:'c|a'}),command('a|b',{thread_id:'c',computer_session_id:'abcdefghijklmnop'}),command('other')];
 for(let i=0;i<cases.length;i++)assert.equal(await cache.remember(cases[i]!,result(cases[i]!.request_id,String(i))),'Retained');
 assert.equal(cache.size,4);for(let i=0;i<cases.length;i++)equal(await cache.lookup(cases[i]!),result(cases[i]!.request_id,String(i)));
});
it('matching hits refresh LRU while conflicts do not, and entry cap evicts the oldest',async()=>{
 const cache=new RemoteMutationCache(100000,2);const a=command('a'),b=command('b'),c=command('c');await cache.remember(a,result('a'));await cache.remember(b,result('b'));await cache.lookup(a);await cache.remember(c,result('c'));assert.equal(await cache.lookup(b),null);
 await cache.lookup(command('a',{content:'conflict'}));await cache.remember(b,result('b'));assert.equal(await cache.lookup(a),null);assert.notEqual(await cache.lookup(c),null);assert.equal(cache.size,2);
});
it('error results never replace success; valid replacement changes value without growing count',async()=>{
 const cache=new RemoteMutationCache(),c=command();assert.equal(await cache.remember(c,error()),'SkippedError');assert.equal(cache.size,0);await cache.remember(c,result());const charge=cache.retainedTextCharge;assert.equal(await cache.remember(c,error()),'SkippedError');assert.equal(cache.retainedTextCharge,charge);equal(await cache.lookup(c),result());
 await cache.remember(c,result('r','new'));assert.equal(cache.size,1);equal(await cache.lookup(c),result('r','new'));
});
it('retained text budget evicts by charge and an oversized result neither evicts nor pretends retention',async()=>{
 const probe=new RemoteMutationCache();await probe.remember(command('a'),result('a'));const one=probe.retainedTextCharge;const cache=new RemoteMutationCache(one+10,256,10000);
 await cache.remember(command('a'),result('a'));await cache.remember(command('b'),result('b'));assert.equal(cache.size,1);assert.equal(await cache.lookup(command('a')),null);const before=cache.retainedTextCharge;
 assert.equal(await cache.remember(command('b'),result('b','z'.repeat(2000))),'NotRetainedBudget');assert.equal(cache.retainedTextCharge,before);equal(await cache.lookup(command('b')),result('b'));
 cache.clear();assert.equal(cache.size,0);assert.equal(cache.retainedTextCharge,0);
});
it('native in-flight operation rejects overlap and clear without queueing, then releases ownership',async()=>{
 const cache=new RemoteMutationCache(4_194_304,256,2_000_000),large=command('r',{content:'x'.repeat(500000)});let ticks=0;const timer=setInterval(()=>ticks++,1);
 try{const pending=cache.remember(large,result());assert.equal(cache.busy,true);await assert.rejects(cache.lookup(large),RemoteMutationCacheBusyError);assert.throws(()=>cache.clear(),RemoteMutationCacheBusyError);assert.equal(await pending,'Retained');assert.equal(cache.busy,false);assert.ok(ticks>0);equal(await cache.lookup(large),result());}finally{clearInterval(timer);}
});
it('pre-abort and native validation failure preserve existing cache and permit later work',async()=>{
 const cache=new RemoteMutationCache(100000,2,1000),c=command();await cache.remember(c,result());const stop=new AbortController(),reason=new Error('abort');stop.abort(reason);await assert.rejects(cache.remember(c,result('r','new'),stop.signal),e=>e===reason);
 await assert.rejects(cache.remember(command('r',{content:'x'.repeat(2000)}),result()),RangeError);assert.equal(cache.busy,false);equal(await cache.lookup(c),result());
 await assert.rejects(cache.remember(c,result('wrong')),/request differs/);equal(await cache.lookup(c),result());
});
it('hostile or mutable boundary values do not execute getters, and key and constructor profiles fail closed',async()=>{
 const cache=new RemoteMutationCache(),c=command();let hooks=0;const accessor=Object.freeze({...c,get thread_id(){hooks++;return 't';}}) as GatewayCommand;await assert.rejects(cache.lookup(accessor),TypeError);
 const proxy=new Proxy(c,{get(){hooks++;throw Error('trap');}});await assert.rejects(cache.lookup(proxy),TypeError);await assert.rejects(cache.lookup({...c}),TypeError);assert.equal(hooks,0);
 await assert.rejects(cache.lookup(command('x'.repeat(4097))),RangeError);assert.equal(cache.size,0);assert.throws(()=>new RemoteMutationCache(1000,257),RangeError);assert.throws(()=>new RemoteMutationCache(0),RangeError);assert.throws(()=>new RemoteMutationCache(1000,1,12_000_001),RangeError);
});

it('remember rejects a mutable nested result before an await can hide its original state',async()=>{
 const cache=new RemoteMutationCache(),c=command(),r=result();if(r.type!=='write_file_result')throw Error('fixture');const output={...r.output};const value=Object.freeze({...r,output});const pending=cache.remember(c,value);output.path='changed';Object.freeze(output);await assert.rejects(pending,TypeError);assert.equal(cache.size,0);
});
it('cancellation during native work retains ownership until actual join and leaves earlier cache unchanged',async()=>{
 const cache=new RemoteMutationCache(4_194_304,256,2_000_000),old=command();await cache.remember(old,result());const charge=cache.retainedTextCharge;
 const stop=new AbortController(),reason=new Error('cancel native');const pending=cache.remember(command('r',{content:'x'.repeat(500000)}),result('r','changed'),stop.signal);stop.abort(reason);
 assert.equal(cache.busy,true);assert.throws(()=>cache.clear(),RemoteMutationCacheBusyError);await assert.rejects(pending,e=>e===reason);assert.equal(cache.busy,false);assert.equal(cache.retainedTextCharge,charge);equal(await cache.lookup(old),result());
});
