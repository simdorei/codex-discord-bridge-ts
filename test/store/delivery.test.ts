import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { storeFixture } from "../helpers/store-fixture.ts";
import { queueJob } from "../helpers/queue-job.ts";
import { StateAccessFacade as state } from "../../src/store/state-access-facade.ts";
import { openInitialized } from "../../src/store/owned-driver.ts";
import { stageOwnedQueueCompletion } from "../../src/store/delivery.ts";
import { selectJob, type StoredQueueJob } from "../../src/store/queue-read.ts";

async function edit(path:string,run:(db:DatabaseSync)=>void):Promise<void> {
  const db=await openInitialized(path);try{run(db);}finally{db.close();}
}
async function fixture(run:(path:string,job:StoredQueueJob)=>Promise<void>):Promise<void> {
  await storeFixture(async path=>{
    await state.enqueue(path,queueJob({ownerUserId:2n}));
    const claim=(await state.tryBeginAttempt(path,"saved",[],1n))!;
    const job=(await state.markRunningIfClaimed(path,claim,"turn"))!;
    await edit(path,db=>db.exec(`INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload,resident_owner)
      VALUES ('target','turn',1,'{}','resident')`));
    await run(path,job);
  });
}
test("owned completion commits one outbox row, removes job/journal and stages unsent idle intent",async()=>{
  await fixture(async(path,job)=>{
    const delivery=await stageOwnedQueueCompletion(path,job,"final",5,{observer:"resident",generation:1n});
    assert.equal(delivery.content,"final");assert.equal(delivery.channelId,1n);assert.equal(delivery.attemptCount,0n);
    await edit(path,db=>{
      assert.equal(db.prepare("SELECT count(*) AS n FROM codex_turn_queue").get()?.n,0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM codex_observed_completions").get()?.n,0);
      assert.equal(db.prepare("SELECT state FROM cdr_idle_release").get()?.state,"Candidate");
      assert.equal(db.prepare("SELECT event_digest FROM codex_session_mirror_events WHERE event_digest='discord-origin:v1:target:turn'").get()?.event_digest,"discord-origin:v1:target:turn");
    });
    await assert.rejects(()=>stageOwnedQueueCompletion(path,job,"again",6),/queue job not found/);
  });
});
test("stale ownership and duplicate running owners preserve queue, outbox and journal",async()=>{
  for(const duplicate of [false,true]) await fixture(async(path,job)=>{
    if(duplicate) await edit(path,db=>db.exec(`INSERT INTO codex_turn_queue
      (job_id,target_thread_id,channel_id,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at,app_server_generation)
      VALUES ('other','target',1,'prompt',1,1,'running',1,'turn','[]',0,0,1)`));
    await assert.rejects(()=>stageOwnedQueueCompletion(path,duplicate?job:{...job,attemptCount:job.attemptCount+1n},"final",5),/completion ownership changed/);
    await edit(path,db=>{
      assert.equal(selectJob(db,"saved").state,"Running");assert.equal(db.prepare("SELECT count(*) AS n FROM codex_delivery_outbox").get()?.n,0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM codex_observed_completions").get()?.n,1);
    });
  });
});
test("completion snapshots expected job before asynchronous database opening",async()=>{
  await fixture(async(path,job)=>{
    const operation=stageOwnedQueueCompletion(path,job,"final",5);
    job.attemptCount+=1n;job.baselineTurnIds.push("tampered");
    assert.equal((await operation).content,"final");
  });
});
test("existing outbox contents are retained rather than overwritten by completion retry",async()=>{
  await fixture(async(path,job)=>{
    await edit(path,db=>db.exec(`INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at)
      VALUES ('saved','saved','target','turn',1,'original',0,0)`));
    assert.equal((await stageOwnedQueueCompletion(path,job,"replacement",5)).content,"original");
  });
});
test("failure after queue deletion rolls back outbox, journal deletion and queue together",async()=>{
  await fixture(async(path,job)=>{
    await edit(path,db=>db.exec("CREATE TRIGGER test_idle_failure BEFORE INSERT ON cdr_idle_release BEGIN SELECT RAISE(ABORT,'idle stage failure'); END"));
    await assert.rejects(()=>stageOwnedQueueCompletion(path,job,"final",5,{observer:"resident",generation:1n}),/idle stage failure/);
    await edit(path,db=>{
      assert.equal(selectJob(db,"saved").state,"Running");assert.equal(db.prepare("SELECT count(*) AS n FROM codex_delivery_outbox").get()?.n,0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM codex_observed_completions").get()?.n,1);
    });
  });
});
test("inbox ownership is reconciled before queue deletion and prevents false idle release",async()=>{
  await fixture(async(path,job)=>{
    await edit(path,db=>db.prepare(`INSERT INTO cdr_async_question_inbox
      (id,runtime_id,generation,thread_id,turn_id,item_id,candidate_job_id,candidate_channel_id,candidate_owner_id,body,created_at,
       candidate_generation,candidate_execution_generation,candidate_attempt_count)
      VALUES ('question','resident',1,'target','turn','item','saved',1,2,'body',0,?,?,?)`).run(job.appServerGeneration,job.executionGeneration,job.attemptCount));
    await stageOwnedQueueCompletion(path,job,"final",5,{observer:"resident",generation:1n});
    await edit(path,db=>{
      assert.equal(db.prepare("SELECT owner_confirmed FROM cdr_async_questions").get()?.owner_confirmed,1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_async_question_inbox").get()?.n,0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_idle_release").get()?.n,0);
    });
  });
});
test("release generation mismatch skips idle candidate without losing completed delivery",async()=>{
  await fixture(async(path,job)=>{
    await stageOwnedQueueCompletion(path,job,"final",5,{observer:"resident",generation:2n});
    await edit(path,db=>assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_idle_release").get()?.n,0));
  });
});
test("idle capacity defers release without rolling back the completed delivery",async()=>{
  await fixture(async(path,job)=>{
    await edit(path,db=>{
      const insert=db.prepare("INSERT INTO cdr_idle_release VALUES (?,?,1,?,?,?,1,'Candidate','')");
      for(let i=0;i<128;i++) insert.run("intent"+i,"resident","other"+i,"turn","job"+i);
    });
    assert.equal((await stageOwnedQueueCompletion(path,job,"final",5,{observer:"resident",generation:1n})).content,"final");
    await edit(path,db=>assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_idle_release").get()?.n,128));
  });
});
test("existing unresolved idle intent is preserved, while settled history is bounded",async()=>{
  for(const settled of [false,true]) await fixture(async(path,job)=>{
    await edit(path,db=>{
      if(!settled) db.exec("INSERT INTO cdr_idle_release VALUES ('original','old-owner',0,'target','old-turn','old-job',2,'Unknown','preserved')");
      else {
        const insert=db.prepare("INSERT INTO cdr_idle_release VALUES (?,?,1,?,?,?,1,'Settled','')");
        for(let i=0;i<40;i++) insert.run("intent"+i,"resident","other"+i,"turn","job"+i);
      }
    });
    await stageOwnedQueueCompletion(path,job,"final",5,{observer:"resident",generation:1n});
    await edit(path,db=>{
      if(settled) assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_idle_release").get()?.n,33);
      else assert.equal(db.prepare("SELECT intent_id FROM cdr_idle_release WHERE thread_id='target'").get()?.intent_id,"original");
    });
  });
});
test("only pristine expired questions permit idle release",async()=>{
  for(const chosen of [null,"answer"]) await fixture(async(path,job)=>{
    await edit(path,db=>db.prepare(`INSERT INTO cdr_async_questions
      (id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,owner_confirmed,created_at,updated_at,state,chosen)
      VALUES ('q','resident',1,'target','turn','item','saved',1,2,'body',1,0,0,'expired',?)`).run(chosen));
    await stageOwnedQueueCompletion(path,job,"final",5,{observer:"resident",generation:1n});
    await edit(path,db=>assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_idle_release").get()?.n,chosen===null?1:0));
  });
});
