import test from 'node:test';
import assert from 'node:assert/strict';
import {OwnedDispatchAttempt,type OwnedDispatchMutationFence} from '../../src/app-server/owned-dispatch-attempt.ts';
import {pinResidentNativeDispatch} from '../../src/app-server/resident-native-dispatch.ts';
import type {DispatchAttemptInput} from '../../src/app-server/dispatch-attempt.ts';
import {isOwnedMutationOutcomeUnknown} from '../../src/app-server/maintenance-attempt.ts';

const input:DispatchAttemptInput={ownerId:'owner',generation:1n,method:'turn/start',params:{threadId:'T'},repair:false,queueClaim:null,stopClaim:null,origin:null};
function fixture(){
 const receipt=Object.freeze({});const marked:(object|null)[]=[],finished:string[]=[];
 const fence:OwnedDispatchMutationFence={beginMutationWithOrigin:async()=>receipt,beginQueueMutation:async()=>receipt,beginStopMutation:async()=>receipt,finishMutation:async(r,o)=>{assert.equal(r,receipt);finished.push(o);},markOutcomeUnknown:r=>{marked.push(r);}};
 return {receipt,marked,finished,fence,make:()=>new OwnedDispatchAttempt(input,pinResidentNativeDispatch({...fence,validate:()=>{},close:async()=>{}}),()=> 'safe')};
}
test('mandatory synchronous Unknown hook survives both pinning wrappers',async()=>{
 const f=fixture(),attempt=f.make();f.fence.markOutcomeUnknown=()=>{throw new Error('replacement must not run');};
 await attempt.begin('wire');attempt.writeStarted();const result=await attempt.finish({ok:false,error:new Error('connection lost')});
 assert.equal(result.ok,false);assert.deepEqual(f.marked,[f.receipt]);assert.deepEqual(f.finished,[]);attempt.markOutcomeUnknown();assert.equal(f.marked.length,1);
});
test('posted begin uncertainty quarantines synchronously with null original receipt',async()=>{
 const f=fixture();f.fence.beginMutationWithOrigin=async()=>{throw new Error('begin ACK lost');};const attempt=f.make();
 await assert.rejects(attempt.begin('wire'),error=>{assert.deepEqual(f.marked,[null]);return isOwnedMutationOutcomeUnknown(error);});
});
test('started disposal quarantines without manufacturing a persistence finish',async()=>{
 const f=fixture(),attempt=f.make(),receipt=await attempt.begin('wire');attempt.writeStarted();
 const disposing=attempt.dispose(receipt);assert.deepEqual(f.marked,[f.receipt]);await disposing;assert.deepEqual(f.finished,[]);
});
test('original exit guard preserves cancellation and quarantines before escape',async()=>{
 const f=fixture(),attempt=f.make(),cancel=Object.freeze({cancel:true});await attempt.begin('wire');attempt.writeStarted();
 const original=()=>{try{throw cancel;}finally{attempt.markOutcomeUnknown();}};
 assert.throws(original,error=>{assert.equal(error,cancel);assert.deepEqual(f.marked,[f.receipt]);return true;});assert.deepEqual(f.finished,[]);
});
test('known not_sent disposal followed by cancellation does not quarantine',async()=>{
 const f=fixture(),attempt=f.make(),receipt=await attempt.begin('wire');await attempt.dispose(receipt);attempt.markOutcomeUnknown();
 assert.deepEqual(f.finished,['not_sent']);assert.deepEqual(f.marked,[]);
});
test('known finish followed by cleanup failure retains settlement',async()=>{
 const f=fixture(),attempt=f.make();await attempt.begin('wire');attempt.writeStarted();assert.deepEqual(await attempt.finish({ok:true,value:null}),{ok:true,value:null});
 const cleanup=new Error('cleanup');assert.throws(()=>{try{attempt.markOutcomeUnknown();throw cleanup;}finally{attempt.markOutcomeUnknown();}},error=>error===cleanup);
 assert.deepEqual(f.finished,['reply_ok']);assert.deepEqual(f.marked,[]);
});
test('post-begin result clone exception is covered by original exit guard',async()=>{
 const f=fixture(),attempt=f.make();await attempt.begin('wire');attempt.writeStarted();
 await assert.rejects((async()=>{try{return await attempt.finish({ok:true,value:()=>{}});}finally{attempt.markOutcomeUnknown();}})());
 assert.deepEqual(f.marked,[f.receipt]);assert.deepEqual(f.finished,[]);
});
test('renderer and hook exceptions cannot replace original Unknown classification',async()=>{
 const f=fixture();f.fence.markOutcomeUnknown=r=>{f.marked.push(r);throw new Error('notification failed');};
 const attempt=new OwnedDispatchAttempt(input,f.fence,()=>{throw new Error('render failed');});await attempt.begin('wire');attempt.writeStarted();
 const result=await attempt.finish({ok:false,error:new Error('wire lost')});assert.equal(result.ok,false);if(!result.ok)assert.equal(isOwnedMutationOutcomeUnknown(result.error),true);assert.deepEqual(f.marked,[f.receipt]);
});
test('private pre-post refusal suppresses Unknown; lookalike labels do not',async()=>{
 for(const proven of [true,false]){const f=fixture(),failure=new Error('BusyBeforePost');f.fence.beginMutationWithOrigin=async()=>{throw failure;};f.fence.wasNotSubmitted=e=>proven&&e===failure;const attempt=f.make();
 await assert.rejects(attempt.begin('wire'));attempt.markOutcomeUnknown();assert.deepEqual(f.marked,proven?[]:[null]);}
});
test('finish remains unconfirmed until exact owner ACK barrier resolves',async()=>{
 const f=fixture();let resolve!:()=>void;const barrier=new Promise<void>(r=>{resolve=r;});let entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;});f.fence.finishMutation=async()=>{entered();await barrier;};const attempt=f.make();await attempt.begin('wire');attempt.writeStarted();let finished=false;
 const pending=attempt.finish({ok:true,value:null});void pending.then(()=>{finished=true;});await ready;assert.equal(finished,false);resolve();await pending;attempt.markOutcomeUnknown();assert.deepEqual(f.marked,[]);
});
test('async Unknown hooks are rejected without invoking them',()=>{
 const f=fixture();let invoked=false;assert.throws(()=>pinResidentNativeDispatch({...f.fence,markOutcomeUnknown:async()=>{invoked=true;},validate:()=>{},close:async()=>{}}),/synchronous/);assert.equal(invoked,false);
});
