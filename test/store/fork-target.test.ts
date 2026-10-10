import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {enqueue} from "../../src/store/queue-enqueue.ts";
import {listFiltered} from "../../src/store/queue-read.ts";
import {beginAppServerForkHandoff} from "../../src/store/fork-begin.ts";
import {stageAppServerForkTarget,finalizeAppServerForkHandoff,completeAppServerForkHandoff,cancelAppServerForkHandoffAfterDefiniteFailure} from "../../src/store/fork-target.ts";
import {forkHandoffByIdIn} from "../../src/store/fork-handoff-by-id.ts";
import {admitPromptIntake} from "../../src/store/prompt-intake-write.ts";
import {getPromptIntake,tryClaimPromptIntake} from "../../src/store/prompt-intake.ts";
async function sql(path:string,s:string):Promise<void>{const db=await openInitialized(path);try{db.exec(s);}finally{db.close();}}
async function handoff(path:string){const db=await openInitialized(path);try{return forkHandoffByIdIn(db,"h");}finally{db.close();}}
async function begin(path:string,ambiguous:string|null=null){return beginAppServerForkHandoff(path,{handoffId:"h",ambiguousJobId:ambiguous,sourceThreadId:"source",expectedGeneration:1n,quarantineReason:"reason"});}
test("staging retains exact observed response, including a colliding target, without authorizing finalization",async()=>{
  await storeFixture(async path=>{await enqueue(path,queueJob({targetThreadId:"occupied"}));await begin(path);
    assert.equal((await stageAppServerForkTarget(path,"h","occupied")).observedTargetThreadId,"occupied");
    await assert.rejects(()=>finalizeAppServerForkHandoff(path,"h",2n),/already in use/);assert.equal((await handoff(path))?.observedTargetThreadId,"occupied");assert.equal((await handoff(path))?.targetThreadId,null);
    await assert.rejects(()=>stageAppServerForkTarget(path,"h","different"),/already in use/);assert.equal((await stageAppServerForkTarget(path,"h","occupied")).observedTargetThreadId,"occupied");
  });
});
test("finalization atomically quarantines ambiguous start, retargets pending/intake and swaps exact mirror",async()=>{
  await storeFixture(async path=>{
    await enqueue(path,queueJob({jobId:"ambiguous",targetThreadId:"source"}));await enqueue(path,queueJob({jobId:"pending",targetThreadId:"source"}));
    await admitPromptIntake(path,{jobId:"intake",targetThreadId:"source",channelId:1n,ownerUserId:2n,discordMessageId:null,rawPrompt:"raw",autoQueueWhenBusy:true,requireCurrentMirror:true,createdAt:1});
    const claim=await tryClaimPromptIntake(path,"intake",10,100);assert.ok(claim);
    await sql(path,`UPDATE codex_turn_queue SET state='starting',last_error='old failure' WHERE job_id='ambiguous';
      INSERT INTO mirror_threads VALUES ('source','p','title',1,2,0); INSERT INTO session_mirror_details VALUES ('source','all');
      UPDATE codex_prompt_intakes SET last_error='[cdr-rust:app-server-fork-unresolved:v1] held';
      INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at)
      VALUES ('fork-unresolved:pending','pending','source','notice',1,'old',0,0),('fork-unresolved-intake:intake','intake','source','notice',1,'old',0,0);`);
    await begin(path,"ambiguous");const result=await completeAppServerForkHandoff(path,"h","new",2n);
    assert.equal(result.applied,true);assert.equal(result.quarantinedJob?.state,"Quarantined");assert.equal(result.quarantinedJob?.targetThreadId,"source");
    assert.equal(result.retargetedJobs[0]?.jobId,"pending");assert.equal(result.retargetedJobs[0]?.targetThreadId,"new");assert.equal(result.retargetedJobs[0]?.appServerGeneration,2n);
    const intake=await getPromptIntake(path,"intake");assert.equal(intake?.targetThreadId,"new");assert.equal(intake?.claimToken,claim.claimToken);assert.equal(intake?.claimExpiresAt,100);assert.equal(intake?.lastError,"");
    const db=await openInitialized(path);try{assert.equal(db.prepare("SELECT codex_thread_id FROM mirror_threads").get()?.codex_thread_id,"new");assert.equal(db.prepare("SELECT codex_thread_id FROM session_mirror_details").get()?.codex_thread_id,"new");
      const delivery=db.prepare("SELECT delivery_id,content FROM codex_delivery_outbox").all();assert.equal(delivery.length,1);assert.equal(delivery[0]?.delivery_id,"quarantine:ambiguous");assert.match(String(delivery[0]?.content),/Previous error: old failure/);
    }finally{db.close();}
    const again=await finalizeAppServerForkHandoff(path,"h",9n);assert.equal(again.applied,false);assert.equal(again.handoff.completedGeneration,2n);assert.deepEqual(again.retargetedJobs,[]);
  });
});
test("no observed response and self-target cannot be finalized",async()=>{
  await storeFixture(async path=>{await begin(path);await assert.rejects(()=>finalizeAppServerForkHandoff(path,"h",2n),/not been durably observed/);await stageAppServerForkTarget(path,"h","source");await assert.rejects(()=>finalizeAppServerForkHandoff(path,"h",2n),/invalid app-server fork/);});
});
test("mapping change after observation retains response and leaves original queued ownership intact",async()=>{
  await storeFixture(async path=>{await enqueue(path,queueJob({targetThreadId:"source"}));await sql(path,"INSERT INTO mirror_threads VALUES ('source','p','t',1,2,0)");await begin(path);await stageAppServerForkTarget(path,"h","new");
    await sql(path,"UPDATE mirror_threads SET discord_thread_id=3");await assert.rejects(()=>finalizeAppServerForkHandoff(path,"h",2n),/missing, stale, or duplicated/);assert.equal((await listFiltered(path,"source",null)).length,1);assert.equal((await handoff(path))?.observedTargetThreadId,"new");
  });
});
test("final CAS failure rolls back quarantine, pending move and notices but does not erase prior observation",async()=>{
  await storeFixture(async path=>{await enqueue(path,queueJob({jobId:"ambiguous",targetThreadId:"source"}));await enqueue(path,queueJob({jobId:"pending",targetThreadId:"source"}));
    await sql(path,"UPDATE codex_turn_queue SET state='starting',last_error='known' WHERE job_id='ambiguous'");await begin(path,"ambiguous");await stageAppServerForkTarget(path,"h","new");
    await sql(path,"CREATE TRIGGER refuse_completion BEFORE UPDATE OF target_thread_id ON codex_thread_fork_handoffs BEGIN SELECT RAISE(IGNORE); END");
    await assert.rejects(()=>finalizeAppServerForkHandoff(path,"h",2n),/different fork handoff/);
    const jobs=await listFiltered(path,"source",null);assert.equal(jobs.length,2);assert.equal(jobs.find(j=>j.jobId==="ambiguous")?.state,"Starting");
    assert.equal((await handoff(path))?.targetThreadId,null);assert.equal((await handoff(path))?.observedTargetThreadId,"new");const db=await openInitialized(path);try{assert.equal(db.prepare("SELECT count(*) AS n FROM codex_delivery_outbox").get()?.n,0);}finally{db.close();}
  });
});
test("cancellation rejects sticky ambiguity and any observed target, then deletes only unobserved definite fence",async()=>{
  await storeFixture(async path=>{assert.equal(await cancelAppServerForkHandoffAfterDefiniteFailure(path,"missing"),false);await begin(path);await sql(path,"UPDATE codex_thread_fork_handoffs SET fork_failure_ambiguous=1");
    await assert.rejects(()=>cancelAppServerForkHandoffAfterDefiniteFailure(path,"h"),/ambiguous fork handoff cannot be cancelled/);
    await sql(path,"UPDATE codex_thread_fork_handoffs SET fork_failure_ambiguous=0");await stageAppServerForkTarget(path,"h","new");await assert.rejects(()=>cancelAppServerForkHandoffAfterDefiniteFailure(path,"h"),/already observed/);
  });
  await storeFixture(async path=>{await begin(path);assert.equal(await cancelAppServerForkHandoffAfterDefiniteFailure(path,"h"),true);assert.equal(await handoff(path),null);});
});

test("expected routing recheck prevents finalization under locks for a stale observed target",async()=>{
  await storeFixture(async path=>{await begin(path);await stageAppServerForkTarget(path,"h","new");
    await assert.rejects(()=>finalizeAppServerForkHandoff(path,"h",2n,{sourceThreadId:"source",targetThreadId:"wrong"}),/different fork handoff/);assert.equal((await handoff(path))?.targetThreadId,null);
    assert.equal((await finalizeAppServerForkHandoff(path,"h",2n,{sourceThreadId:"source",targetThreadId:"new"})).applied,true);
  });
});
