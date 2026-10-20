import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { storeFixture } from "../helpers/store-fixture.ts";
import { queueJob } from "../helpers/queue-job.ts";
import { StateAccessFacade as state } from "../../src/store/state-access-facade.ts";
import { openInitialized } from "../../src/store/owned-driver.ts";
import { selectJob } from "../../src/store/queue-read.ts";
import { readAsyncObligationsIn, type AsyncObligation } from "../../src/store/async-resolution-records.ts";
import { asyncExecutionOwnerIn, exactAsyncOwnerIn, executionOwnerJobValue } from "../../src/store/async-resolution-ownership.ts";
import { serializeSerdeValue, sha256SerdeValue } from "../../src/core/serde-json.ts";

async function fixture(run: (db: DatabaseSync, row: AsyncObligation, path: string) => void | Promise<void>): Promise<void> {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob({ownerUserId:2n}));
    const claim=(await state.tryBeginAttempt(path,"saved",[],1n))!;
    await state.markRunningIfClaimed(path,claim,"turn");
    const db=await openInitialized(path);
    try {
      const seal=serializeSerdeValue({identity:{job:executionOwnerJobValue(selectJob(db,"saved"))}});
      db.exec("INSERT INTO mirror_threads VALUES ('target','project','title',1,10,0)");
      db.prepare(`INSERT INTO cdr_async_questions
        (id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,owner_confirmed,created_at,updated_at,preparation_json,state,dispatch_mode)
        VALUES ('question','resident',1,'target','turn','item','saved',1,2,'body',1,0,0,?,'dispatching','steer')`).run(seal);
      db.exec(`INSERT INTO cdr_async_execution_obligations
        (question_id,thread_id,origin_job_id,turn_id,channel_id,format_version,revision,answer_state,execution_state,admission_state,policy,original_seal,claim_json,owner_json,original_error,created_at,updated_at)
        SELECT q.id,q.thread_id,q.origin_job_id,q.turn_id,q.channel_id,1,7,'unresolved','unresolved','held','ordinary',q.preparation_json,
        json_object('id',q.id,'runtime_id',q.runtime_id,'generation',q.generation,'thread_id',q.thread_id,'turn_id',q.turn_id,'item_id',q.item_id,
          'origin_job_id',q.origin_job_id,'channel_id',q.channel_id,'owner_user_id',q.owner_user_id,'body',q.body,'chosen',q.chosen,'message_id',q.message_id,'dispatch_mode',q.dispatch_mode),
        NULL,'original',0,0 FROM cdr_async_questions q`);
      await run(db,readAsyncObligationsIn(db,"target")[0]!,path);
    } finally { db.close(); }
  });
}

import {existsSync} from "node:fs";
import {recordAsyncTerminalNotificationExisting,asyncJournalObservationAllowedIn} from "../../src/store/async-resolution-terminal.ts";
const payload=(status="completed")=>JSON.stringify({threadId:"target",turn:{id:"turn",status}});
test("existing terminal preserves accepted proof when later raw journal transaction fails",async()=>fixture(async(db,_row,path)=>{
 db.exec("CREATE TRIGGER deny_raw BEFORE INSERT ON codex_observed_completions BEGIN SELECT RAISE(ABORT,'raw failed'); END");
 assert.throws(()=>state.recordObservedCompletionForResidentExisting(path,"target","turn",1n,payload(),"resident"),/raw failed/);
 assert.equal(typeof db.prepare("SELECT terminal_proof_json FROM cdr_async_execution_obligations").get()?.terminal_proof_json,"string");
 assert.equal(db.prepare("SELECT count(*) AS n FROM codex_observed_completions").get()?.n,0);
 db.exec("DROP TRIGGER deny_raw");
 assert.equal(state.recordObservedCompletionForResidentExisting(path,"target","turn",1n,payload(),"resident"),true);
 assert.equal(state.recordObservedCompletionForResidentExisting(path,"target","turn",1n,payload(),"resident"),false);
 assert.equal(db.prepare("SELECT resident_owner FROM codex_observed_completions").get()?.resident_owner,"resident");
}));
test("existing terminal commits conflict evidence before throwing and retains accepted original",async()=>fixture(async(db,_row,path)=>{
 recordAsyncTerminalNotificationExisting(path,"target","turn",1n,"resident",payload());
 const prior=db.prepare("SELECT terminal_proof_json FROM cdr_async_execution_obligations").get()?.terminal_proof_json;
 assert.throws(()=>recordAsyncTerminalNotificationExisting(path,"target","turn",1n,"resident",payload("failed")),/conflicting accepted terminal/);
 assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_async_terminal_candidates WHERE kind='conflict'").get()?.n,1);
 assert.equal(db.prepare("SELECT terminal_proof_json FROM cdr_async_execution_obligations").get()?.terminal_proof_json,prior);
 assert.equal(asyncJournalObservationAllowedIn(db,"target","turn",1n,"resident",payload()),false);
}));
test("existing terminal foreign resident remains diagnostic and never claims raw journal",async()=>fixture(async(db,_row,path)=>{
 assert.equal(state.recordObservedCompletionForResidentExisting(path,"target","turn",1n,payload(),"foreign"),false);
 assert.equal(db.prepare("SELECT count(*) AS n FROM codex_observed_completions").get()?.n,0);
 assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_async_terminal_candidates WHERE kind='unverified'").get()?.n,1);
}));
test("existing final preserves first running-job value and rejects foreign turn or generation",async()=>fixture(async(db,_row,path)=>{
 assert.equal(state.recordObservedFinalAnswerExisting(path,"target","other",1n,"bad"),false);
 assert.equal(state.recordObservedFinalAnswerExisting(path,"target","turn",2n,"bad"),false);
 assert.equal(state.recordObservedFinalAnswerExisting(path,"target","turn",1n,"original"),true);
 assert.equal(state.recordObservedFinalAnswerExisting(path,"target","turn",1n,"replace"),false);
 assert.equal(db.prepare("SELECT content FROM codex_observed_final_answers").get()?.content,"original");
}));
test("existing producers never create missing DB and validate malformed values before opening",async()=>storeFixture(async path=>{
 assert.throws(()=>state.recordObservedFinalAnswerExisting(path,"target","turn",1n,"x"));assert.equal(existsSync(path),false);
 assert.throws(()=>state.recordObservedCompletionForResidentExisting(path,"target","turn",1n,payload(),"resident"));assert.equal(existsSync(path),false);
 assert.throws(()=>recordAsyncTerminalNotificationExisting(path,"target","turn",1n<<63n,"resident",payload()),/i64/);assert.equal(existsSync(path),false);
}));
