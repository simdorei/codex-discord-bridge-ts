import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {stageOwnedGoalProgress,pendingGoalProgress,recordGoalProgressError,completeGoalProgress,hasPendingGoalProgressIn} from "../../src/store/goal-progress.ts";
import {attachGoalTurnObservedIfOwned} from "../../src/store/queue-attach-goal.ts";
import {selectJob,type StoredQueueJob} from "../../src/store/queue-read.ts";
async function fixture(run:(path:string,job:StoredQueueJob)=>Promise<void>):Promise<void>{
  await storeFixture(async path=>{await state.enqueue(path,queueJob());const claim=(await state.tryBeginAttempt(path,"saved",[],1n))!;
    const job=(await state.markRunningIfClaimed(path,claim,"turn"))!;await run(path,job);});
}
test("owned progress persists once, marks waiting, keeps original timestamp and supports error/completion",async()=>{
  await fixture(async(path,job)=>{
    const p=await stageOwnedGoalProgress(path,job,"progress");assert.ok(p);
    const waiting=(await state.listFiltered(path,"target",null))[0]!;assert.equal(waiting.goalWaiting,true);assert.equal(waiting.updatedAt,job.updatedAt);
    const again=await stageOwnedGoalProgress(path,waiting,"progress");assert.equal(again?.content,"progress");
    await assert.rejects(()=>stageOwnedGoalProgress(path,waiting,"different"),/payload conflict/);
    await recordGoalProgressError(path,p," "+"😀".repeat(1000));assert.equal((await pendingGoalProgress(path))[0]!.lastError," "+"😀".repeat(999));
    await completeGoalProgress(path,p);assert.deepEqual(await pendingGoalProgress(path),[]);
  });
});
test("empty progress still hands off waiting custody without creating a delivery",async()=>{
  await fixture(async(path,job)=>{assert.equal(await stageOwnedGoalProgress(path,job,""),null);assert.deepEqual(await pendingGoalProgress(path),[]);
    assert.equal((await state.listFiltered(path,"target",null))[0]!.goalWaiting,true);});
});
test("successor rejects stale owner, duplicate cross-generation running owner and previously completed turn",async()=>{
  await fixture(async(path,job)=>{
    await stageOwnedGoalProgress(path,job,"");let waiting=(await state.listFiltered(path,"target",null))[0]!;
    assert.equal(await attachGoalTurnObservedIfOwned(path,{...waiting,attemptCount:waiting.attemptCount+1n},"next",2n),false);
    assert.equal(await attachGoalTurnObservedIfOwned(path,waiting,"turn",2n),false);
    const db=await openInitialized(path);try{
      db.exec("INSERT INTO codex_session_mirror_events VALUES ('discord-origin:v1:target:already','target',0)");
    }finally{db.close();}
    assert.equal(await attachGoalTurnObservedIfOwned(path,waiting,"already",2n),false);
    const extra=await openInitialized(path);try{extra.exec(`INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at,app_server_generation)
      VALUES ('other','target',1,'prompt',1,1,'running',1,'[]',0,0,9)`);}finally{extra.close();}
    await assert.rejects(()=>attachGoalTurnObservedIfOwned(path,waiting,"next",2n),/multiple running jobs/);
  });
});
test("legacy unowned pending progress protects its thread even without a matching job ID",async()=>{
  await storeFixture(async path=>{const db=await openInitialized(path);try{
    db.exec("INSERT INTO codex_goal_progress(thread,turn,channel,content) VALUES ('target','turn',1,'legacy')");
    assert.equal(hasPendingGoalProgressIn(db,"any","target"),true);assert.equal(hasPendingGoalProgressIn(db,"any","other"),false);
  }finally{db.close();}});
});
