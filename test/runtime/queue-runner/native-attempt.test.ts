import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {queueJob} from '../../helpers/queue-job.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {createNativeQueueState,NativeQueueAttemptUnconfirmedError} from '../../../src/runtime/queue-runner/native-state.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
async function seed(path:string){await state.enqueue(path,queueJob({ownerUserId:2n,channelId:9007199254740995n}));}
async function edit(path:string,run:(db:DatabaseSync)=>void){const db=await openInitialized(path);try{run(db);}finally{db.close();}}
test('native queue overrides exactly four reads, two submissions and eight explicit lifecycle writes, preserving every other function reference',()=>{
 const native=createNativeQueueState('db'),changed=new Set(['enqueue','enqueueIfMirrorMatches','listFiltered','eligibleJobs','deadTargetHeld','asyncTargetDispatchHeld','recordPreflightFailure','tryBeginAttempt','recordStartFailureIfClaimed','markRunningWithResidentIfClaimed','markGoalWaiting','attachGoalTurnObservedIfOwned','stageOwnedQueueCompletion','stageOwnedGoalProgress']);assert.equal(Object.isFrozen(native),true);assert.deepEqual(Object.keys(native),Object.keys(state));
 for(const key of Object.keys(state) as (keyof typeof state)[])if(changed.has(key))assert.notEqual(native[key],state[key]);else assert.equal(native[key],state[key]);
});
test('native preflight/claim/Running preserve whole row, lossless ID and no-match null',async()=>storeFixture(async path=>{
 await seed(path);const native=createNativeQueueState(path);const failed=await native.recordPreflightFailure(path,'saved',1n,'\u0085'+'😀'.repeat(1001)+'\u0085');assert.equal(failed?.lastError,'😀'.repeat(1000));assert.equal(failed?.attemptCount,1n);assert.equal(failed?.channelId,9007199254740995n);assert.equal(Object.getPrototypeOf(failed),null);assert.equal(await native.recordPreflightFailure(path,'saved',-1n,'ignored'),null);
 const baseline=['old','older','old'],task=native.tryBeginAttempt(path,'saved',baseline,1n);baseline.reverse();baseline.push('late');const claim=await task;assert.ok(claim);assert.deepEqual(claim.baselineTurnIds,['old','older','old']);assert.equal(claim.attemptCount,2n);assert.equal(await native.tryBeginAttempt(path,'saved',[],1n),null);const running=await native.markRunningWithResidentIfClaimed(path,claim,'turn😀','resident');assert.equal(running?.state,'Running');assert.equal(running?.turnId,'turn😀');assert.equal(await native.markRunningWithResidentIfClaimed(path,claim,'duplicate','resident'),null);assert.equal((await state.listFiltered(path,null,null)).length,1);assert.equal(ownedWorkerUsage().Control,0);
}));
test('native claimed failure preserves captured input and ambiguous retry fence',async()=>storeFixture(async path=>{
 await seed(path);const native=createNativeQueueState(path),claim=await native.tryBeginAttempt(path,'saved',[],1n);assert.ok(claim);const task=native.recordStartFailureIfClaimed(path,claim,'uncertain',true);claim.baselineTurnIds.push('caller-mutated');claim.jobId='other';const failed=await task;assert.equal(failed?.jobId,'saved');assert.equal(failed?.state,'Starting');assert.equal(failed?.lastError,'uncertain');assert.deepEqual(failed?.baselineTurnIds,[]);assert.equal((await state.listFiltered(path,null,null))[0]?.jobId,'saved');assert.equal(ownedWorkerUsage().Control,0);
}));
test('native admission and stale full claim cannot be mistaken for successful mutation',async()=>storeFixture(async path=>{
 await seed(path);const native=createNativeQueueState(path),claim=await native.tryBeginAttempt(path,'saved',['old'],1n);assert.ok(claim);await edit(path,db=>db.exec("UPDATE codex_turn_queue SET baseline_turn_ids='[\"changed\"]'"));assert.equal(await native.recordStartFailureIfClaimed(path,claim,'no',false),null);assert.equal(await native.markRunningWithResidentIfClaimed(path,claim,'no',null),null);assert.deepEqual((await state.listFiltered(path,null,null))[0]!.baselineTurnIds,['changed']);
}));
test('native returned-row decode error rolls back claim and remains unconfirmed',async()=>storeFixture(async path=>{
 await seed(path);await edit(path,db=>db.exec("CREATE TRIGGER corrupt_native AFTER UPDATE ON codex_turn_queue WHEN NEW.state='starting' BEGIN UPDATE codex_turn_queue SET baseline_turn_ids='bad' WHERE job_id=NEW.job_id; END"));const before=await state.listFiltered(path,null,null);await assert.rejects(createNativeQueueState(path).tryBeginAttempt(path,'saved',[],1n),NativeQueueAttemptUnconfirmedError);assert.deepEqual(await state.listFiltered(path,null,null),before);
}));
test('native attempt rejects malformed passive input before worker or file access',async()=>storeFixture(async path=>{
 const native=createNativeQueueState(path);let calls=0;const array=Object.defineProperty(['safe'],0,{get(){calls++;return 'evil';}});await assert.rejects(native.tryBeginAttempt(path,'saved',array,1n));await assert.rejects(native.tryBeginAttempt(path,'saved',new Proxy([],{get(){calls++;throw Error('trap');}}),1n));const claim=Object.defineProperty(queueJob(), 'jobId',{get(){calls++;return 'evil';}});await assert.rejects(native.markRunningWithResidentIfClaimed(path,claim,'turn',null));await assert.rejects(native.recordPreflightFailure(path+'other','saved',1n,'error'));await assert.rejects(native.recordPreflightFailure(path,'saved',1n<<63n,'error'));await assert.rejects(native.tryBeginAttempt(path,'\ud800',[],1n));assert.equal(calls,0);assert.equal(existsSync(path),false);assert.equal(ownedWorkerUsage().Control,0);
}));
test('all native writers refuse missing initialized database without creating it',async()=>storeFixture(async path=>{
 const native=createNativeQueueState(path),claim=queueJob({state:'Starting'});for(const call of [()=>native.recordPreflightFailure(path,'saved',1n,'error'),()=>native.tryBeginAttempt(path,'saved',[],1n),()=>native.recordStartFailureIfClaimed(path,claim,'error',false),()=>native.markRunningWithResidentIfClaimed(path,claim,'turn',null)]){await assert.rejects(call(),NativeQueueAttemptUnconfirmedError);assert.equal(existsSync(path),false);}
}));
test('Control busy refuses new claim but completion Running waits without Background fallback',async()=>storeFixture(async path=>{
 await seed(path);const claim=await state.tryBeginAttempt(path,'saved',[],1n);assert.ok(claim);const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');const native=createNativeQueueState(path),read=native.listFiltered(path,null,null);const running=native.markRunningWithResidentIfClaimed(path,claim,'accepted',null);let settled=false;void running.then(()=>settled=true,()=>settled=true);const caught=running.catch(e=>{throw e;});
 try{await assert.rejects(native.tryBeginAttempt(path,'saved',[],1n),OwnedWorkerBudgetError);await new Promise(r=>setTimeout(r,100));assert.equal(settled,false);assert.equal(ownedWorkerUsage().Control,1);assert.equal(ownedWorkerUsage().Background,0);db.exec('ROLLBACK');await read;assert.equal((await caught)?.turnId,'accepted');assert.equal(ownedWorkerUsage().Control,0);}finally{if(db.isTransaction)db.exec('ROLLBACK');await Promise.allSettled([read,running,caught]);db.close();}
}));
test('late native claim commit remains unconfirmed until actual join; no premature lease release or replay',async()=>storeFixture(async path=>{
 await seed(path);const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');const native=createNativeQueueState(path,30);let done=false,ticks=0;const task=native.tryBeginAttempt(path,'saved',[],1n),timer=setInterval(()=>ticks++,10);void task.then(()=>done=true,()=>done=true);const rejected=assert.rejects(task,(e:unknown)=>e instanceof NativeQueueAttemptUnconfirmedError&&e.operation==='Claim');
 try{await new Promise(r=>setTimeout(r,200));assert.equal(done,false);assert.ok(ticks>=3);assert.equal(ownedWorkerUsage().Control,1);db.exec('ROLLBACK');await rejected;assert.equal(ownedWorkerUsage().Control,0);const row=(await state.listFiltered(path,null,null))[0]!;assert.equal(row.state,'Starting');assert.equal(row.attemptCount,1n);assert.equal(await createNativeQueueState(path).tryBeginAttempt(path,'saved',[],1n),null);}finally{clearInterval(timer);if(db.isTransaction)db.exec('ROLLBACK');await task.catch(()=>{});db.close();}
}));
test('invalid complete acknowledgement cannot become a null lost claim or success',async t=>{
 t.mock.method(OwnedWorkerSlot.prototype,'run',async()=>({ok:true,value:false}));await assert.rejects(createNativeQueueState('db').tryBeginAttempt('db','saved',[],1n));
});

test('actual start coordinator retains target ownership through native persistence after backend accepted',async()=>storeFixture(async path=>{
 const {QueueStartCoordinator}=await import('../../../src/runtime/queue-runner/start-coordinator.ts');await seed(path);let db:DatabaseSync|undefined;let accepted!:()=>void;const reached=new Promise<void>(resolve=>accepted=resolve);let starts=0;
 const native=createNativeQueueState(path),queue=new QueueStartCoordinator(path,{generation:()=>1n,residentInstanceId:()=>null,activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async()=>{starts++;db=new DatabaseSync(path);assert.equal(db.isTransaction,false);db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');accepted();return 'accepted';}},{state:native});
 const task=queue.kickTarget('target');let settled=false;void task.then(()=>settled=true,()=>settled=true);
 try{await reached;await new Promise(r=>setTimeout(r,100));assert.equal(settled,false);assert.equal(queue.locks.tryAcquire('target'),undefined);const unrelated=queue.locks.tryAcquire('other');assert.ok(unrelated);unrelated.release();assert.equal(ownedWorkerUsage().Control,1);db!.exec('ROLLBACK');await task;assert.equal(starts,1);assert.equal(queue.locks.activeTargetCount,0);assert.equal((await state.listFiltered(path,null,null))[0]?.turnId,'accepted');assert.equal(ownedWorkerUsage().Control,0);}finally{if(db?.isTransaction)db.exec('ROLLBACK');await task.catch(()=>{});db?.close();}
}));
