import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../../helpers/store-fixture.ts";
import {PromptIntakeProcessor,type IntakeRecoveryEvent} from "../../../src/runtime/prompt-intake/processor.ts";
import {QueueStartCoordinator} from "../../../src/runtime/queue-runner/start-coordinator.ts";
import type {PreparedTargetServices} from "../../../src/runtime/action-executor/prepared-submission.ts";
import {StateAccessFacade as state,type IStateAccessFacade} from "../../../src/store/state-access-facade.ts";
import {openInitialized} from "../../../src/store/owned-driver.ts";
import {queueJob} from "../../helpers/queue-job.ts";
const request=()=>({targetThreadId:"thread",source:"selected",channelId:1n,userId:2n,discordMessageId:3n,autoQueueWhenBusy:false,rawPrompt:"raw"});
async function seed(path:string,id="job",raw="raw",target="thread"){
  return (await state.admitPromptIntake(path,{jobId:id,targetThreadId:target,channelId:1n,ownerUserId:2n,discordMessageId:null,rawPrompt:raw,autoQueueWhenBusy:false,requireCurrentMirror:false,createdAt:0})).intake;
}
async function sql(path:string,s:string):Promise<void>{const db=await openInitialized(path);try{db.exec(s);}finally{db.close();}}
function fixture(path:string,adapter:IStateAccessFacade=state){
  const clock={now:100},starts:string[]=[],events:IntakeRecoveryEvent[]=[];
  const backend={generation:()=>1n,residentInstanceId:()=>"resident",activeTurnId:async():Promise<string|null>=>null,resumeThread:async()=>{},readTurns:async()=>[],
    startClaimedTurn:async(claim:Readonly<{jobId:string;prompt:string}>)=>{starts.push(claim.jobId);assert.match(claim.prompt,/enriched$/);return "turn";}};
  const queue=new QueueStartCoordinator(path,backend,{clock:()=>clock.now});
  const services:PreparedTargetServices={requiresAppServerFork:()=>false,preparePrompt:async raw=>raw+" enriched",busyResult:async()=>assert.fail("durable admission must not ask for another busy choice"),
    canonicalizeCompletedTarget:async t=>t,currentMirrorTarget:async(_,t)=>[t,"selected"],prepareActionTarget:async(t,s)=>({threadId:t,sourceLabel:s,mirrorMapping:s==="mirror"}),recoverActiveWriterSubmission:async(t,s)=>[t,s]};
  const processor=new PromptIntakeProcessor(path,queue,services,{state:adapter,clock:()=>clock.now,ticks:()=>({wait:()=>new Promise<void>(()=>{}),close:()=>{}}),onRecoveryEvent:e=>{events.push(e);}});
  return {clock,starts,events,backend,queue,services,processor};
}
test("live admission persists original request before enrichment and returns the owned turn",async()=>{
  await storeFixture(async path=>{const f=fixture(path);f.services.preparePrompt=async raw=>{const stored=await state.listPromptIntakes(path);assert.equal(stored.length,1);assert.equal(stored[0]?.rawPrompt,raw);assert.equal(stored[0]?.autoQueueWhenBusy,false);return raw+" enriched";};
    const result=await f.processor.admitPrompt(request());assert.equal(result.text,"In progress\nmessage: raw");assert.equal(f.starts.length,1);assert.deepEqual(await state.listPromptIntakes(path),[]);
    const jobs=await state.listFiltered(path,"thread",null);assert.equal(jobs[0]?.prompt,"raw enriched");assert.equal(jobs[0]?.state,"Running");
  });
});
test("once admission is durable, a newly busy backend queues without asking for a new UI choice",async()=>{
  await storeFixture(async path=>{const f=fixture(path);f.backend.activeTurnId=async()=>"other-turn";const result=await f.processor.admitPrompt(request());
    assert.match(result.text,/^Queued/);assert.equal(f.starts.length,0);assert.equal((await state.listFiltered(path,"thread",null)).length,1);assert.deepEqual(await state.listPromptIntakes(path),[]);
  });
});
test("preparation failure records owned backoff and recovery starts only at the recorded deadline",async()=>{
  await storeFixture(async path=>{const intake=await seed(path),f=fixture(path);let fail=true;f.services.preparePrompt=async raw=>{if(fail)throw new Error("preparation failed");return raw+" enriched";};
    await assert.rejects(()=>f.processor.processAdmittedPrompt(intake),/saved for automatic recovery and was not started/);
    const saved=await state.getPromptIntake(path,"job");assert.equal(saved?.attemptCount,1n);assert.equal(saved?.retryAfter,130);assert.equal(saved?.claimToken,null);assert.equal(f.starts.length,0);
    fail=false;f.clock.now=129;assert.equal(await f.processor.recoverPromptIntakes(),0);f.clock.now=130;assert.equal(await f.processor.recoverPromptIntakes(),1);assert.equal(f.starts.length,1);assert.equal(await state.getPromptIntake(path,"job"),null);
  });
});
test("a simultaneous repeat observes pending durable preparation and never starts a second processor",async()=>{
  await storeFixture(async path=>{const intake=await seed(path),f=fixture(path);let begin!:()=>void,release!:(value:string)=>void;const started=new Promise<void>(r=>{begin=r;}),wait=new Promise<string>(r=>{release=r;});let prepares=0;
    f.services.preparePrompt=async()=>{prepares++;begin();return wait;};const first=f.processor.processAdmittedPrompt(intake);await started;
    const repeat=await f.processor.processAdmittedPrompt(intake);assert.match(repeat.text,/durable preparation or retry is already pending/);assert.equal(prepares,1);release("raw enriched");await first;assert.equal(f.starts.length,1);
  });
});
test("execution hold prevents claiming and a newly held preparation failure never records retry",async()=>{
  await storeFixture(async path=>{const intake=await seed(path),f=fixture(path);await sql(path,"INSERT INTO cdr_execution_holds VALUES ('job','thread','held','{}',0)");
    const result=await f.processor.processAdmittedPrompt(intake);assert.equal(result.waitsForFinal,false);assert.match(result.text,/manual hold/);assert.equal((await state.getPromptIntake(path,"job"))?.claimToken,null);
  });
  await storeFixture(async path=>{const intake=await seed(path),f=fixture(path);f.services.preparePrompt=async()=>{await sql(path,"INSERT INTO cdr_execution_holds VALUES ('job','thread','held','{}',0)");throw new Error("preparation stopped");};
    await assert.rejects(()=>f.processor.processAdmittedPrompt(intake),/manual hold and will not be retried/);assert.equal((await state.getPromptIntake(path,"job"))?.attemptCount,0n);assert.equal(f.starts.length,0);
  });
});
test("recovery continues other ready requests after a recording failure and returns the first recording error",async()=>{
  await storeFixture(async path=>{await seed(path,"a","a","a");await seed(path,"b","b","b");const error=new Error("recording failed"),f=fixture(path,{...state,recordPromptIntakeFailureIfClaimed:async(p,c,e,n)=>{if(c.intake.jobId==="a")throw error;return state.recordPromptIntakeFailureIfClaimed(p,c,e,n);}});
    f.services.preparePrompt=async raw=>{if(raw==="a")throw new Error("bad preparation");return raw+" enriched";};
    await assert.rejects(()=>f.processor.recoverPromptIntakes(),e=>e===error);assert.deepEqual(f.starts,["b"]);assert.equal(await state.getPromptIntake(path,"b"),null);assert.ok(await state.getPromptIntake(path,"a"));assert.equal(f.events[0]?.kind,"RecordingError");
  });
});
test("cleanup removes already queued intakes without replay, but retains dead-target held intake",async()=>{
  await storeFixture(async path=>{await seed(path);await state.enqueue(path,queueJob({jobId:"job",targetThreadId:"thread"}));const f=fixture(path);assert.equal(await f.processor.recoverPromptIntakes(),0);assert.equal(await state.getPromptIntake(path,"job"),null);assert.deepEqual(f.starts,[]);});
  await storeFixture(async path=>{await seed(path);await state.enqueue(path,queueJob({jobId:"job",targetThreadId:"thread"}));await sql(path,"INSERT INTO codex_dead_generation_holds(target_thread_id,runtime_id,generation,created_at) VALUES ('thread','runtime',1,0)");const f=fixture(path);assert.equal(await f.processor.recoverPromptIntakes(),0);assert.ok(await state.getPromptIntake(path,"job"));assert.deepEqual(f.starts,[]);});
});
test("a successful-looking queue result without atomic intake removal is rejected",async()=>{
  await storeFixture(async path=>{const intake=await seed(path),f=fixture(path);f.queue.submitPromptIntake=async()=>({jobId:"job",queued:false,turnId:"forged"});
    await assert.rejects(()=>f.processor.processAdmittedPrompt(intake),/not atomically promoted/);assert.ok(await state.getPromptIntake(path,"job"));assert.equal(f.starts.length,0);
  });
});
test("mirrored intake cannot silently fall back to a selected target during preparation",async()=>{
  await storeFixture(async path=>{await state.admitPromptIntake(path,{jobId:"job",targetThreadId:"thread",channelId:1n,ownerUserId:2n,discordMessageId:null,rawPrompt:"raw",autoQueueWhenBusy:true,requireCurrentMirror:true,createdAt:0});const f=fixture(path);
    const intake=(await state.getPromptIntake(path,"job"))!;await assert.rejects(()=>f.processor.processAdmittedPrompt(intake),/lost or changed its original mirror mapping/);assert.equal(f.starts.length,0);assert.equal((await state.getPromptIntake(path,"job"))?.attemptCount,1n);
  });
});

test('external shutdown joins real durable intake preparation and preserves the claim without retry or dispatch',async()=>{
  await storeFixture(async path=>{const f=fixture(path),controller=new AbortController(),reason=new Error('shutdown');let begin!:()=>void,release!:(v:string)=>void,signal:AbortSignal|undefined,settled=false;
    const started=new Promise<void>(r=>{begin=r;}),work=new Promise<string>(r=>{release=r;});
    f.services.preparePrompt=async(_raw,_target,s)=>{signal=s;begin();return work;};
    const pending=f.processor.admitPrompt(request(),controller.signal).finally(()=>{settled=true;}),checked=assert.rejects(pending,e=>e===reason);
    await started;controller.abort(reason);await new Promise<void>(r=>setImmediate(r));assert.equal(signal?.reason,reason);assert.equal(settled,false);
    release('late enriched');await checked;assert.deepEqual(f.starts,[]);assert.deepEqual(await state.listFiltered(path,null,null),[]);
    const saved=await state.listPromptIntakes(path);assert.equal(saved.length,1);assert.equal(saved[0]?.rawPrompt,'raw');assert.equal(saved[0]?.attemptCount,0n);assert.notEqual(saved[0]?.claimToken,null);
  });
});
test('pre-aborted intake creates no durable request',async()=>{await storeFixture(async path=>{const f=fixture(path),controller=new AbortController(),reason=new Error('before admission');controller.abort(reason);await assert.rejects(f.processor.admitPrompt(request(),controller.signal),e=>e===reason);assert.deepEqual(await state.listPromptIntakes(path),[]);assert.deepEqual(f.starts,[]);});});
