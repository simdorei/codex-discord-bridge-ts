import assert from "node:assert/strict";
import {test} from "node:test";
import {setImmediate as tick} from "node:timers/promises";
import {CompletionReady,type ReadyStateWork,type ReadyAdmission} from "../../../../src/runtime/completion/scheduler/ready.ts";
import {CompletionEventBudget,type CompletionNotification} from "../../../../src/runtime/completion/scheduler/envelope.ts";
import {CompletionExecution,type CompletionExecutionPorts} from "../../../../src/runtime/completion/scheduler/execution.ts";
import type {CompletionEntry} from "../../../../src/store/completion-metadata.ts";
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
function fixture(overrides:Partial<CompletionExecutionPorts<string>>={}){
 const ready=new CompletionReady<CompletionNotification>(),budget=new CompletionEventBudget(),released:string[]=[],started:string[]=[],httpStarted:string[]=[],errors:unknown[]=[],stateGates=new Map<string,ReturnType<typeof deferred>>(),httpGates=new Map<string,ReturnType<typeof deferred>>();
 const key=(w:ReadyStateWork<CompletionNotification>)=>w.kind==='Live'?w.live.target:w.entry.target;
 const executor=new CompletionExecution(ready,{prepare:w=>{const k=key(w);return {permit:k,needsNative:w.kind==='Live'?w.live.needsNative:true,release:()=>{released.push(k);}};},state:async(w,p)=>{assert.equal(key(w),p);started.push(p);const d=deferred();stateGates.set(p,d);await d.promise;},http:async e=>{httpStarted.push(e.id);const d=deferred();httpGates.set(e.id,d);await d.promise;},prepareFailed:e=>{errors.push(e);},...overrides});
 const live=(target:string,native=true)=>{const e=budget.chargeOwned({kind:'Notification',generation:1n,notification:{method:native?'turn/completed':'item/completed',params:{threadId:target,turn:{id:'t',status:'completed'},item:{type:'agentMessage',phase:'commentary',text:'text'}}}})!;assert.ok(e);assert.equal(ready.live(e),true);};
 const http=(id:string,channel:bigint)=>{const e:CompletionEntry={source:'Final',id,target:id,turn:'t',channel,bytes:1n,position:{stamp:0,ordinal:0n,id}};ready.durable(e,new Set());return e;};
 return {ready,budget,released,started,httpStarted,errors,stateGates,httpGates,executor,live,http};
}
test('four state slots, three native slots, and same-target FIFO remain bounded until harvest',async()=>{
 const f=fixture();for(const t of ['a','b','c','d'])f.live(t);f.live('a',false);f.live('e',false);f.executor.launch();await tick();assert.deepEqual(f.started,['a','b','c','e']);assert.equal(f.executor.nativeCount,3);assert.equal(f.executor.stateCount,4);assert.equal(f.ready.stateLength,2);
 f.stateGates.get('a')!.resolve();await tick();assert.deepEqual(f.released,['d','a']);f.executor.launch();assert.equal(f.executor.stateCount,4);assert.deepEqual(f.started,['a','b','c','e']);const results=f.executor.takeSettled();assert.equal(results.length,1);assert.equal(f.executor.nativeCount,2);f.executor.launch();await tick();assert.deepEqual(f.started,['a','b','c','e','d']);assert.equal(f.executor.nativeCount,3);
 for(const d of f.stateGates.values())d.resolve();await tick();f.executor.takeSettled();f.executor.launch();await tick();assert.equal(f.started.at(-1),'a');f.stateGates.get('a')!.resolve();await tick();f.executor.takeSettled();await f.executor.close();assert.equal(f.budget.availableBytes,f.budget.capacity);
});
test('HTTP has four slots and one active writer per channel including unharvested results',async()=>{
 const f=fixture();f.http('a',1n);f.http('a-next',1n);for(let n=2;n<=5;n++)f.http(String(n),BigInt(n));f.executor.launch();await tick();assert.deepEqual(f.httpStarted,['a','2','3','4']);f.httpGates.get('a')!.resolve();await tick();f.executor.launch();assert.equal(f.httpStarted.length,4);f.executor.takeSettled();f.executor.launch();await tick();assert.equal(f.httpStarted.at(-1),'a-next');
 for(const d of f.httpGates.values())d.resolve();await tick();f.executor.takeSettled();f.executor.launch();await tick();assert.equal(f.httpStarted.at(-1),'5');f.httpGates.get('5')!.resolve();await tick();await f.executor.close();assert.equal(f.executor.httpCount,0);
});
test('synchronous and asynchronous state failures release admission and live byte ownership',async()=>{
 for(const asyncFailure of [false,true]){const reason=new Error('state failed'),f=fixture({state:()=>{if(asyncFailure)return Promise.reject(reason);throw reason;}});f.live('a');f.executor.launch();await tick();const r=f.executor.takeSettled()[0]!;assert.equal(r.outcome.ok,false);if(!r.outcome.ok)assert.equal(r.outcome.error,reason);assert.deepEqual(f.released,['a']);assert.equal(f.budget.availableBytes,f.budget.capacity);assert.equal(f.executor.nativeCount,0);await f.executor.close();}
});
test('preparation failure retains live ownership and does not consume slots or dispatch',async()=>{
 const reason=new Error('store unavailable'),f=fixture({prepare(){throw reason;}});f.live('a');f.executor.launch();assert.deepEqual(f.errors,[reason]);assert.equal(f.ready.stateLength,1);assert.equal(f.executor.stateCount,0);assert.ok(f.budget.availableBytes<f.budget.capacity);await f.executor.close();assert.equal(f.budget.availableBytes,f.budget.capacity);
});
test('native admission downgrade releases exactly its own unsuccessful prepared permit',async()=>{
 const f=fixture();for(const t of ['a','b','c','d'])f.live(t);f.executor.launch();await tick();assert.deepEqual(f.released,['d']);assert.equal(f.executor.stateCount,3);assert.equal(f.ready.stateLength,1);for(const d of f.stateGates.values())d.resolve();await tick();f.executor.takeSettled();f.executor.launch();await tick();assert.equal(f.started.at(-1),'d');f.stateGates.get('d')!.resolve();await tick();await f.executor.close();assert.equal(f.released.filter(x=>x==='d').length,2);
});
test('close propagates original abort reason and joins cooperative state and HTTP work',async()=>{
 const reason=new Error('shutdown'),seen:unknown[]=[],wait=(_input:unknown,_permit:unknown,signal:AbortSignal)=>new Promise<void>((_resolve,reject)=>{const abort=()=>{seen.push(signal.reason);reject(signal.reason);};if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});
 const f=fixture({state:wait,http:(e,s)=>wait(e,null,s)});f.live('a');f.live('b');f.http('h',1n);f.executor.launch();await tick();const closed=f.executor.close(reason);assert.equal(f.executor.close(reason),closed);await closed;assert.deepEqual(seen,[reason,reason,reason]);assert.equal(f.executor.stateCount,0);assert.equal(f.executor.httpCount,0);assert.equal(f.executor.nativeCount,0);assert.equal(f.budget.availableBytes,f.budget.capacity);assert.throws(()=>f.executor.launch(),/closed/);
});
test('close does not claim completion while noncooperative HTTP still owns a send',async()=>{
 const f=fixture();f.http('h',1n);f.executor.launch();await tick();let closed=false;const join=f.executor.close().then(()=>{closed=true;});await tick();assert.equal(closed,false);assert.equal(f.executor.httpCount,1);f.httpGates.get('h')!.resolve();await join;assert.equal(closed,true);assert.equal(f.executor.httpCount,0);
});
test('cleanup errors preserve original failure and still dispose retained live envelope',async()=>{
 const original=new Error('primary'),cleanup=new Error('cleanup'),f=fixture({prepare:()=>({permit:'a',needsNative:true,release(){throw cleanup;}}),state:async()=>{throw original;}});f.live('a');f.executor.launch();await tick();const r=f.executor.takeSettled()[0]!;assert.equal(r.outcome.ok,false);if(!r.outcome.ok){assert.ok(r.outcome.error instanceof AggregateError);assert.deepEqual(r.outcome.error.errors,[original,cleanup]);}assert.equal(f.budget.availableBytes,f.budget.capacity);await f.executor.close();
});
test('close before scheduled callbacks prevents new IO and releases prepared resources',async()=>{
 let calls=0;const f=fixture({state:async()=>{calls++;},http:async()=>{calls++;}});f.live('a');f.http('h',1n);f.executor.launch();await f.executor.close();assert.equal(calls,0);assert.deepEqual(f.released,['a']);assert.equal(f.budget.availableBytes,f.budget.capacity);
});

import {storeFixture} from '../../../helpers/store-fixture.ts';
import {queueJob} from '../../../helpers/queue-job.ts';
import {StateAccessFacade as state} from '../../../../src/store/state-access-facade.ts';
import {QueueStartCoordinator,type QueueStartBackend} from '../../../../src/runtime/queue-runner/start-coordinator.ts';
import {StagedCompletionHandler} from '../../../../src/runtime/completion/staged-handler.ts';
import {prepareCompletionState} from '../../../../src/runtime/completion/scheduler/state-admission.ts';
import type {AppRequest} from '../../../../src/app-server/requests.ts';
import {serdeField} from '../../../../src/app-server/value.ts';
test('real target admissions and handler keep blocked history isolated while another target stages Final',{timeout:10000},async()=>storeFixture(async path=>{
 const owner='00000000-0000-4000-8000-000000000001' as const;
 for(const target of ['a','b']){await state.enqueue(path,queueJob({jobId:target,targetThreadId:target,ownerUserId:2n}));const claim=(await state.tryBeginAttempt(path,target,[],1n))!;assert.ok(await state.markRunningIfClaimed(path,claim,'t'));}
 const gates=new Map([['a',deferred()],['b',deferred()]]),done=new Map([['a',deferred()],['b',deferred()]]),reads=deferred();let count=0;
 const server={instanceId:owner,generation:()=>1n,activeTurnId:()=>null,execute:async(request:AppRequest)=>{if(request.method==='thread/goal/get')return {goal:null};const target=serdeField(request.params,'threadId') as string;assert.ok(gates.has(target));if(++count===2)reads.resolve();await gates.get(target)!.promise;return {thread:{id:target,turns:[{id:'t',status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:target+' final'}]}]}};}};
 const backend:QueueStartBackend={generation:()=>1n,residentInstanceId:()=>owner,activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async()=>{throw new Error('Unexpected start');}},queue=new QueueStartCoordinator(path,backend),handler=new StagedCompletionHandler(server,queue,{commentaryEnabled:false,historyReadTimeoutMs:2000,render:()=> 'safe'}),ready=new CompletionReady<CompletionNotification>(),budget=new CompletionEventBudget();
 for(const target of ['a','b'])assert.equal(ready.live(budget.chargeOwned({kind:'Notification',generation:1n,notification:{method:'turn/completed',params:{threadId:target,turn:{id:'t',status:'completed'}}}})!),true);
 const executor=new CompletionExecution(ready,{prepare:work=>prepareCompletionState(path,queue.locks,work),state:async(work,permit,signal)=>{if(work.kind==='Live')await handler.handleLive(work.live.payload,permit,signal);else await handler.handleDurable(work.entry,permit,signal);done.get(permit.target)!.resolve();},http:async()=>{throw new Error('No HTTP hints');},prepareFailed:error=>{throw error;}});
 try{executor.launch();await reads.promise;assert.equal(queue.locks.activeTargetCount,2);assert.equal(executor.nativeCount,2);gates.get('b')!.resolve();await done.get('b')!.promise;await tick();const settled=executor.takeSettled();assert.equal(settled.length,1);const deliveries=await state.listPendingDeliveries(path);assert.equal(deliveries.length,1);assert.equal(deliveries[0]!.content,'Final\nb final');assert.equal((await state.listFiltered(path,'a',null))[0]!.state,'Running');assert.equal(queue.locks.activeTargetCount,1);
 gates.get('a')!.resolve();await done.get('a')!.promise;await tick();executor.takeSettled();assert.equal(executor.stateCount,0);assert.equal((await state.listPendingDeliveries(path)).length,2);assert.equal(queue.locks.activeTargetCount,0);
 }finally{for(const gate of gates.values())gate.resolve();await executor.close();}assert.equal(budget.availableBytes,budget.capacity);
}));
