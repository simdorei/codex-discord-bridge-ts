import test from 'node:test';import assert from 'node:assert/strict';
import {scanNewReplyWindow} from '../../../src/runtime/new-reply/window.ts';
import {scanNewReplyWindowOffThread,DEFAULT_NEW_REPLY_WINDOW_LIMITS as limits} from '../../../src/runtime/new-reply/window-reader.ts';
import {OwnedWorkerBusyError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
const identity={threadId:'thread',cwd:'/project',turnId:'first-turn',promptSha256:'be41aba2fd84362ba49d22d8635d6c05f86426ee40846f1354e944062c4557a8'},initial={sessionSeen:false,turn:null,matched:false};
const events=[{type:'session_meta',payload:{id:'thread',cwd:'/project'}},{type:'turn_context',payload:{turn_id:'first-turn'}},{type:'event_msg',payload:{type:'user_message',message:'요청'}}],lines=events.map(x=>JSON.stringify(x)+'\n'),bytes=(s:string)=>new TextEncoder().encode(s);
test('actual native scan hashes first original user input and returns only complete boundary state',async()=>{
 const b=bytes(lines.join('')+'not decoded after match\n'),r=await scanNewReplyWindowOffThread(b,0n,identity,initial);assert.equal(r.stop,'Matched');assert.equal(r.nextOffset,BigInt(Buffer.byteLength(lines.join(''))));assert.equal(r.scannedRecords,3);assert.deepEqual(r.state,{sessionSeen:true,turn:'first-turn',matched:true});assert.deepEqual(ownedWorkerUsage(),{Background:0,Control:0,Bridge:0,Observation:0,Discovery:0,Maintenance:0});
});
test('bounded complete windows resume state without consuming incomplete trailing JSON',async()=>{
 const first=bytes(lines[0]!+lines[1]!.slice(0,-1)),a=await scanNewReplyWindowOffThread(first,0n,identity,initial);assert.equal(a.stop,'IncompleteRecord');assert.equal(a.nextOffset,BigInt(Buffer.byteLength(lines[0]!)));assert.equal(a.scannedRecords,1);
 const b=await scanNewReplyWindowOffThread(bytes(lines[1]!+lines[2]!),a.nextOffset,identity,a.state);assert.equal(b.stop,'Matched');assert.equal(b.scannedRecords,2);
});
test('record cap advances exactly the bounded prefix and invalid JSON/UTF8/blank lines reject whole result',async()=>{
 const r=scanNewReplyWindow(bytes(lines.join('')),0n,identity,initial,{...limits,maxRecords:1});assert.equal(r.stop,'RecordLimit');assert.equal(r.scannedRecords,1);assert.equal(r.nextOffset,BigInt(Buffer.byteLength(lines[0]!)));
 for(const bad of [bytes(lines[0]+'{bad}\n'),bytes(lines[0]+'\n'),new Uint8Array([0xff,10])])await assert.rejects(scanNewReplyWindowOffThread(bad,0n,identity,initial),/Invalid new rollout JSON\/UTF-8/);
});
test('LF-inclusive per-record limit rejects oversized and retains boundary for incomplete line',()=>{
 assert.throws(()=>scanNewReplyWindow(bytes('"123456"\n'),0n,identity,initial,{maxWindowBytes:20,maxRecordBytes:8,maxRecords:2}),RangeError);
 assert.throws(()=>scanNewReplyWindow(bytes('12345678'),0n,identity,initial,{maxWindowBytes:20,maxRecordBytes:8,maxRecords:2}),RangeError);
 const r=scanNewReplyWindow(bytes('1234567'),0n,identity,initial,{maxWindowBytes:20,maxRecordBytes:8,maxRecords:2});assert.equal(r.nextOffset,0n);assert.equal(r.stop,'IncompleteRecord');
});
test('saturation rejects another submission and abort joins native exit before releasing global budget',async()=>{
 const c=new AbortController(),reason=new Error('cancel native scan'),p=scanNewReplyWindowOffThread(bytes(lines.join('')),0n,identity,initial,limits,3000,c.signal);assert.equal(ownedWorkerUsage().Background,1);
 await assert.rejects(scanNewReplyWindowOffThread(bytes('null\n'),0n,identity,initial),OwnedWorkerBusyError);c.abort(reason);await assert.rejects(p,e=>e===reason);assert.equal(ownedWorkerUsage().Background,0);
});
test('deadline zero joins its owned native task and no decoded cursor escapes',async()=>{await assert.rejects(scanNewReplyWindowOffThread(bytes(lines.join('')),0n,identity,initial,limits,0),/timed out/);assert.equal(ownedWorkerUsage().Background,0);});
test('preabort and invalid passive limits reject before native allocation or hook execution',async()=>{
 const c=new AbortController(),reason=new Error('preabort');c.abort(reason);await assert.rejects(scanNewReplyWindowOffThread(bytes('null\n'),0n,identity,initial,limits,3000,c.signal),e=>e===reason);
 let hooks=0;const bad=Object.defineProperty({...limits},'maxRecords',{get(){hooks++;return 1;}});await assert.rejects(scanNewReplyWindowOffThread(bytes('null\n'),0n,identity,initial,bad),TypeError);assert.equal(hooks,0);await assert.rejects(scanNewReplyWindowOffThread(bytes('null\n'),0n,identity,initial,{...limits,maxRecords:257}),RangeError);assert.equal(ownedWorkerUsage().Background,0);
});
