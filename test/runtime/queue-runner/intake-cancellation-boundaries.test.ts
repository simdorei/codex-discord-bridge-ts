import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../../helpers/store-fixture.ts";
import {QueueStartCoordinator,BackendFailureError,type QueueStartBackend} from "../../../src/runtime/queue-runner/start-coordinator.ts";
import {TargetLocks} from "../../../src/runtime/queue-runner/target-locks.ts";
import {AdmissionGate,DrainFenceKey} from "../../../src/admission/drain-gate.ts";
import {admitPromptIntake} from "../../../src/store/prompt-intake-write.ts";
import {tryClaimPromptIntake} from "../../../src/store/prompt-intake.ts";
import {StateAccessFacade as state} from "../../../src/store/state-access-facade.ts";
const flush=()=>new Promise<void>(r=>setImmediate(r));
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
async function seed(path:string){await admitPromptIntake(path,{jobId:"job",targetThreadId:"target",channelId:1n,ownerUserId:2n,discordMessageId:null,rawPrompt:"raw",autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:0});const claim=await tryClaimPromptIntake(path,"job",10,100);assert.ok(claim);return claim;}
const backend=(patch:Partial<QueueStartBackend>={}):QueueStartBackend=>({generation:()=>1n,residentInstanceId:()=>"resident",activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async()=>"turn",...patch});
test("cancelled queue waiter releases only its wait, never the foreign target lease",async()=>{
  await storeFixture(async path=>{const claim=await seed(path),locks=new TargetLocks(),foreign=await locks.acquire("target"),abort=new AbortController(),reason=new Error("cancel");
    const queue=new QueueStartCoordinator(path,backend(),{locks,clock:()=>20}),pending=queue.submitPromptIntake(claim,"target","prepared",abort.signal),rejected=assert.rejects(pending,e=>e===reason);
    await flush();abort.abort(reason);await rejected;assert.equal(locks.activeTargetCount,1);assert.equal(locks.tryAcquire("target"),undefined);foreign.release();assert.equal(locks.activeTargetCount,0);
  });
});
test("cancelled busy-status waiter does not poll the backend or release another request's mutex",async()=>{
  await storeFixture(async path=>{const locks=new TargetLocks(),foreign=await locks.acquire("target"),abort=new AbortController(),reason=new Error("cancel");let reads=0;
    const queue=new QueueStartCoordinator(path,backend({activeTurnId:async()=>{reads++;return null;}}),{locks}),pending=queue.reads.busyStatus("target",abort.signal),rejected=assert.rejects(pending,e=>e===reason);
    await flush();abort.abort(reason);await rejected;assert.equal(reads,0);assert.equal(locks.activeTargetCount,1);foreign.release();
  });
});
test("late resume completion after cancellation cannot read baseline or dispatch a new turn",async()=>{
  await storeFixture(async path=>{const claim=await seed(path),abort=new AbortController(),reason=new Error("cancel"),entered=deferred<void>(),resume=deferred<void>();let reads=0,starts=0,finished=false;
    const queue=new QueueStartCoordinator(path,backend({resumeThread:async(_,signal)=>{assert.equal(signal,abort.signal);entered.resolve();await resume.promise;},readTurns:async()=>{reads++;return [];},startClaimedTurn:async()=>{starts++;return "turn";}}),{clock:()=>20});
    const pending=queue.submitPromptIntake(claim,"target","prepared",abort.signal).finally(()=>{finished=true;}),rejected=assert.rejects(pending,e=>e===reason);await entered.promise;abort.abort(reason);await flush();assert.equal(finished,false);
    resume.resolve();await rejected;assert.equal(reads,0);assert.equal(starts,0);const job=(await state.listFiltered(path,"target",null))[0]!;assert.equal(job.state,"Pending");assert.equal(job.attemptCount,0n);
  });
});
test("cancellation after durable attempt claim but before dispatch preserves Starting evidence without replay",async()=>{
  await storeFixture(async path=>{const claim=await seed(path),abort=new AbortController(),reason=new Error("cancel");let starts=0;
    const queue=new QueueStartCoordinator(path,backend({startClaimedTurn:async()=>{starts++;return "turn";}}),{clock:()=>20,state:{...state,tryBeginAttempt:async(...args)=>{const result=await state.tryBeginAttempt(...args);abort.abort(reason);return result;}}});
    await assert.rejects(()=>queue.submitPromptIntake(claim,"target","prepared",abort.signal),e=>e===reason);const job=(await state.listFiltered(path,"target",null))[0]!;
    assert.equal(job.state,"Starting");assert.equal(job.attemptCount,1n);assert.equal(job.turnId,null);await queue.kickTarget("target");assert.equal(starts,0);
  });
});
test("cancellation during dispatch retains admission and target ownership until actual ACK is persisted",async()=>{
  await storeFixture(async path=>{const claim=await seed(path),abort=new AbortController(),reason=new Error("cancel"),entered=deferred<void>(),ack=deferred<string>(),gate=new AdmissionGate(),key=DrainFenceKey.create("runtime","1|2","nonce");let finished=false;
    const queue=new QueueStartCoordinator(path,backend({startClaimedTurn:async()=>{entered.resolve();return ack.promise;}}),{clock:()=>20,admission:gate});
    const pending=queue.submitPromptIntake(claim,"target","prepared",abort.signal).finally(()=>{finished=true;}),rejected=assert.rejects(pending,e=>e===reason);await entered.promise;abort.abort(reason);gate.seal(key);await flush();
    assert.equal(finished,false);assert.equal(gate.isDrainedFor(key),false);assert.equal(queue.locks.activeTargetCount,1);
    ack.resolve("actual-turn");await rejected;assert.equal(gate.isDrainedFor(key),true);assert.equal(queue.locks.activeTargetCount,0);const job=(await state.listFiltered(path,"target",null))[0]!;
    assert.equal(job.state,"Running");assert.equal(job.turnId,"actual-turn");assert.equal((await queue.replaySubmissionForJob("job"))?.turnId,"actual-turn");
  });
});
test("an ambiguous backend result after cancellation remains a durable unknown outcome, not a retryable pending job",async()=>{
  await storeFixture(async path=>{const claim=await seed(path),abort=new AbortController(),reason=new Error("cancel"),entered=deferred<void>(),release=deferred<void>();
    const queue=new QueueStartCoordinator(path,backend({startClaimedTurn:async()=>{entered.resolve();await release.promise;throw new BackendFailureError({kind:"Other",ambiguous:true,message:"real timeout"});}}),{clock:()=>20});
    const rejected=assert.rejects(queue.submitPromptIntake(claim,"target","prepared",abort.signal),e=>e===reason);await entered.promise;abort.abort(reason);release.resolve();await rejected;
    const job=(await state.listFiltered(path,"target",null))[0]!;assert.equal(job.state,"Starting");assert.equal(job.lastError,"real timeout");assert.equal(job.turnId,null);
  });
});
