import assert from 'node:assert/strict';import {test} from 'node:test';import {setImmediate as tick} from 'node:timers/promises';
import {CompletionExecution} from '../../../../src/runtime/completion/scheduler/execution.ts';
import {CompletionReady} from '../../../../src/runtime/completion/scheduler/ready.ts';
import {CompletionEventBudget,type CompletionNotification} from '../../../../src/runtime/completion/scheduler/envelope.ts';
import {CompletionStateAdmission,prepareCompletionStateOwned} from '../../../../src/runtime/completion/scheduler/state-admission.ts';
import {TargetLocks} from '../../../../src/core/keyed-locks.ts';import type {StoredQueueJob} from '../../../../src/store/queue-read.ts';import {queueJob} from '../../../helpers/queue-job.ts';
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fixture(){
 const ready=new CompletionReady<CompletionNotification>(),budget=new CompletionEventBudget(),locks=new TargetLocks(),reads=new Map<string,ReturnType<typeof deferred<StoredQueueJob|null>>>(),states=new Map<string,ReturnType<typeof deferred<void>>>(),started:string[]=[],errors:unknown[]=[];
 const executor=new CompletionExecution<CompletionStateAdmission>(ready,{
  prepare(){assert.fail('native profile must not call synchronous DB prepare');},
  prepareOwned:w=>prepareCompletionStateOwned(locks,w,async(target,_turn,signal)=>{const gate=deferred<StoredQueueJob|null>();reads.set(target,gate);const owner=await gate.promise;signal.throwIfAborted();return owner;}),
  state:async(_work,permit,signal)=>{permit.requireTarget(permit.target);started.push(permit.target);const gate=deferred<void>();states.set(permit.target,gate);const abort=()=>gate.reject(signal.reason);signal.addEventListener('abort',abort,{once:true});try{signal.throwIfAborted();await gate.promise;}finally{signal.removeEventListener('abort',abort);}},
  http:async()=>assert.fail('no HTTP expected'),prepareFailed:e=>{errors.push(e);},
 });
 const live=(target:string)=>{const event=budget.chargeOwned({kind:'Notification',generation:1n,notification:{method:'turn/completed',params:{threadId:target,turn:{id:'turn',status:'interrupted'}}}})!;assert.ok(event);ready.live(event);};
 const resolve=(target:string,native=false)=>reads.get(target)!.resolve(queueJob({jobId:target,targetThreadId:target,state:'Running',turnId:'turn',goalWaiting:native}));
 const close=async()=>{const closing=executor.close(new Error('fixture close'));for(const read of reads.values())read.resolve(null);for(const state of states.values())state.resolve();await closing;};
 return {ready,budget,locks,reads,states,started,errors,executor,live,resolve,close};
}
async function resolveRead(f:ReturnType<typeof fixture>,target:string,native=false){for(let i=0;i<100;i++){if(f.reads.has(target)){f.resolve(target,native);await tick();return;}await tick();}assert.fail('original read was not admitted: '+target);}
test('asynchronous selection reserves original target and a state place while keeping its ready envelope charged',async()=>{
 const f=fixture();try{f.live('a');f.live('a');const charged=f.budget.availableBytes,launch=f.executor.launchOwned();await tick();assert.equal(f.executor.stateCount,1);assert.equal(f.locks.activeTargetCount,1);assert.equal(f.executor.activeTargets().has('a'),true);assert.equal(f.ready.stateLength,2);assert.deepEqual(f.started,[]);assert.equal(f.budget.availableBytes,charged);assert.throws(()=>f.executor.launchOwned(),/not reentrant/);await resolveRead(f,'a');await launch;assert.deepEqual(f.started,['a']);assert.equal(f.ready.stateLength,1);assert.equal(f.budget.availableBytes,charged);}finally{await f.close();}assert.equal(f.locks.activeTargetCount,0);assert.equal(f.budget.availableBytes,f.budget.capacity);
});
test('four non-native exact owners still run together after ordered native reads',async()=>{
 const f=fixture();try{for(const t of ['a','b','c','d'])f.live(t);const launch=f.executor.launchOwned();for(const t of ['a','b','c','d'])await resolveRead(f,t);await launch;assert.deepEqual(f.started,['a','b','c','d']);assert.equal(f.executor.nativeCount,0);assert.equal(f.executor.stateCount,4);}finally{await f.close();}
});
test('three goal-waiting native lanes do not strand independent fourth non-native work',async()=>{
 const f=fixture();try{for(const t of ['a','b','c','d','e'])f.live(t);const launch=f.executor.launchOwned();for(const t of ['a','b','c','d'])await resolveRead(f,t,true);await resolveRead(f,'e',false);await launch;assert.deepEqual(f.started,['a','b','c','e']);assert.equal(f.executor.nativeCount,3);assert.equal(f.executor.stateCount,4);assert.equal(f.locks.activeTargetCount,4);const free=f.locks.tryAcquire('d');assert.ok(free);free.release();assert.equal(f.ready.stateLength,1);
 f.states.get('a')!.resolve();await tick();assert.equal(f.executor.nativeCount,3);f.executor.takeSettled();f.reads.delete('d');const next=f.executor.launchOwned();await resolveRead(f,'d',true);await next;assert.deepEqual(f.started,['a','b','c','e','d']);assert.equal(f.executor.nativeCount,3);}finally{await f.close();}
});
test('same-target successor cannot overtake original selected owner before harvest',async()=>{
 const f=fixture();try{f.live('a');f.live('a');const launch=f.executor.launchOwned();await resolveRead(f,'a');await launch;await f.executor.launchOwned();assert.deepEqual(f.started,['a']);f.states.get('a')!.resolve();await tick();assert.equal(f.executor.activeTargets().has('a'),true);f.executor.takeSettled();assert.equal(f.executor.activeTargets().has('a'),false);}finally{await f.close();}
});
test('shutdown waits actual original preparation join before releasing target and byte ownership',async()=>{
 const f=fixture(),reason=new Error('original shutdown');f.live('a');const launch=f.executor.launchOwned(),rejected=assert.rejects(launch,e=>e===reason);await tick();let closed=false;const pending=f.executor.close(reason).then(()=>{closed=true;});await tick();assert.equal(closed,false);assert.equal(f.locks.activeTargetCount,1);assert.ok(f.budget.availableBytes<f.budget.capacity);f.reads.get('a')!.resolve(null);await rejected;await pending;assert.equal(f.locks.activeTargetCount,0);assert.equal(f.budget.availableBytes,f.budget.capacity);assert.deepEqual(f.started,[]);
});
test('failed preparation reports gap once, retains original live work, and releases the target',async()=>{
 const f=fixture(),reason={nativeReadFailed:true};try{f.live('a');const charged=f.budget.availableBytes,launch=f.executor.launchOwned();await tick();f.reads.get('a')!.reject(reason);await launch;assert.deepEqual(f.errors,[reason]);assert.deepEqual(f.started,[]);assert.equal(f.executor.takeSettled().length,0);assert.equal(f.ready.stateLength,1);assert.equal(f.locks.activeTargetCount,0);assert.equal(f.budget.availableBytes,charged);}finally{await f.close();}
});
test('ready mutation is refused during owned selection without stealing caller envelope ownership',async()=>{
 const f=fixture();try{f.live('a');const launch=f.executor.launchOwned();await tick();const event=f.budget.chargeOwned({kind:'Notification',generation:1n,notification:{method:'item/completed',params:{threadId:'other'}}})!;try{assert.throws(()=>f.ready.live(event),/selection owns/);}finally{event.dispose();}await resolveRead(f,'a');await launch;}finally{await f.close();}
});
test('exact owner snapshot refuses replacement and released or reused preparations',async()=>{
 const locks=new TargetLocks(),budget=new CompletionEventBudget(),event=budget.chargeOwned({kind:'Notification',generation:1n,notification:{method:'turn/completed',params:{threadId:'a',turn:{id:'turn',status:'interrupted'}}}})!,job=queueJob({jobId:'a',targetThreadId:'a',state:'Running',turnId:'turn',goalWaiting:true});
 const p=prepareCompletionStateOwned(locks,{kind:'Live',live:event},async()=>job)!;try{const admission=await p.complete(new AbortController().signal);assert.equal(admission.needsNative,true);admission.permit.validateOwner(job);const original={...job};job.prompt='changed after read';admission.permit.validateOwner(original);assert.throws(()=>admission.permit.validateOwner(job),/owner changed/);await assert.rejects(p.complete(new AbortController().signal),/already used/);p.release();assert.throws(()=>admission.permit.requireTarget('a'),/lease mismatch/);}finally{p.release();event.dispose();}assert.equal(locks.activeTargetCount,0);
});
test('nonterminal preparation skips owner DB entirely and busy targets reserve nothing',async()=>{
 const locks=new TargetLocks(),budget=new CompletionEventBudget(),event=budget.chargeOwned({kind:'Notification',generation:1n,notification:{method:'item/completed',params:{threadId:'a'}}})!,work={kind:'Live' as const,live:event},read=async()=>assert.fail('no terminal owner read');const p=prepareCompletionStateOwned(locks,work,read)!;try{assert.equal(prepareCompletionStateOwned(locks,work,read),null);const ready=await p.complete(new AbortController().signal);assert.equal(ready.needsNative,false);}finally{p.release();event.dispose();}
});
test('missing owner never adopts later job and wrong owner identity is refused before handler',async()=>{
 const locks=new TargetLocks(),budget=new CompletionEventBudget();for(const result of [null,queueJob({targetThreadId:'other',state:'Running',turnId:'turn'})]){const event=budget.chargeOwned({kind:'Notification',generation:1n,notification:{method:'turn/completed',params:{threadId:'a',turn:{id:'turn',status:'failed'}}}})!,p=prepareCompletionStateOwned(locks,{kind:'Live',live:event},async()=>result)!;try{if(result===null){const a=await p.complete(new AbortController().signal);assert.throws(()=>a.permit.validateOwner(queueJob()),/owner changed/);}else await assert.rejects(p.complete(new AbortController().signal),/identity changed/);}finally{p.release();event.dispose();}}assert.equal(locks.activeTargetCount,0);
});

test('cancellation after ready selection but before state launch releases selected bytes and original lease',async t=>{
 const f=fixture(),cancel=new AbortController(),reason=new Error('cancel between selection and launch');f.live('a');const original=f.ready.takeStateAdmittedAsync.bind(f.ready);
 t.mock.method(f.ready,'takeStateAdmittedAsync',async(...args:Parameters<typeof f.ready.takeStateAdmittedAsync>)=>{const chosen=await original(...args);cancel.abort(reason);return chosen;});
 try{const launch=f.executor.launchOwned(cancel.signal),rejected=assert.rejects(launch,e=>e===reason);await resolveRead(f,'a');await rejected;assert.deepEqual(f.started,[]);assert.equal(f.executor.stateCount,0);assert.equal(f.ready.stateLength,0);assert.equal(f.locks.activeTargetCount,0);assert.equal(f.budget.availableBytes,f.budget.capacity);}finally{await f.close();}
});

test('pre-cancelled owned launch never reserves a target or invokes any owner read',async()=>{
 const f=fixture(),c=new AbortController(),reason={preCancelled:true};try{f.live('a');c.abort(reason);assert.throws(()=>f.executor.launchOwned(c.signal),e=>e===reason);assert.equal(f.locks.activeTargetCount,0);assert.equal(f.reads.size,0);assert.equal(f.executor.stateCount,0);assert.equal(f.ready.stateLength,1);}finally{await f.close();}assert.equal(f.budget.availableBytes,f.budget.capacity);
});
