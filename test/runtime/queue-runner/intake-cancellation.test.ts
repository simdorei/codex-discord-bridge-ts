import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../../helpers/store-fixture.ts";
import {QueueStartCoordinator} from "../../../src/runtime/queue-runner/start-coordinator.ts";
import {TargetLocks} from "../../../src/runtime/queue-runner/target-locks.ts";
import {admitPromptIntake} from "../../../src/store/prompt-intake-write.ts";
import {tryClaimPromptIntake,getPromptIntake} from "../../../src/store/prompt-intake.ts";
import {StateAccessFacade as state} from "../../../src/store/state-access-facade.ts";
test("an intake cancelled while waiting for the target lock must not promote or dispatch after unlock",async()=>{
  await storeFixture(async path=>{
    await admitPromptIntake(path,{jobId:"job",targetThreadId:"target",channelId:1n,ownerUserId:2n,discordMessageId:null,rawPrompt:"raw",autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:0});
    const claim=await tryClaimPromptIntake(path,"job",10,100);assert.ok(claim);const locks=new TargetLocks(),lease=await locks.acquire("target"),abort=new AbortController(),reason=new Error("lost ownership");let starts=0;
    const queue=new QueueStartCoordinator(path,{generation:()=>1n,residentInstanceId:()=>"resident",activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async()=>{starts++;return "turn";}},{locks,clock:()=>20});
    // Reflect.apply exercises the optional signal even against the preceding API that ignored it.
    const pending=Reflect.apply(queue.submitPromptIntake,queue,[claim,"target","prepared",abort.signal]);
    const rejected=assert.rejects(pending,e=>e===reason);await new Promise<void>(r=>setImmediate(r));abort.abort(reason);lease.release();await rejected;
    assert.equal(starts,0);assert.ok(await getPromptIntake(path,"job"));assert.deepEqual(await state.listFiltered(path,"target",null),[]);assert.equal(locks.activeTargetCount,0);
  });
});
