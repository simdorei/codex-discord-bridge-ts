import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../../helpers/store-fixture.ts";
import {queueJob} from "../../helpers/queue-job.ts";
import {StateAccessFacade as state} from "../../../src/store/state-access-facade.ts";
import {QueueStartCoordinator,BackendFailureError,type QueueStartBackend} from "../../../src/runtime/queue-runner/start-coordinator.ts";
import {AdmissionGate,DrainFenceKey} from "../../../src/admission/drain-gate.ts";
function backend(overrides:Partial<QueueStartBackend>={}){
  const calls:string[]=[];
  const value:QueueStartBackend={generation:()=>2n,residentInstanceId:()=>"resident",activeTurnId:async()=>null,
    resumeThread:async()=>{calls.push("resume");},readTurns:async()=>{calls.push("read");return [{turnId:"old",status:"Completed"}];},
    startClaimedTurn:async job=>{calls.push("start");assert.deepEqual(job.baselineTurnIds,["old"]);return "new";},...overrides};
  return {value,calls};
}
test("authoritative recovery resumes/reads once, adopts old Pending and starts with recovered baseline",async()=>{
  await storeFixture(async path=>{
    await state.enqueue(path,queueJob());const b=backend(),queue=new QueueStartCoordinator(path,b.value);
    const report=await queue.recoverTarget("target");assert.equal(report.adopted,1);assert.equal(report.started,1);
    assert.deepEqual(b.calls,["resume","read","start"]);
    const job=(await state.listFiltered(path,"target",null))[0]!;assert.equal(job.appServerGeneration,2n);assert.equal(job.turnId,"new");
    assert.equal(queue.locks.activeTargetCount,0);
  });
});
test("cold empty Starting history preserves unknown attempt without resume or replay",async()=>{
  await storeFixture(async path=>{
    await state.enqueue(path,queueJob());const claim=(await state.tryBeginAttempt(path,"saved",[],1n))!;
    const b=backend({readTurns:async()=>[]}),queue=new QueueStartCoordinator(path,b.value,{clock:()=>claim.updatedAt+121});
    const report=await queue.recoverTarget("target");assert.equal(report.unresolved,1);assert.equal(report.started,0);assert.equal(report.adopted,0);
    assert.deepEqual(b.calls,[]);const job=(await state.listFiltered(path,"target",null))[0]!;assert.equal(job.state,"Starting");assert.equal(job.appServerGeneration,1n);
  });
});
test("unavailable authoritative read cannot become mutation authority or clear the original attempt",async()=>{
  await storeFixture(async path=>{
    await state.enqueue(path,queueJob());await state.tryBeginAttempt(path,"saved",[],1n);
    const b=backend({readTurns:async()=>{throw new BackendFailureError({kind:"Other",ambiguous:false,message:"read unavailable"});}});
    const queue=new QueueStartCoordinator(path,b.value),report=await queue.recoverTarget("target");
    assert.deepEqual([...report.readUnavailableTargets],["target"]);assert.equal(report.mutationUnavailableTargets.size,0);assert.equal(report.started,0);
    assert.deepEqual(b.calls,[]);assert.equal((await state.listFiltered(path,"target",null))[0]!.state,"Starting");
  });
});
test("resume active-writer failure is reported separately and never adopts Pending",async()=>{
  await storeFixture(async path=>{
    await state.enqueue(path,queueJob());const b=backend({resumeThread:async()=>{throw new BackendFailureError({kind:"ActiveWriter",ambiguous:false,message:"busy writer"});}});
    const queue=new QueueStartCoordinator(path,b.value),report=await queue.recoverTarget("target");
    assert.deepEqual([...report.mutationUnavailableTargets],["target"]);assert.deepEqual([...report.activeWriterTargets],["target"]);
    assert.equal(report.readUnavailableTargets.size,0);assert.equal(report.adopted,0);assert.equal((await state.listFiltered(path,"target",null))[0]!.appServerGeneration,1n);
  });
});
test("untyped backend history is refused before adoption rather than guessed as completed",async()=>{
  await storeFixture(async path=>{
    await state.enqueue(path,queueJob());const b=backend({readTurns:async()=>[{turnId:"old"}]});
    const report=await new QueueStartCoordinator(path,b.value).recoverTarget("target");
    assert.equal(report.readUnavailableTargets.has("target"),true);assert.equal(report.adopted,0);assert.equal(report.started,0);
  });
});
test("concurrent recovery and kick share one target owner and dispatch at most once",async()=>{
  await storeFixture(async path=>{
    await state.enqueue(path,queueJob());const b=backend(),queue=new QueueStartCoordinator(path,b.value);
    await Promise.all([queue.recoverTarget("target"),queue.kickTarget("target")]);
    assert.equal(b.calls.filter(x=>x==="start").length,1);assert.equal((await state.listFiltered(path,"target",null)).length,1);
  });
});
const snapshot={turnIds:()=>["original"],obligationCount:()=>1};
test("held async history without a control gate saves candidate only, never settles or resumes",async()=>{
  let retained=0,terminal=0;
  const b=backend({readAsyncHistory:async()=>({history:true}),readAsyncTerminal:async()=>{terminal++;return {};}});
  const queue=new QueueStartCoordinator("unused",b.value,{state:{...state,retireCopyOnlyHandoffs:async()=>0n,
    asyncTargetDispatchHeld:async()=>true,captureAsyncHistorySnapshot:async()=>snapshot,
    retainAsyncHistoryCandidate:async()=>{retained++;return 1;},captureTerminalHistorySnapshot:async()=>{terminal++;return {turnIds:()=>["owner"]};},
  }});
  const report=await queue.recoverTarget("target");assert.equal(report.unresolved,1);assert.equal(retained,1);assert.equal(terminal,0);assert.deepEqual(b.calls,[]);
});
test("resident replacement during history read rejects before candidate commit",async()=>{
  let resident="before",retained=0;
  const b=backend({residentInstanceId:()=>resident,readAsyncHistory:async()=>{resident="after";return {};}});
  const queue=new QueueStartCoordinator("unused",b.value,{state:{...state,retireCopyOnlyHandoffs:async()=>0n,asyncTargetDispatchHeld:async()=>true,
    captureAsyncHistorySnapshot:async()=>snapshot,retainAsyncHistoryCandidate:async()=>{retained++;return 1;}}});
  const report=await queue.recoverTarget("target");assert.equal(retained,0);assert.equal(report.readUnavailableTargets.has("target"),true);
});
test("control-gated history passes exact original/owner turn sets and releases permit",async()=>{
  const gate=new AdmissionGate();let held=true;const calls:string[]=[];
  const b=backend({readAsyncHistory:async(_target,ids)=>{assert.deepEqual(ids,["original"]);calls.push("history");return {};},
    readAsyncTerminal:async(_target,ids)=>{assert.deepEqual(ids,["owner"]);calls.push("terminal");return {};}});
  const queue=new QueueStartCoordinator("unused",b.value,{admission:gate,state:{...state,retireCopyOnlyHandoffs:async()=>0n,
    asyncTargetDispatchHeld:async()=>held,deadTargetHeld:async()=>false,listFiltered:async()=>[],eligibleJobs:async(_p,j)=>[...j],
    captureAsyncHistorySnapshot:async()=>snapshot,retainAsyncHistoryCandidate:async()=>{calls.push("retain");return 1;},
    captureTerminalHistorySnapshot:async()=>({turnIds:()=>["owner"]}),settleTerminalHistory:async()=>{held=false;calls.push("settle");return 1;}}});
  const report=await queue.recoverTarget("target");assert.equal(report.unresolved,0);assert.deepEqual(calls,["history","retain","terminal","settle"]);
  const key=DrainFenceKey.create("runtime","1|2","nonce");gate.seal(key);assert.equal(gate.isDrainedFor(key),true);
});
test("historical read timeout aborts the read signal, preserves hold and releases control permit",{timeout:20000},async()=>{
  const gate=new AdmissionGate();let signal:AbortSignal|undefined;
  const b=backend({readAsyncHistory:async(_target,_ids,s)=>{signal=s;return new Promise(()=>{});}});
  const queue=new QueueStartCoordinator("unused",b.value,{admission:gate,state:{...state,retireCopyOnlyHandoffs:async()=>0n,
    asyncTargetDispatchHeld:async()=>true,captureAsyncHistorySnapshot:async()=>snapshot,
    retainAsyncHistoryCandidate:async()=>{throw new Error("late candidate must not commit");}}});
  const report=await queue.recoverTarget("target");assert.equal(signal?.aborted,true);
  assert.equal(report.unresolved,1);assert.equal(report.readUnavailableTargets.has("target"),true);
  const key=DrainFenceKey.create("runtime","1|2","nonce");gate.seal(key);assert.equal(gate.isDrainedFor(key),true);
});
