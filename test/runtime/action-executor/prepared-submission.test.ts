import assert from "node:assert/strict";
import {test} from "node:test";
import {PreparedPromptExecutor,type PreparedTargetServices,type PreparedPromptSubmission,type ActionTarget} from "../../../src/runtime/action-executor/prepared-submission.ts";
import {MirrorMappingChangedError} from "../../../src/store/queue-enqueue.ts";
import {ForkHandoffTargetMovedError} from "../../../src/store/fork-handoff-admission.ts";
import type {StoredPromptIntake} from "../../../src/store/prompt-intake.ts";
type Queue=ConstructorParameters<typeof PreparedPromptExecutor>[1];
const request=():PreparedPromptSubmission=>({channelId:1n,userId:2n,discordMessageId:3n,autoQueueWhenBusy:true,intakeClaim:null,rawPrompt:"original"});
const target=(mapped=false):ActionTarget=>({threadId:"old",sourceLabel:mapped?"mirror":"selected",mirrorMapping:mapped});
const result=()=>({jobId:"job",queued:false,turnId:"turn"});
function fixture(){
  const calls:string[]=[];
  const queue:Queue={reads:{busyStatus:async id=>{calls.push(`busy:${id}`);return {busy:false,allowSteer:false};}},submit:async id=>{calls.push(`submit:${id}`);return result();},
    submitMirrorIdentified:async(_,id)=>{calls.push(`mirror:${id}`);return result();},submitPromptIntake:async()=>{calls.push("intake");return result();}};
  const services:PreparedTargetServices={requiresAppServerFork:()=>true,preparePrompt:async(raw,id)=>{calls.push(`prepare:${id}`);return raw+" enriched";},
    busyResult:async()=>{calls.push("choice");return {text:"busy",waitsForFinal:false,ui:{kind:"Busy",choiceId:"choice",allowSteer:false}};},
    canonicalizeCompletedTarget:async id=>{calls.push("canonical");return id;},currentMirrorTarget:async()=>{calls.push("mapping");return ["new","mirror"];},
    prepareActionTarget:async(id,source)=>{calls.push(`target:${id}`);return {threadId:id,sourceLabel:source,mirrorMapping:source==="mirror"};},
    recoverActiveWriterSubmission:async(t,s)=>{calls.push("recover");return [t,s];}};
  return {queue,services,calls};
}
test("prepared submission checks busy first and only then preprocesses, submits and presents original input",async()=>{
  const f=fixture(),executor=new PreparedPromptExecutor("unused",f.queue,f.services);
  assert.equal((await executor.submit(target(),request())).text,"In progress\nmessage: original");assert.deepEqual(f.calls,["busy:old","prepare:old","submit:old","recover"]);
  f.calls.length=0;f.queue.reads.busyStatus=async()=>({busy:true,allowSteer:true});
  const blocked=await executor.submit(target(),{...request(),autoQueueWhenBusy:false});assert.equal(blocked.ui?.kind,"Busy");assert.deepEqual(f.calls,["choice"]);
});
test("one mirror retarget is allowed only for a fork backend and the second failure is final",async()=>{
  for(const fork of [false,true]){const f=fixture();f.services.requiresAppServerFork=()=>fork;let submits=0;
    f.queue.submitMirrorIdentified=async()=>{submits++;throw new MirrorMappingChangedError(1n,"old","new");};
    await assert.rejects(()=>new PreparedPromptExecutor("unused",f.queue,f.services).submit(target(true),request()),fork?/changed again/:/preserved without retargeting/);
    assert.equal(submits,fork?2:1);assert.equal(f.calls.includes("mapping"),fork);
  }
});
test("retarget retries preparation for the new target once, while a disappeared mirror is never selected implicitly",async()=>{
  const f=fixture();let submits=0;f.queue.submitMirrorIdentified=async(_,id)=>{submits++;if(submits===1)throw new MirrorMappingChangedError(1n,"old","new");assert.equal(id,"new");return result();};
  await new PreparedPromptExecutor("unused",f.queue,f.services).submit(target(true),request());assert.deepEqual(f.calls,["busy:old","prepare:old","canonical","mapping","target:new","busy:new","prepare:new","recover"]);
  const g=fixture();g.services.currentMirrorTarget=async()=>["old","selected"];g.queue.submitMirrorIdentified=async()=>{throw new MirrorMappingChangedError(1n,"old",null);};
  await assert.rejects(()=>new PreparedPromptExecutor("unused",g.queue,g.services).submit(target(true),request()),/mapping disappeared/);
});
test("completed-source move preserves the original mirror mode despite a changed source label",async()=>{
  const f=fixture();let attempts=0;f.queue.submitMirrorIdentified=async()=>{attempts++;if(attempts===1)throw new ForkHandoffTargetMovedError("old","new");return result();};
  f.services.prepareActionTarget=async()=>({threadId:"new",sourceLabel:"canonical",mirrorMapping:false});
  await new PreparedPromptExecutor("unused",f.queue,f.services).submit(target(true),request());assert.equal(attempts,2);assert.equal(f.calls.some(c=>c.startsWith("submit:")),false);
});
test("preprocessing or post-submit recovery errors cannot trigger another submission",async()=>{
  const f=fixture(),error=new MirrorMappingChangedError(1n,"old","new");f.services.preparePrompt=async()=>{throw error;};
  await assert.rejects(()=>new PreparedPromptExecutor("unused",f.queue,f.services).submit(target(true),request()),e=>e===error);assert.deepEqual(f.calls,["busy:old"]);
  const g=fixture();g.services.recoverActiveWriterSubmission=async()=>{throw error;};
  await assert.rejects(()=>new PreparedPromptExecutor("unused",g.queue,g.services).submit(target(true),request()),e=>e===error);assert.deepEqual(g.calls,["busy:old","prepare:old","mirror:old"]);
});
test("intake submission refreshes canonical row but retains the exact original lease token",async()=>{
  const intake:StoredPromptIntake={jobId:"j",targetThreadId:"old",channelId:1n,ownerUserId:2n,discordMessageId:3n,rawPrompt:"raw",autoQueueWhenBusy:true,
    requireCurrentMirror:false,attemptCount:0n,lastError:"",retryAfter:0,claimToken:"token",claimExpiresAt:100,createdAt:1,updatedAt:2};
  const f=fixture();f.queue.submitPromptIntake=async(claim,t,p)=>{assert.equal(claim.claimToken,"token");assert.equal(claim.intake.targetThreadId,"canonical");assert.equal(t,"old");assert.equal(p,"original enriched");return result();};
  const claim={intake,claimToken:"token"},executor=new PreparedPromptExecutor("unused",f.queue,f.services,{canonicalizePromptIntakeTarget:async()=>({...intake,targetThreadId:"canonical"})});
  const pending=executor.submit(target(),{...request(),intakeClaim:claim});claim.claimToken="changed";await pending;
  const missing=new PreparedPromptExecutor("unused",f.queue,f.services,{canonicalizePromptIntakeTarget:async()=>null});
  await assert.rejects(()=>missing.submit(target(),{...request(),intakeClaim:{intake,claimToken:"token"}}),/claim is no longer current/);
});

test("prepared executor connects real intake and queue ownership before the injected backend starts",async()=>{
  const {storeFixture}=await import("../../helpers/store-fixture.ts");
  const {admitPromptIntake}=await import("../../../src/store/prompt-intake-write.ts");
  const {tryClaimPromptIntake,getPromptIntake}=await import("../../../src/store/prompt-intake.ts");
  const {QueueStartCoordinator}=await import("../../../src/runtime/queue-runner/start-coordinator.ts");
  await storeFixture(async path=>{
    await admitPromptIntake(path,{jobId:"j",targetThreadId:"old",channelId:1n,ownerUserId:2n,discordMessageId:3n,rawPrompt:"original",autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:1});
    const claim=await tryClaimPromptIntake(path,"j",10,100);assert.ok(claim);let starts=0;
    const queue=new QueueStartCoordinator(path,{generation:()=>1n,residentInstanceId:()=>"resident",activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],
      startClaimedTurn:async owned=>{starts++;assert.equal(owned.prompt,"original enriched");assert.equal(await getPromptIntake(path,"j"),null);return "turn";}},{clock:()=>20});
    const f=fixture(),executor=new PreparedPromptExecutor(path,queue,f.services);
    const action=await executor.submit(target(),{...request(),intakeClaim:claim});assert.equal(starts,1);assert.equal(action.text,"In progress\nmessage: original");assert.equal(action.waitsForFinal,true);
  });
});

test("preparation cancellation is forwarded and prevents a new queue submission after late completion",async()=>{
  const f=fixture(),abort=new AbortController(),reason=new Error("lease lost");let release!:(value:string)=>void;
  const waiting=new Promise<string>(r=>{release=r;});f.services.preparePrompt=async(_raw,_target,signal)=>{assert.equal(signal,abort.signal);return waiting;};
  const pending=new PreparedPromptExecutor("unused",f.queue,f.services).submit(target(),request(),abort.signal);
  await new Promise<void>(r=>setImmediate(r));abort.abort(reason);release("late prompt");await assert.rejects(pending,e=>e===reason);assert.deepEqual(f.calls,["busy:old"]);
});
test("cancellation after queue result suppresses additional active-writer recovery rather than starting a new fork",async()=>{
  const f=fixture(),abort=new AbortController(),reason=new Error("cancelled");f.queue.submit=async()=>{abort.abort(reason);return result();};
  await assert.rejects(()=>new PreparedPromptExecutor("unused",f.queue,f.services).submit(target(),request(),abort.signal),e=>e===reason);
  assert.deepEqual(f.calls,["busy:old","prepare:old"]);
});
