import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverStartingAttempt,observeRunningAttempt,type RecoveryTurn } from "../../../src/runtime/queue-runner/recovery-attempt.ts";
import { queueJob } from "../../helpers/queue-job.ts";
import { StateAccessFacade as state } from "../../../src/store/state-access-facade.ts";
import { storeFixture } from "../../helpers/store-fixture.ts";
import { STARTING_CANDIDATE_HOLD_PREFIX } from "../../../src/store/queue-read.ts";
const report=()=>({recoveredRunning:0,unresolved:0});
const turn=(turnId:string,status:RecoveryTurn["status"]="InProgress"):RecoveryTurn=>({turnId,status});
test("cold empty history marks unknown acceptance but never requeues or starts a request",async()=>{
  await storeFixture(async path=>{
    await state.enqueue(path,queueJob());const claim=(await state.tryBeginAttempt(path,"saved",[],1n))!;
    const r=report();assert.equal(await recoverStartingAttempt(path,claim,2n,true,[],r,state,()=>claim.updatedAt+121),false);
    assert.equal(r.unresolved,1);const saved=(await state.listFiltered(path,"target",null))[0]!;
    assert.equal(saved.state,"Starting");assert.match(saved.lastError,/empty history does not authorize retry/);
    assert.equal(saved.attemptCount,claim.attemptCount);
  });
});
test("live attempt lease precedes candidate adoption and expires at exactly 120 seconds",async()=>{
  const job=queueJob({state:"Starting",updatedAt:100});let calls=0;
  const fake={...state,markRunningIfClaimed:async()=>{calls++;return job;}};
  const r=report();assert.equal(await recoverStartingAttempt("unused",job,1n,false,[turn("candidate")],r,fake,()=>219.999),false);
  assert.equal(calls,0);assert.equal(await recoverStartingAttempt("unused",job,1n,false,[turn("candidate")],r,fake,()=>220),true);
  assert.equal(calls,1);assert.equal(r.recoveredRunning,1);
});
test("one unique non-baseline candidate attaches with original claim and no dispatch",async()=>{
  await storeFixture(async path=>{
    await state.enqueue(path,queueJob());const claim=(await state.tryBeginAttempt(path,"saved",["old"],1n))!;
    const r=report();assert.equal(await recoverStartingAttempt(path,claim,1n,true,[turn("old"),turn("new"),turn("new")],r,state,()=>claim.updatedAt+121),true);
    const saved=(await state.listFiltered(path,"target",null))[0]!;assert.equal(saved.state,"Running");assert.equal(saved.turnId,"new");
    assert.equal(saved.attemptCount,claim.attemptCount);
  });
});
test("multiple candidates persist hold; an existing ambiguous hold is not released by later singleton history",async()=>{
  await storeFixture(async path=>{
    await state.enqueue(path,queueJob());const claim=(await state.tryBeginAttempt(path,"saved",[],1n))!;
    const r=report();await recoverStartingAttempt(path,claim,1n,false,[turn("b"),turn("a")],r,state,()=>claim.updatedAt+121);
    const held=(await state.listFiltered(path,"target",null))[0]!;assert.ok(held.lastError.startsWith(STARTING_CANDIDATE_HOLD_PREFIX));
    await recoverStartingAttempt(path,held,1n,false,[turn("a")],r,state,()=>held.updatedAt+121);
    assert.equal((await state.listFiltered(path,"target",null))[0]!.state,"Starting");assert.equal(r.unresolved,2);
  });
});
test("failed attachment CAS does not increment recovered count or invent a retry",async()=>{
  const r=report();const result=await recoverStartingAttempt("unused",queueJob({lastError:"ambiguous"}),1n,false,[turn("one")],r,
    {...state,markRunningIfClaimed:async()=>null});
  assert.equal(result,false);assert.deepEqual(r,report());
});
test("running terminal or missing history remains unresolved until delivery stages",()=>{
  for(const status of ["Completed","Interrupted","Failed"] as const) {
    const r=report();observeRunningAttempt(queueJob({state:"Running",turnId:"turn"}),[turn("turn",status)],r);assert.equal(r.unresolved,1);
  }
  const r=report();observeRunningAttempt(queueJob({state:"Running",turnId:"turn"}),[turn("turn")],r);assert.equal(r.unresolved,0);
  observeRunningAttempt(queueJob({state:"Running",turnId:null}),[],r);assert.equal(r.unresolved,1);
});
