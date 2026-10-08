import assert from "node:assert/strict";
import {test} from "node:test";
import {TargetLocks,type TargetLease} from "../../../src/core/keyed-locks.ts";
import {QueueStartCoordinator,type QueueStartBackend} from "../../../src/runtime/queue-runner/start-coordinator.ts";
import {QueueRecoveryCoordinator} from "../../../src/runtime/queue-runner/recovery-coordinator.ts";
import {QueueRecoveryState} from "../../../src/runtime/queue-runner/recovery-state.ts";
import {StateAccessFacade as state} from "../../../src/store/state-access-facade.ts";
import {usingInitializedStore} from "../../../src/store/owned-scope.ts";
import {storeFixture} from "../../helpers/store-fixture.ts";
import {queueJob} from "../../helpers/queue-job.ts";
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
function backend(overrides:Partial<QueueStartBackend>={}){let starts=0;const value:QueueStartBackend={generation:()=>1n,residentInstanceId:()=>"resident",activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async()=>{starts++;return 'next';},...overrides};return {value,starts:()=>starts};}
async function running(path:string){await state.enqueue(path,queueJob({ownerUserId:2n}));const c=(await state.tryBeginAttempt(path,'saved',[],1n))!;await state.markRunningIfClaimed(path,c,'turn');return (await state.listFiltered(path,'target',null))[0]!;}
test("borrowed lease pins target until work settles even after original release",async()=>{
 const locks=new TargetLocks(),lease=locks.tryAcquire('T')!,entered=deferred(),release=deferred();let writer=false;
 const work=locks.runUnderLease(lease,async pin=>{entered.resolve();await release.promise;pin.requireTarget('T');return 7;});await entered.promise;lease.release();assert.throws(()=>lease.requireTarget('T'),/mismatch/);assert.equal(locks.tryAcquire('T'),undefined);const next=locks.run('T',()=>{writer=true;});await Promise.resolve();assert.equal(writer,false);release.resolve();assert.equal(await work,7);await next;assert.equal(writer,true);assert.equal(locks.activeTargetCount,0);
});
test("nested pins, rejection and synchronous throw return exact FIFO ownership",async()=>{
 const locks=new TargetLocks(),lease=locks.tryAcquire('T')!,order:string[]=[];const sentinel={fail:true};
 await assert.rejects(locks.runUnderLease(lease,async first=>{await locks.runUnderLease(first,second=>{second.requireTarget('T');order.push('nested');});throw sentinel;}),e=>e===sentinel);
 await assert.rejects(locks.runUnderLease(lease,()=>{throw sentinel;}),e=>e===sentinel);assert.equal(locks.tryAcquire('T'),undefined);lease.release();assert.deepEqual(order,['nested']);assert.equal(locks.activeTargetCount,0);
});
test("forged, foreign-registry and released capabilities execute no borrowed operation",async()=>{
 const locks=new TargetLocks(),other=new TargetLocks(),own=locks.tryAcquire('T')!,foreign=other.tryAcquire('T')!;let calls=0;const fake={target:'T',release(){},requireTarget(){calls++;}} satisfies TargetLease;
 for(const lease of [fake,foreign])await assert.rejects(locks.runUnderLease(lease,()=>{calls++;}),/mismatch/);own.release();await assert.rejects(locks.runUnderLease(own,()=>{calls++;}),/mismatch/);assert.equal(calls,0);foreign.release();
});
test("borrowed completion saves and notifies without reacquiring target or starting the next queued job",{timeout:10000},async()=>storeFixture(async path=>{
 const expected=await running(path);await state.enqueue(path,queueJob({jobId:'next',createdAt:1,ownerUserId:2n}));const b=backend();let notices=0;const queue=new QueueStartCoordinator(path,b.value,{notifyDeliveryReady:()=>{notices++;}}),lease=queue.locks.tryAcquire('target')!;
 try{const delivery=await queue.stageOwnedTurnCompletionUnderLease(lease,expected,'final',1n);assert.equal(delivery?.jobId,'saved');assert.equal(notices,1);assert.equal(b.starts(),0);const remaining=await state.listFiltered(path,'target',null);assert.equal(remaining.length,1);assert.equal(remaining[0]!.state,'Pending');assert.equal(queue.locks.tryAcquire('target'),undefined);}finally{lease.release();}
}));
test("private borrowed pin prevents a concurrent target writer while async store open is pending",async()=>storeFixture(async path=>{
 const expected=await running(path),entered=deferred(),release=deferred(),order:string[]=[];const queue=new QueueStartCoordinator(path,backend().value,{state:{...state,stageOwnedQueueCompletion:async(...args)=>{order.push('store-enter');entered.resolve();await release.promise;const result=await state.stageOwnedQueueCompletion(...args);order.push('store-done');return result;}}}),lease=queue.locks.tryAcquire('target')!;
 const completion=queue.stageOwnedTurnCompletionUnderLease(lease,expected,'final');await entered.promise;lease.release();const writer=queue.locks.run('target',()=>{order.push('writer');});await Promise.resolve();assert.deepEqual(order,['store-enter']);release.resolve();await completion;await writer;assert.deepEqual(order,['store-enter','store-done','writer']);assert.equal(queue.locks.activeTargetCount,0);
}));
test("wrong target, foreign registry and released completion lease cause no store mutation",async()=>storeFixture(async path=>{
 const expected=await running(path),queue=new QueueStartCoordinator(path,backend().value),other=new TargetLocks(),foreign=other.tryAcquire('target')!,wrong=queue.locks.tryAcquire('other')!;
 try{await assert.rejects(queue.stageOwnedTurnCompletionUnderLease(foreign,expected,'final'),/mismatch/);await assert.rejects(queue.stageOwnedTurnCompletionUnderLease(wrong,expected,'final'),/mismatch/);}finally{foreign.release();wrong.release();}
 const released=queue.locks.tryAcquire('target')!;released.release();await assert.rejects(queue.stageOwnedTurnCompletionUnderLease(released,expected,'final'),/mismatch/);assert.equal((await state.listFiltered(path,'target',null))[0]!.jobId,'saved');
}));
test("borrowed Goal progress and exact observed next turn reuse held target ownership",async()=>storeFixture(async path=>{
 const expected=await running(path),queue=new QueueStartCoordinator(path,backend().value),lease=queue.locks.tryAcquire('target')!;
 try{assert.equal((await queue.stageOwnedGoalProgressUnderLease(lease,expected,'progress'))?.content,'progress');const waiting=(await state.listFiltered(path,'target',null))[0]!;assert.equal(waiting.goalWaiting,true);assert.equal(await queue.goalTurnStartedObservedUnderLease(lease,'next',2n,waiting),false);assert.equal(await queue.goalTurnStartedObservedUnderLease(lease,'next',1n,waiting),true);const next=(await state.listFiltered(path,'target',null))[0]!;assert.equal(next.turnId,'next');assert.equal(next.goalWaiting,false);}finally{lease.release();}
}));
test("borrowed completion store failure returns pin but leaves outer lease owned",async()=>storeFixture(async path=>{
 const expected=await running(path),sentinel={storeFailed:true},queue=new QueueStartCoordinator(path,backend().value,{state:{...state,stageOwnedQueueCompletion:async()=>{throw sentinel;}}}),lease=queue.locks.tryAcquire('target')!;
 try{await assert.rejects(queue.stageOwnedTurnCompletionUnderLease(lease,expected,'final'),e=>e===sentinel);assert.equal(queue.locks.tryAcquire('target'),undefined);lease.requireTarget('target');}finally{lease.release();}assert.equal(queue.locks.activeTargetCount,0);
}));
test("incremental leased recovery preserves other targets backoff and cold inventory",async()=>storeFixture(async path=>{
 await usingInitializedStore(path,()=>{});const locks=new TargetLocks(),recovery=new QueueRecoveryState(()=>0n);recovery.initialize(new Set(['A','B']));recovery.onFailure('B','blocked');const coordinator=new QueueRecoveryCoordinator(path,backend().value,state,locks,null,()=>1000,async()=>null,{recovery}),lease=locks.tryAcquire('A')!;
 try{await coordinator.recoverIncrementalUnderLease(lease);assert.equal(recovery.retryDue('B'),false);assert.equal(recovery.isCold('B'),true);}finally{lease.release();}
}));
test("incremental first-page recovery forces cold unknown-Starting handling without initializing bulk inventory",async()=>storeFixture(async path=>{
 await state.enqueue(path,queueJob());const claimed=(await state.tryBeginAttempt(path,'saved',[],1n))!,b=backend(),queue=new QueueStartCoordinator(path,b.value,{clock:()=>claimed.updatedAt+121}),lease=queue.locks.tryAcquire('target')!;
 try{const result=await queue.recoverIncrementalUnderLease(lease);assert.equal(result.unresolved,1);assert.equal(result.started,0);assert.equal(b.starts(),0);const current=(await state.listFiltered(path,'target',null))[0]!;assert.equal(current.state,'Starting');assert.notEqual(current.lastError,'');}finally{lease.release();}
}));
test("orphan history review under an already-held lease returns without reacquiring or starting work",async()=>storeFixture(async path=>{
 await usingInitializedStore(path,()=>{});const b=backend(),queue=new QueueStartCoordinator(path,b.value),lease=queue.locks.tryAcquire('target')!;try{await queue.reconcileOrphanHistoryUnderLease(lease);assert.equal(b.starts(),0);lease.requireTarget('target');}finally{lease.release();}
}));
