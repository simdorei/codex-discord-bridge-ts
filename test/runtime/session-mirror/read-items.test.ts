import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';import {setTimeout as sleep} from 'node:timers/promises';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {readStableMirrorItems} from '../../../src/runtime/session-mirror/read-window.ts';
import {collectSessionItems} from '../../../src/runtime/session-mirror/collect.ts';
import {decodeMirrorWindowOffThread,collectMirrorWindowOffThread,mirrorDecoderBusy,joinMirrorDecoder} from '../../../src/runtime/session-mirror/decode-reader.ts';
import {OwnedWorkerBusyError} from '../../../src/runtime/owned-worker-slot.ts';
const limits={maxWindowBytes:1048576,maxRecordBytes:262144,maxRecords:1024,decodeTimeoutMs:3000};
const options={thread:'thread-1',detail:'All' as const,currentTurn:null};
const line=(x:unknown)=>JSON.stringify(x)+'\n';
test('actual worker display collection preserves exact goldens, turn context and complete boundary',async()=>storeFixture(async path=>{
 const events=[{type:'event_msg',payload:{type:'task_started',turn_id:'turn-1'}},{type:'event_msg',timestamp:'1',payload:{type:'agent_message',message:'한국어 😀'}},{type:'response_item',timestamp:'2',payload:{type:'reasoning',summary:[{text:'checking'},{text:'checking'}]}},{type:'event_msg',payload:{type:'task_complete',turn_id:'turn-1',last_agent_message:'done'}}];
 const complete=events.map(line).join('');await writeFile(path,complete+'{"partial":');
 const result=await readStableMirrorItems(path,0n,limits,options);
 assert.deepEqual(result.decoded.collection,collectSessionItems('thread-1',events,'All'));assert.equal(result.decoded.nextOffset,BigInt(Buffer.byteLength(complete)));assert.equal(result.decoded.stop,'IncompleteRecord');assert.equal(result.decoded.scannedRecords,4);assert.equal(Object.hasOwn(result.decoded,'events'),false);assert.ok(Object.isFrozen(result.decoded.collection.items));assert.equal(mirrorDecoderBusy(),false);
}));
test('worker lossless serialization and Send filtering retain inherited turn',async()=>storeFixture(async path=>{
 await writeFile(path,'{"type":"response_item","payload":{"type":"custom_tool_call_output","output":{"n":18446744073709551615}}}\n');
 const all=await readStableMirrorItems(path,0n,limits,{...options,currentTurn:'prior'});
 assert.equal(all.decoded.collection.items[0]!.text,'Tool output:\n{"n":18446744073709551615}');assert.equal(all.decoded.collection.items[0]!.turnId,'prior');
 const send=await readStableMirrorItems(path,0n,limits,{...options,detail:'Send',currentTurn:'prior'});assert.equal(send.decoded.collection.items.length,0);assert.equal(send.decoded.collection.currentTurn,'prior');assert.equal(send.decoded.nextOffset,all.decoded.nextOffset);
}));
test('invalid owned context rejects before filesystem or accessor hooks',async()=>{
 let calls=0;await assert.rejects(readStableMirrorItems('/does-not-exist',0n,limits,{...options,get thread(){calls++;return 'bad';}}),TypeError);assert.equal(calls,0);
 await assert.rejects(readStableMirrorItems('/does-not-exist',0n,limits,{...options,thread:'x'.repeat(16385)}),RangeError);
 await assert.rejects(readStableMirrorItems('/does-not-exist',0n,limits,{...options,currentTurn:'\ud800'}),TypeError);assert.equal(mirrorDecoderBusy(),false);
});
test('collection and decoding share one native slot without submitting a second worker',async()=>{
 const bytes=new TextEncoder().encode('{"x":true}\n');const first=decodeMirrorWindowOffThread(bytes,0n,1024,1024,10);
 try{assert.equal(mirrorDecoderBusy(),true);await assert.rejects(collectMirrorWindowOffThread(bytes,0n,1024,1024,10,options),OwnedWorkerBusyError);await first;}finally{await first.catch(()=>{});await joinMirrorDecoder();}assert.equal(mirrorDecoderBusy(),false);
});
test('excessive per-window display fanout rejects wholly rather than publishing a truncated prefix',async()=>storeFixture(async path=>{
 await writeFile(path,line({type:'response_item',payload:{type:'reasoning',summary:Array.from({length:16385},()=> 'x')}}));
 await assert.rejects(readStableMirrorItems(path,0n,limits,options),/output exceeds bounded window budget/);assert.equal(mirrorDecoderBusy(),false);
}));
test('actual collection abort retains native ownership until worker exit',async()=>storeFixture(async path=>{
 await writeFile(path,line({type:'response_item',payload:{type:'reasoning',summary:Array.from({length:10000},()=> 'x')}}));
 const stop=new AbortController(),reason={stop:true};let settled=false;
 const outcome=readStableMirrorItems(path,0n,limits,options,stop.signal).then(value=>{settled=true;return {ok:true as const,value};},error=>{settled=true;return {ok:false as const,error};});
 try{const end=performance.now()+3000;while(!mirrorDecoderBusy()&&!settled&&performance.now()<end)await sleep(1);assert.equal(mirrorDecoderBusy(),true);stop.abort(reason);const result=await outcome;assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error,reason);assert.equal(mirrorDecoderBusy(),false);}finally{stop.abort(reason);await outcome;await joinMirrorDecoder();}
}));
