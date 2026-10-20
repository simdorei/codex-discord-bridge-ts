import test from 'node:test';import assert from 'node:assert/strict';
import {OwnedDispatchAttempt,pinOwnedDispatchMutationFence,type OwnedDispatchMutationFence} from '../../src/app-server/owned-dispatch-attempt.ts';
import {captureDispatchAttemptInput,type DispatchAttemptInput} from '../../src/app-server/dispatch-attempt.ts';
import {isOwnedMutationOutcomeUnknown} from '../../src/app-server/maintenance-attempt.ts';
import {AppServerRequestError} from '../../src/app-server/request-client.ts';
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
const input:DispatchAttemptInput={ownerId:'owner',generation:1n,method:'turn/start',params:{threadId:'T'},repair:false,queueClaim:null,stopClaim:null,origin:{clock:0n}};
function fixture(i:DispatchAttemptInput=input){const receipt=Object.freeze({receipt:true}),calls:{kind:string;value:unknown}[]=[];const fence:OwnedDispatchMutationFence={beginMutationWithOrigin:async c=>{calls.push({kind:'ordinary',value:c});return receipt;},beginQueueMutation:async c=>{calls.push({kind:'queue',value:c});return receipt;},beginStopMutation:async c=>{calls.push({kind:'stop',value:c});return receipt;},finishMutation:async(r,o)=>{assert.equal(r,receipt);calls.push({kind:'finish',value:o});}};return {receipt,calls,fence,make:()=>new OwnedDispatchAttempt(i,fence,()=> 'safe')};}
test('shared capture preserves scoped method classification and clones original authority',()=>{
 for(const method of ['thread/resume','thread/settings/update','turn/start','turn/steer','thread/archive','thread/backgroundTerminals/clean','thread/unsubscribe'])assert.equal(captureDispatchAttemptInput({...input,method}).scoped,true);
 assert.equal(captureDispatchAttemptInput({...input,method:'other'}).scoped,false);assert.equal(captureDispatchAttemptInput({...input,method:'mcpServer/tool/call',repair:true}).scoped,true);
 const p={threadId:'T'},q=captureDispatchAttemptInput({...input,params:p});p.threadId='other';assert.equal((q.input.params as {threadId:string}).threadId,'T');
});
test('ordinary, original queue and original stop use separate native begin routes',async()=>{
 for(const [i,kind] of [[input,'ordinary'],[{...input,queueClaim:{job:'j'}},'queue'],[{...input,method:'turn/interrupt',stopClaim:{original:true}},'stop']] as const){const f=fixture(i),a=f.make();assert.equal(await a.begin(7n),f.receipt);assert.equal(f.calls[0]!.kind,kind);const c=f.calls[0]!.value as Record<string,unknown>;assert.equal(c.wire,7n);assert.equal(c.ownerId,'owner');assert.equal(c.generation,1n);assert.equal(typeof c.attemptId,'string');assert.equal(a.isolatesTarget(),true);}
});
test('observational and unclaimed interrupt do not fabricate persistence receipts',async()=>{
 for(const method of ['thread/read','turn/interrupt']){const f=fixture({...input,method}),a=f.make();assert.equal(await a.begin('wire'),null);a.writeStarted();assert.deepEqual(await a.finish({ok:true,value:{read:true}}),{ok:true,value:{read:true}});assert.equal(f.calls.length,0);assert.equal(a.isolatesTarget(),false);}
});
test('unsent disposal joins exact one completion before outer result returns',async()=>{
 const f=fixture(),wait=deferred<void>(),entered=deferred<void>();f.fence.finishMutation=async(r,o)=>{assert.equal(r,f.receipt);assert.equal(o,'not_sent');f.calls.push({kind:'finish',value:o});entered.resolve();await wait.promise;};const a=f.make(),r=await a.begin('wire');
 const disposing=a.dispose(r);await entered.promise;let done=false;const failure={},finishing=a.finish({ok:false,error:failure});void finishing.then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);wait.resolve();await disposing;assert.deepEqual(await finishing,{ok:false,error:failure});assert.equal(f.calls.filter(c=>c.kind==='finish').length,1);await assert.rejects(a.finish({ok:true,value:null}),/already handled/);
});
test('partial write disposal cannot turn unknown transport into not_sent',async()=>{
 const f=fixture(),a=f.make(),r=await a.begin('wire');a.writeStarted();await a.dispose(r);const result=await a.finish({ok:false,error:new Error('transport lost')});assert.equal(result.ok,false);if(!result.ok)assert.equal(isOwnedMutationOutcomeUnknown(result.error),true);assert.equal(f.calls.filter(c=>c.kind==='finish').length,0);
});
test('known Remote error alone settles reply_error; success settles reply_ok',async()=>{
 const remote=new AppServerRequestError({kind:'Remote',method:'turn/start',code:-1n,message:'denied',data:null});
 for(const [result,outcome] of [[{ok:true,value:42n},'reply_ok'],[{ok:false,error:remote},'reply_error']] as const){const f=fixture(),a=f.make();await a.begin('wire');a.writeStarted();assert.deepEqual(await a.finish(result),result);assert.equal(f.calls.at(-1)!.value,outcome);}
});
test('lookalike remote error cannot settle a prepared native attempt',async()=>{
 const f=fixture(),a=f.make();await a.begin('wire');a.writeStarted();const r=await a.finish({ok:false,error:{name:'AppServerRequestError',detail:{kind:'Remote'}}});assert.equal(r.ok,false);assert.equal(f.calls.length,1);
});
test('failed native begin has no receipt to dispose or falsely complete',async()=>{
 const f=fixture();f.fence.beginMutationWithOrigin=async()=>{throw new Error('unknown commit');};const a=f.make();await assert.rejects(a.begin('wire'),isOwnedMutationOutcomeUnknown);await a.dispose(null);assert.throws(()=>a.writeStarted(),/not ready/);const r=await a.finish({ok:false,error:new Error('caller')});assert.equal(r.ok,false);if(!r.ok)assert.equal(isOwnedMutationOutcomeUnknown(r.error),true);assert.equal(f.calls.length,0);
});
test('failed unsent completion remains unknown and is not retried by outer finish',async()=>{
 const f=fixture();let finishes=0;f.fence.finishMutation=async()=>{finishes++;throw new Error('commit uncertain');};const a=f.make(),r=await a.begin('wire');await assert.rejects(a.dispose(r),isOwnedMutationOutcomeUnknown);const result=await a.finish({ok:false,error:new Error('aborted')});assert.equal(result.ok,false);if(!result.ok)assert.equal(isOwnedMutationOutcomeUnknown(result.error),true);assert.equal(finishes,1);
});
test('pending native begin cannot be abandoned as finished or start writing early',async()=>{
 const f=fixture(),wait=deferred<object>();f.fence.beginMutationWithOrigin=()=>wait.promise;const a=f.make(),pending=a.begin('wire');assert.throws(()=>a.writeStarted(),/not ready/);await assert.rejects(a.finish({ok:false,error:null}),/still owned/);await assert.rejects(a.dispose(null),/still owned/);wait.resolve(f.receipt);assert.equal(await pending,f.receipt);await a.dispose(f.receipt);
});
test('callbacks pinned before later mutation; hostile accessors and thenables never execute',async()=>{
 const f=fixture(),a=f.make();f.fence.beginMutationWithOrigin=async()=>{throw new Error('replacement');};assert.equal(await a.begin('wire'),f.receipt);
 let hooks=0;const accessor={...f.fence};Object.defineProperty(accessor,'beginMutationWithOrigin',{get(){hooks++;return async()=>({});}});assert.throws(()=>pinOwnedDispatchMutationFence(accessor),/own native/);assert.equal(hooks,0);
 const bad=fixture();bad.fence.beginMutationWithOrigin=(()=>({get then(){hooks++;throw 0;}})) as unknown as typeof bad.fence.beginMutationWithOrigin;await assert.rejects(bad.make().begin('wire'),isOwnedMutationOutcomeUnknown);assert.equal(hooks,0);
});
test('foreign receipt cannot trigger disposal and malformed success preserves unknown state',async()=>{
 const f=fixture(),a=f.make();await a.begin('wire');await assert.rejects(a.dispose(Object.freeze({receipt:true})),/Foreign/);assert.equal(f.calls.length,1);
 const bad=fixture();bad.fence.beginMutationWithOrigin=async()=>({notFrozen:true});const b=bad.make();await assert.rejects(b.begin('wire'),isOwnedMutationOutcomeUnknown);assert.equal((await b.finish({ok:false,error:null})).ok,false);
});
