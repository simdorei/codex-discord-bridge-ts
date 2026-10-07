import assert from "node:assert/strict";
import {test} from "node:test";
import {join,dirname} from "node:path";
import {storeFixture} from "../../helpers/store-fixture.ts";
import {BridgeState} from "../../../src/runtime/bridge-state.ts";
import {ActionTargetServices} from "../../../src/runtime/action-executor/action-target.ts";
import {QueueStartCoordinator,BackendFailureError,type QueueStartBackend} from "../../../src/runtime/queue-runner/start-coordinator.ts";
import {openInitialized} from "../../../src/store/owned-driver.ts";
import {beginAppServerForkHandoff} from "../../../src/store/fork-begin.ts";
import {completeAppServerForkHandoff} from "../../../src/store/fork-target.ts";
import {StateAccessFacade as state} from "../../../src/store/state-access-facade.ts";
const prompts={preparePrompt:async(p:string)=>p,busyResult:async()=>({text:"busy",waitsForFinal:false,ui:null})};
function backend(overrides:Partial<QueueStartBackend>={}):QueueStartBackend{return {generation:()=>1n,residentInstanceId:()=>"resident",requiresAppServerFork:()=>true,activeTurnId:async()=>null,
  resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async()=>"turn",forkThread:async()=>"new",...overrides};}
test("completed target canonicalization applies settings inheritance without another backend fork",async()=>{
  await storeFixture(async path=>{const bridge=new BridgeState(join(dirname(path),"bridge.json"));bridge.setSelectedThreadId("source");bridge.rememberThreadSettings("source","model",null,null);
    await beginAppServerForkHandoff(path,{handoffId:"h",ambiguousJobId:null,sourceThreadId:"source",expectedGeneration:1n,quarantineReason:"reason"});await completeAppServerForkHandoff(path,"h","new",1n);
    const queue=new QueueStartCoordinator(path,backend({forkThread:async()=>assert.fail("completed chain must not fork again")}));
    const services=new ActionTargetServices(path,bridge,queue,prompts);assert.deepEqual(await services.prepareActionTarget("source","mirror"),{threadId:"new",sourceLabel:"mirror (app-server fork)",mirrorMapping:true});
    assert.equal(bridge.selectedThreadId(),"new");assert.equal(bridge.threadSettings("new").model,"model");assert.equal(bridge.threadSettings("source").model,"model");
  });
});
test("active-writer recovery moves and resumes the same durable job, then presents its actual saved turn",async()=>{
  await storeFixture(async path=>{let starts=0,forks=0;const bridge=new BridgeState(join(dirname(path),"bridge.json"));bridge.setSelectedThreadId("source");
    const queue=new QueueStartCoordinator(path,backend({forkThread:async()=>{forks++;return "new";},startClaimedTurn:async claim=>{starts++;if(starts===1)throw new BackendFailureError({kind:"ActiveWriter",ambiguous:false,message:"thread/resume already has an active writer"});assert.equal(claim.jobId,"job");return "new-turn";}}),{clock:()=>1000});
    const original=await queue.submitIdentified("job","source",1n,2n,3n,"request");assert.equal(original.warning?.kind,"ActiveWriter");
    const services=new ActionTargetServices(path,bridge,queue,prompts);const [target,submission]=await services.recoverActiveWriterSubmission({threadId:"source",sourceLabel:"selected",mirrorMapping:false},original);
    assert.equal(forks,1);assert.equal(starts,2);assert.equal(target.threadId,"new");assert.equal(target.sourceLabel,"selected (app-server fork)");assert.equal(submission.jobId,"job");assert.equal(submission.turnId,"new-turn");
    assert.equal(bridge.selectedThreadId(),"new");assert.equal((await queue.replaySubmissionWithTargetForJob("job"))?.[0],"new");assert.equal((await queue.replaySubmissionForMessage(3n))?.jobId,"job");assert.equal(await queue.replaySubmissionForJob("missing"),null);
  });
});
test("non-fork backend and non-writer warnings do not retarget or access canonical bridge state",async()=>{
  await storeFixture(async path=>{const bridge=new BridgeState(join(dirname(path),"unused.json")),queue=new QueueStartCoordinator(path,backend({requiresAppServerFork:()=>false,forkThread:async()=>assert.fail("unexpected fork")}));
    const services=new ActionTargetServices(path,bridge,queue,prompts,{...state,completedAppServerForkTargetForSource:async()=>assert.fail("unexpected canonical read")});
    assert.equal(await services.canonicalizeCompletedTarget("source"),"source");const target={threadId:"source",sourceLabel:"selected",mirrorMapping:false},submission={jobId:"job",queued:true,turnId:null,warning:{kind:"ActiveWriter" as const,ambiguous:false,message:"writer"}};
    assert.deepEqual(await services.recoverActiveWriterSubmission(target,submission),[target,submission]);
    const forkQueue=new QueueStartCoordinator(path,backend({forkThread:async()=>assert.fail("non-writer warning must not fork")}));
    const forkServices=new ActionTargetServices(path,bridge,forkQueue,prompts),other={...submission,warning:{kind:"Other" as const,ambiguous:false,message:"other"}};
    assert.deepEqual(await forkServices.recoverActiveWriterSubmission(target,other),[target,other]);
  });
});
test("canonical cycles fail explicitly and mirror reads use the central mapping facade",async()=>{
  await storeFixture(async path=>{const bridge=new BridgeState(join(dirname(path),"bridge.json")),queue=new QueueStartCoordinator(path,backend()),services=new ActionTargetServices(path,bridge,queue,prompts,{...state,completedAppServerForkTargetForSource:async(_,id)=>id==="a"?"b":"a"});
    await assert.rejects(()=>services.canonicalizeCompletedTarget("a"),/handoff cycle detected/);
    assert.deepEqual(await services.currentMirrorTarget(0n,"fallback"),["fallback","selected"]);const db=await openInitialized(path);try{db.exec("INSERT INTO mirror_threads VALUES ('mapped','p','title',9,1,0)");}finally{db.close();}
    assert.deepEqual(await services.currentMirrorTarget(1n,"fallback"),["mapped","mirror"]);
  });
});
test("saved replay remains presentation-only, validates IDs and never creates a backend call",async()=>{
  await storeFixture(async path=>{let calls=0;const queue=new QueueStartCoordinator(path,backend({activeTurnId:async()=>{calls++;return null;}}));
    assert.equal(await queue.replaySubmissionForMessage(1n),null);assert.equal(await queue.replaySubmissionWithTargetForJob("none"),null);
    await assert.rejects(()=>queue.replaySubmissionForMessage(-1n),/does not fit/);await assert.rejects(()=>queue.replaySubmissionForJob("\uD800"),TypeError);assert.equal(calls,0);
  });
});
