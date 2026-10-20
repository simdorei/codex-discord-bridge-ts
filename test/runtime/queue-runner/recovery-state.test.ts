import assert from "node:assert/strict";
import {test} from "node:test";
import {QueueRecoveryState,recoveryReport} from "../../../src/runtime/queue-runner/recovery-state.ts";
import {queueJob} from "../../helpers/queue-job.ts";
const S=1_000_000_000n;
test("recovery retries use monotonic 30/60/120/240/480/900-second schedule",()=>{
  let now=0n;const state=new QueueRecoveryState(()=>now);
  assert.equal(state.retryDue("a"),true);
  for(const delay of [30,60,120,240,480,900,900]){
    state.onFailure("a","offline");const due=now+BigInt(delay)*S;
    now=due-1n;assert.equal(state.retryDue("a"),false);now=due;assert.equal(state.retryDue("a"),true);
  }
});
test("first changed and periodic errors report; repetitions count without flooding",()=>{
  let now=0n;const state=new QueueRecoveryState(()=>now);
  assert.deepEqual(state.onFailure("a","offline"),{error:"offline",suppressed:0n});
  now=59n*S;assert.equal(state.onFailure("a","offline"),null);
  now=60n*S;assert.deepEqual(state.onFailure("a","offline"),{error:"offline",suppressed:1n});
  now=61n*S;assert.deepEqual(state.onFailure("a","read failed"),{error:"read failed",suppressed:0n});
  now=90n*S;assert.equal(state.retryDue("a"),false);now=91n*S;assert.equal(state.retryDue("a"),true);
});
test("success and inventory pruning affect only the exact target",()=>{
  const state=new QueueRecoveryState(()=>0n);state.onFailure("a","offline");state.onFailure("b","offline");
  state.clearUnavailable("a");assert.equal(state.retryDue("a"),true);assert.equal(state.retryDue("b"),false);
  state.onFailure("a","offline");state.initialize(new Set(["b"]));assert.equal(state.retryDue("a"),true);assert.equal(state.retryDue("b"),false);
});
test("cold inventory initializes once and reconciled targets never become cold again",()=>{
  const state=new QueueRecoveryState();state.initialize(new Set(["a","b"]));state.markReconciled("a");
  state.initialize(new Set(["a","b","c"]));assert.equal(state.isCold("a"),false);assert.equal(state.isCold("b"),true);assert.equal(state.isCold("c"),false);
});
test("read/mutation unavailable reports separate active writer and exclude unrelated/quarantined jobs",()=>{
  const state=new QueueRecoveryState(()=>0n),report=recoveryReport();
  const jobs=[queueJob(),queueJob({jobId:"q",state:"Quarantined"}),queueJob({jobId:"other",targetThreadId:"other"})];
  const failure={kind:"ActiveWriter" as const,message:"writer",ambiguous:false};
  state.markUnavailable(jobs,"target",failure,report,"read");assert.equal(report.unresolved,1);assert.equal(report.activeWriterTargets.size,0);
  state.markUnavailable(jobs,"target",failure,report,"mutation");assert.equal(report.unresolved,2);
  assert.deepEqual([...report.readUnavailableTargets],["target"]);assert.deepEqual([...report.mutationUnavailableTargets],["target"]);
  assert.deepEqual([...report.activeWriterTargets],["target"]);assert.deepEqual([...report.unavailableTargets],["target"]);
});
