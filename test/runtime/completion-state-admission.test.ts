import assert from "node:assert/strict";
import {test} from "node:test";
import {existsSync} from "node:fs";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {usingInitializedStore} from "../../src/store/owned-scope.ts";
import {listFilteredIn} from "../../src/store/queue-read.ts";
import {TargetLocks} from "../../src/core/keyed-locks.ts";
import {CompletionEventBudget,type CompletionNotification} from "../../src/runtime/completion/scheduler/envelope.ts";
import {CompletionReady,type ReadyStateWork} from "../../src/runtime/completion/scheduler/ready.ts";
import {prepareCompletionState} from "../../src/runtime/completion/scheduler/state-admission.ts";
function live(method='turn/completed',status='interrupted',turn='turn'):ReadyStateWork<CompletionNotification>{const budget=new CompletionEventBudget();return {kind:'Live',live:budget.chargeOwned({kind:'Notification',generation:1n,notification:{method,params:{threadId:'target',turn:{id:turn,status}}}})!};}
function release(work:ReadyStateWork<CompletionNotification>){if(work.kind==='Live')work.live.dispose();}
async function running(path:string){await state.enqueue(path,queueJob({ownerUserId:2n}));const c=(await state.tryBeginAttempt(path,'saved',[],1n))!;await state.markRunningIfClaimed(path,c,'turn');return (await state.listFiltered(path,'target',null))[0]!;}
test("existing-only filtered read never creates a missing database and rejects invalid filters first",async()=>storeFixture(async path=>{
 assert.equal(existsSync(path),false);assert.throws(()=>state.listFilteredExisting(path,'target',null));assert.equal(existsSync(path),false);assert.throws(()=>state.listFilteredExisting(path,null,1n<<63n),RangeError);assert.equal(existsSync(path),false);
}));
test("initialized and existing filtered paths share exact SQL filtering and borrowed transaction semantics",async()=>storeFixture(async path=>{
 await running(path);await state.enqueue(path,queueJob({jobId:'other',targetThreadId:'other',appServerGeneration:2n}));for(const [target,gen] of [[null,null],['target',null],[null,2n],['other',2n],['missing',1n]] as const)assert.deepEqual(state.listFilteredExisting(path,target,gen),await state.listFiltered(path,target,gen));
 await usingInitializedStore(path,db=>{db.exec('BEGIN');assert.equal(listFilteredIn(db,'target',null).length,1);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');db.exec("UPDATE codex_turn_queue SET state='invalid' WHERE job_id='other'");});assert.equal(state.listFilteredExisting(path,'target',null).length,1);assert.throws(()=>state.listFilteredExisting(path,null,null),/invalid durable queue state/);
}));
test("busy target returns no admission without reading state",()=>{
 const locks=new TargetLocks(),held=locks.tryAcquire('target')!,work=live();try{assert.equal(prepareCompletionState('unused',locks,work,{listFilteredExisting(){throw new Error('must not read');}}),null);}finally{held.release();release(work);}assert.equal(locks.activeTargetCount,0);
});
test("exact terminal owner is captured under lease; timestamp/identity drift and released permit are refused",async()=>storeFixture(async path=>{
 const job=await running(path),locks=new TargetLocks(),work=live(),admitted=prepareCompletionState(path,locks,work)!;try{assert.equal(admitted.needsNative,false);assert.equal(locks.tryAcquire('target'),undefined);admitted.permit.validateOwner(job);admitted.permit.validateOwner({...job,createdAt:-0});assert.throws(()=>admitted.permit.validateOwner({...job,updatedAt:job.updatedAt+0.0001}),/owner changed/);assert.throws(()=>admitted.permit.validateOwner({...job,jobId:'replacement'}),/owner changed/);}finally{admitted.release();release(work);}assert.throws(()=>admitted.permit.validateOwner(job),/lease mismatch/);assert.equal(locks.activeTargetCount,0);
}));
test("missing terminal owner cannot adopt a job appearing after admission",async()=>storeFixture(async path=>{
 await usingInitializedStore(path,()=>{});const locks=new TargetLocks(),work=live(),admitted=prepareCompletionState(path,locks,work)!;try{const job=await running(path);assert.throws(()=>admitted.permit.validateOwner(job),/owner changed/);}finally{admitted.release();release(work);}
}));
test("failed/interrupted Goal terminal consumes native capacity even though envelope did not request history",async()=>storeFixture(async path=>{
 await running(path);await usingInitializedStore(path,db=>{db.exec('UPDATE codex_turn_queue SET goal_waiting=1');});const locks=new TargetLocks(),work=live();assert.equal(work.kind==='Live'&&work.live.needsNative,false);const ready=new CompletionReady<CompletionNotification>();if(work.kind!=='Live')throw new Error();ready.live(work.live);
 assert.equal(ready.takeStateAdmitted(new Set(),3,w=>prepareCompletionState(path,locks,w)),null);assert.equal(locks.activeTargetCount,0);assert.equal(ready.stateLength,1);
 const admitted=ready.takeStateAdmitted(new Set(),2,w=>prepareCompletionState(path,locks,w))!;assert.equal(admitted.needsNative,true);admitted.permit.release();if(admitted.work.kind==='Live')admitted.work.live.dispose();ready.dispose();
}));
test("nonterminal event never reads DB and its owner mode is not terminal-specific",()=>{
 const locks=new TargetLocks(),work=live('item/completed'),admitted=prepareCompletionState('unused',locks,work,{listFilteredExisting(){throw new Error('must not read');}})!;try{admitted.permit.validateOwner(queueJob());assert.equal(admitted.needsNative,false);admitted.permit.requireTarget('target');assert.throws(()=>admitted.permit.requireTarget('other'),/lease mismatch/);}finally{admitted.release();release(work);}
});
test("durable Observed captures exact turn while rediscoverable Queue needs native but no owner read",async()=>storeFixture(async path=>{
 const job=await running(path),locks=new TargetLocks();const entry={source:'Observed' as const,id:'e',target:'target',turn:'turn',channel:1n,bytes:0n,position:{stamp:0,ordinal:0n,id:'e'}};const observed=prepareCompletionState(path,locks,{kind:'Durable',entry})!;assert.equal(observed.needsNative,true);observed.permit.validateOwner(job);observed.release();
 const queued=prepareCompletionState('unused',locks,{kind:'Durable',entry:{...entry,source:'Queue'}},{listFilteredExisting(){throw new Error('must not read');}})!;assert.equal(queued.needsNative,true);queued.release();
}));
test("read or snapshot failure releases the target lease and retains live envelope ownership",()=>{
 const locks=new TargetLocks(),work=live(),sentinel={readFailed:true};try{assert.throws(()=>prepareCompletionState('unused',locks,work,{listFilteredExisting(){throw sentinel;}}),e=>e===sentinel);assert.equal(locks.activeTargetCount,0);}finally{release(work);}
});
test("captured owner is isolated from mutable adapter results and uses exact source find ordering",()=>{
 const first=queueJob({jobId:'first',state:'Running',turnId:'turn'}),second=queueJob({jobId:'second',state:'Running',turnId:'turn'}),locks=new TargetLocks(),work=live(),admitted=prepareCompletionState('unused',locks,work,{listFilteredExisting:()=>[first,second]})!;try{const original={...first};first.prompt='changed';admitted.permit.validateOwner(original);assert.throws(()=>admitted.permit.validateOwner(second),/owner changed/);}finally{admitted.release();release(work);}
});
