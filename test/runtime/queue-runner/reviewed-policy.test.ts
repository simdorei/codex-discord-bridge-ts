import test from 'node:test';import assert from 'node:assert/strict';import {setTimeout as sleep} from 'node:timers/promises';
import {QueueStartCoordinator,BackendFailureError,type QueueStartBackend} from '../../../src/runtime/queue-runner/start-coordinator.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {REVIEWED_INCIDENT_THREAD as T} from '../../../src/store/async-resolution-policy.ts';
import {reviewedRecoveryPolicyInstalledIn} from '../../../src/store/reviewed-recovery-policy.ts';
import {AdmissionGate,DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';import {storeFixture} from '../../helpers/store-fixture.ts';
const backend:QueueStartBackend={generation:()=>1n,residentInstanceId:()=>null,activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async()=>{throw Error('No RPC expected');}};
test('policy installation requires owning gate before any database access',async()=>{
 let calls=0;const queue=new QueueStartCoordinator('unused',backend,{state:{...state,installReviewedRecoveryPolicy:async()=>{calls++;}}});
 await assert.rejects(queue.installReviewedRecoveryPolicy(),BackendFailureError);assert.equal(calls,0);assert.equal(queue.locks.activeTargetCount,0);
});
test('actual policy installer uses the central facade under shared target and control ownership',async()=>storeFixture(async path=>{
 const queue=new QueueStartCoordinator(path,backend,{admission:new AdmissionGate()});await queue.installReviewedRecoveryPolicy();
 const db=await openInitialized(path);try{assert.equal(reviewedRecoveryPolicyInstalledIn(db),true);}finally{db.close();}
 assert.equal(queue.locks.activeTargetCount,0);
}));
test('closed controls refuse installation and release acquired target lock',async()=>{
 const gate=new AdmissionGate(),key=DrainFenceKey.create('r','1|2','n');gate.seal(key);gate.closeControls(key);let calls=0;
 const queue=new QueueStartCoordinator('unused',backend,{admission:gate,state:{...state,installReviewedRecoveryPolicy:async()=>{calls++;}}});
 await assert.rejects(queue.installReviewedRecoveryPolicy());assert.equal(calls,0);assert.equal(queue.locks.activeTargetCount,0);assert.equal(gate.isDrainedFor(key),true);
});
test('pending durable write retains both permits; failure preserves identity then releases both',async()=>{
 let entered!:()=>void,release!:(error:unknown)=>void;const ready=new Promise<void>(r=>entered=r),write=new Promise<void>((_,r)=>release=r);
 const gate=new AdmissionGate(),key=DrainFenceKey.create('r','1|2','n'),queue=new QueueStartCoordinator('unused',backend,{admission:gate,state:{...state,installReviewedRecoveryPolicy:()=>{entered();return write;}}});
 const failure={write:true},task=queue.installReviewedRecoveryPolicy();await ready;gate.seal(key);assert.equal(gate.isDrainedFor(key),false);assert.equal(queue.locks.tryAcquire(T),undefined);
 const unrelated=queue.locks.tryAcquire('other');assert.ok(unrelated);unrelated.release();
 release(failure);await assert.rejects(task,e=>e===failure);assert.equal(queue.locks.activeTargetCount,0);assert.equal(gate.isDrainedFor(key),true);
});
test('busy target times out at source budget without stealing original lock or executing late',async()=>{
 let calls=0;const queue=new QueueStartCoordinator('unused',backend,{admission:new AdmissionGate(),state:{...state,installReviewedRecoveryPolicy:async()=>{calls++;}}}),lease=await queue.locks.acquire(T);
 try{await assert.rejects(queue.installReviewedRecoveryPolicy(),e=>e instanceof BackendFailureError&&e.message.includes('target lock is busy'));assert.equal(calls,0);assert.equal(queue.locks.tryAcquire(T),undefined);}finally{lease.release();}
 await sleep(1);assert.equal(calls,0);assert.equal(queue.locks.activeTargetCount,0);
});
