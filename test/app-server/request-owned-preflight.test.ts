import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {AppServerRequestClient,ownedRequestFailure,type OwnedAsyncRequestHooks} from '../../src/app-server/request-client.ts';
import {ClientLifecycle} from '../../src/app-server/client-lifecycle.ts';
import {ClientRuntimeState} from '../../src/app-server/runtime-state.ts';
import {PendingResponses} from '../../src/app-server/pending-responses.ts';
import {ClientCloseCoordinator} from '../../src/app-server/close-coordinator.ts';
import {AppServerWriter} from '../../src/app-server/writer.ts';
import {parseLosslessJson,type RequestId} from '../../src/protocol/ids.ts';
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function fixture(clock?:()=>number,reply=true){
 const gate=new ClientLifecycle(),state=new ClientRuntimeState(),pending=new PendingResponses(gate),close=new ClientCloseCoordinator(gate,state,pending),frames:Record<string,unknown>[]=[];
 const writer=new AppServerWriter({async writeAll(bytes){const frame=parseLosslessJson<Record<string,unknown>>(Buffer.from(bytes).toString());frames.push(frame);if(reply)pending.respond(frame.id as RequestId,{ok:true,value:42n});},async flush(){}},close);
 return {gate,pending,close,frames,client:new AppServerRequestClient(gate,pending,writer,clock)};
}
function hooks<T>(token:T):OwnedAsyncRequestHooks<T>{return {async check(){return token;},validate(){},async dispose(){},writeStarted(){},writeComplete(){}};}
test('joined request binds fresh wire ID and exact native result before response',async()=>{
 const f=fixture(),token=Object.freeze({claim:'original'}),events:string[]=[],wait=deferred<typeof token>();let id:RequestId|undefined;
 const h=hooks(token);h.check=wire=>{id=wire;events.push('check');return wait.promise;};h.validate=v=>{assert.equal(v,token);events.push('validate');};h.writeStarted=()=>{events.push('started');};h.writeComplete=v=>{assert.equal(v,token);events.push('complete');};
 const task=f.client.requestWithOwnedPreflight('turn/start',{},10000,h);await tick();assert.equal(f.frames.length,0);assert.equal(f.gate.snapshot().inFlight,2n);wait.resolve(token);assert.equal(await task,42n);assert.equal(f.frames[0]!.id,id);assert.deepEqual(events,['check','validate','started','complete']);assert.equal(f.gate.snapshot().inFlight,0n);
});
test('deadline after native settlement disposes exact claim without wire',async()=>{
 let now=0,disposed=0;const f=fixture(()=>now),token={},wait=deferred<object>(),h=hooks(token);h.check=()=>wait.promise;h.dispose=async v=>{assert.equal(v,token);disposed++;};
 const task=f.client.requestWithOwnedPreflight('turn/start',{},100,h),rejected=assert.rejects(task,e=>ownedRequestFailure(e)?.kind==='Timeout');await tick();now=100;wait.resolve(token);await rejected;assert.equal(disposed,1);assert.equal(f.frames.length,0);assert.equal(f.pending.size,0);assert.equal(f.gate.snapshot().inFlight,0n);
});
test('pre-wire abort retains leases through check and cleanup join',async()=>{
 const f=fixture(),abort=new AbortController(),reason={},token={},wait=deferred<object>(),cleanup=deferred<void>(),entered=deferred<void>(),h=hooks(token);let settled=false;
 h.check=()=>wait.promise;h.dispose=async v=>{assert.equal(v,token);entered.resolve();await cleanup.promise;};
 const task=f.client.requestWithOwnedPreflight('turn/start',{},10000,h,abort.signal);void task.then(()=>{settled=true;},()=>{settled=true;});const rejected=assert.rejects(task,e=>e===reason);await tick();abort.abort(reason);await tick();assert.equal(settled,false);assert.equal(f.gate.snapshot().inFlight,2n);wait.resolve(token);await entered.promise;assert.equal(settled,false);assert.equal(f.gate.snapshot().inFlight,2n);cleanup.resolve();await rejected;assert.equal(f.frames.length,0);assert.equal(f.gate.snapshot().inFlight,0n);
});
test('sealed lifecycle during native check cannot dispatch from retained permit',async()=>{
 const f=fixture(),token={},wait=deferred<object>(),h=hooks(token);let disposed=0;h.check=()=>wait.promise;h.dispose=async()=>{disposed++;};
 const task=f.client.requestWithOwnedPreflight('turn/start',{},10000,h),rejected=assert.rejects(task,/closed/);await tick();f.gate.seal();wait.resolve(token);await rejected;assert.equal(disposed,1);assert.equal(f.frames.length,0);assert.equal(f.gate.snapshot().inFlight,0n);
});
test('released original admission is rejected after native wait without recapture',async()=>{
 const f=fixture(),permit=f.gate.admit(),token={},wait=deferred<object>(),h=hooks(token);let disposed=0;h.check=()=>wait.promise;h.dispose=async()=>{disposed++;};
 const task=f.client.requestAdmittedWithOwnedPreflight(permit,'turn/start',{},10000,h),rejected=assert.rejects(task,/owned client permit/);await tick();permit.release();wait.resolve(token);await rejected;assert.equal(disposed,1);assert.equal(f.frames.length,0);assert.equal(f.gate.snapshot().inFlight,0n);
});
test('validation that seals admission is caught before wire',async()=>{
 const f=fixture(),h=hooks({});let disposed=0;h.validate=()=>f.gate.seal();h.dispose=async()=>{disposed++;};await assert.rejects(f.client.requestWithOwnedPreflight('turn/start',{},10000,h),/closed/);assert.equal(disposed,1);assert.equal(f.frames.length,0);assert.equal(f.gate.snapshot().inFlight,0n);
});
test('rejected native check preserves identity and never invents a claim to dispose',async()=>{
 const f=fixture(),reason={},h=hooks({});let disposed=0;h.check=async()=>{throw reason;};h.dispose=async()=>{disposed++;};await assert.rejects(f.client.requestWithOwnedPreflight('turn/start',{},10000,h),e=>e===reason);assert.equal(disposed,0);assert.equal(f.pending.size,0);assert.equal(f.gate.snapshot().inFlight,0n);
});
test('callback pinning and Promise-only check reject active object behavior',async()=>{
 const f=fixture(),wait=deferred<object>(),token={},h=hooks(token);let original=0,replacement=0,thenCalls=0;h.check=()=>wait.promise;h.validate=()=>{original++;};const task=f.client.requestWithOwnedPreflight('read',{},10000,h);await tick();h.validate=()=>{replacement++;};wait.resolve(token);await task;assert.equal(original,1);assert.equal(replacement,0);
 const bad=hooks(token);bad.check=(()=>({get then(){thenCalls++;return ()=>{};}})) as unknown as typeof bad.check;await assert.rejects(f.client.requestWithOwnedPreflight('read',{},10000,bad),/Promise/);assert.equal(thenCalls,0);assert.equal(f.gate.snapshot().inFlight,0n);
});
test('accessor and proxy hook sets are rejected without invoking traps',async()=>{
 const f=fixture();let calls=0;const accessor=hooks({});Object.defineProperty(accessor,'check',{get(){calls++;return async()=>({});}});await assert.rejects(f.client.requestWithOwnedPreflight('read',{},10000,accessor),/own request hook/);
 const proxy=new Proxy(hooks({}),{getOwnPropertyDescriptor(){calls++;throw Error('trap');}});await assert.rejects(f.client.requestWithOwnedPreflight('read',{},10000,proxy),/owned request hooks/);assert.equal(calls,0);assert.equal(f.gate.snapshot().inFlight,0n);
});
test('post-wire cancellation keeps mutation response owner until transport closes',async()=>{
 const f=fixture(undefined,false),abort=new AbortController(),reason={},complete=deferred<void>(),h=hooks({});let disposed=0;h.writeComplete=()=>complete.resolve();h.dispose=async()=>{disposed++;};const task=f.client.requestWithOwnedPreflight('turn/start',{},10000,h,abort.signal),rejected=assert.rejects(task,e=>e===reason);await complete.promise;abort.abort(reason);await rejected;assert.equal(disposed,0);assert.equal(f.pending.size,1);assert.equal(f.gate.snapshot().inFlight,1n);await f.close.markClosed('test cleanup');assert.equal(f.gate.snapshot().inFlight,0n);
});
test('expired response timer cannot send after a native wait even with a lagging sampled clock',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(()=>0),token={},wait=deferred<object>(),h=hooks(token);let disposed=0;h.check=()=>wait.promise;h.dispose=async()=>{disposed++;};
 const task=f.client.requestWithOwnedPreflight('turn/start',{},100,h),rejected=assert.rejects(task,e=>ownedRequestFailure(e)?.kind==='Timeout');await tick();t.mock.timers.tick(100);await tick();wait.resolve(token);await rejected;assert.equal(f.frames.length,0);assert.equal(disposed,1);assert.equal(f.gate.snapshot().inFlight,0n);
});
test('detached response occurrence cannot authorize a later wire write',async()=>{
 const f=fixture(),token={},wait=deferred<object>(),entered=deferred<RequestId>(),h=hooks(token);let disposed=0;h.check=id=>{entered.resolve(id);return wait.promise;};h.dispose=async()=>{disposed++;};
 const task=f.client.requestWithOwnedPreflight('turn/start',{},10000,h),rejected=assert.rejects(task,e=>ownedRequestFailure(e)?.kind==='ResponseChannelClosed');const id=await entered.promise,claim=f.pending.takeResponse(id)!;
 try{wait.resolve(token);await rejected;assert.equal(f.frames.length,0);assert.equal(disposed,1);assert.equal(f.gate.snapshot().inFlight,1n);}finally{claim.dispose();}assert.equal(f.gate.snapshot().inFlight,0n);
});
test('dispatch state belongs to the exact response occurrence, including expiry and replacement',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const gate=new ClientLifecycle(),pending=new PendingResponses(gate),old=pending.register('id',gate.admit(),10,false);assert.equal(old.dispatchState(),'Pending');t.mock.timers.tick(10);assert.equal(old.dispatchState(),'Timeout');
 const next=pending.register('id',gate.admit(),10,false);assert.equal(old.dispatchState(),'Timeout');assert.equal(next.dispatchState(),'Pending');old.finish();old.dispose();assert.equal(next.dispatchState(),'Pending');const claim=pending.takeResponse('id')!;assert.equal(next.dispatchState(),'Unavailable');claim.dispose();next.finish();next.dispose();assert.equal(gate.snapshot().inFlight,0n);
});
