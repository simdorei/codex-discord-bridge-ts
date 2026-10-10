import assert from "node:assert/strict";
import { test } from "node:test";
import { storeFixture } from "../helpers/store-fixture.ts";
import { queueJob } from "../helpers/queue-job.ts";
import { StateAccessFacade as state } from "../../src/store/state-access-facade.ts";
import { openInitialized } from "../../src/store/owned-driver.ts";
import { reconcileAsyncQuestionJobIn } from "../../src/store/async-question-inbox.ts";
import type { DatabaseSync } from "node:sqlite";

async function fixture(run: (db: DatabaseSync) => void): Promise<void> {
  await storeFixture(async path => {
    await state.enqueue(path, queueJob({ownerUserId: 2n}));
    const claim = (await state.tryBeginAttempt(path, "saved", [], 1n))!;
    await state.markRunningIfClaimed(path, claim, "turn");
    const db = await openInitialized(path);
    try {
      db.exec(`INSERT INTO cdr_async_question_inbox
        (id,runtime_id,generation,thread_id,turn_id,item_id,candidate_job_id,candidate_channel_id,candidate_owner_id,
         body,created_at,candidate_generation,candidate_execution_generation,candidate_attempt_count)
        VALUES ('question','runtime',1,'target','turn','item','saved',1,2,'body',0,1,1,1)`);
      db.exec("BEGIN IMMEDIATE"); run(db);
    } finally { if (db.isTransaction) db.exec("ROLLBACK"); db.close(); }
  });
}
function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
}

test("exact running owner promotes observation and consumes it in caller transaction", async () => {
  await fixture(db => {
    reconcileAsyncQuestionJobIn(db, "saved");
    assert.equal(db.isTransaction, true);
    assert.equal(count(db, "cdr_async_questions"), 1); assert.equal(count(db, "cdr_async_question_inbox"), 0);
    const question = db.prepare("SELECT * FROM cdr_async_questions").get()!;
    assert.equal(question.owner_confirmed, 1); assert.equal(question.origin_job_id, "saved");
    assert.equal(question.body, "body");
    db.exec("ROLLBACK");
    assert.equal(count(db, "cdr_async_questions"), 0); assert.equal(count(db, "cdr_async_question_inbox"), 1);
  });
});

test("wrong candidate identity, attempt, generation and waiting state never promote", async () => {
  for (const sql of [
    "UPDATE cdr_async_question_inbox SET candidate_attempt_count=2",
    "UPDATE cdr_async_question_inbox SET candidate_execution_generation=NULL",
    "UPDATE cdr_async_question_inbox SET candidate_generation=2",
    "UPDATE cdr_async_question_inbox SET generation=2",
    "UPDATE cdr_async_question_inbox SET candidate_channel_id=3",
    "UPDATE cdr_async_question_inbox SET candidate_owner_id=3",
    "UPDATE cdr_async_question_inbox SET thread_id='other'",
    "UPDATE cdr_async_question_inbox SET turn_id='other'",
    "UPDATE cdr_async_question_inbox SET state='expired'",
    "UPDATE codex_turn_queue SET goal_waiting=1",
    "UPDATE codex_turn_queue SET state='starting'",
  ]) await fixture(db => {
    db.exec(sql); reconcileAsyncQuestionJobIn(db, "saved");
    assert.equal(count(db, "cdr_async_questions"), 0); assert.equal(count(db, "cdr_async_question_inbox"), 1);
  });
});

test("another non-pending owner blocks promotion even if it is quarantined", async () => {
  await fixture(db => {
    db.exec(`INSERT INTO codex_turn_queue
      (job_id,target_thread_id,channel_id,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at,app_server_generation)
      VALUES ('other','target',1,'prompt',1,1,'quarantined',0,'[]',0,0,1)`);
    reconcileAsyncQuestionJobIn(db, "saved"); assert.equal(count(db, "cdr_async_questions"), 0);
    db.exec("DELETE FROM codex_turn_queue WHERE job_id='other'");
    reconcileAsyncQuestionJobIn(db, "saved"); assert.equal(count(db, "cdr_async_questions"), 1);
  });
});

test("legacy null candidate metadata is accepted only on its original generation", async () => {
  for (const observed of [1, 2]) await fixture(db => {
    db.exec(`UPDATE cdr_async_question_inbox SET candidate_generation=NULL,candidate_attempt_count=NULL,generation=${observed};
      UPDATE codex_turn_queue SET turn_observation_generation=${observed}`);
    reconcileAsyncQuestionJobIn(db, "saved");
    assert.equal(count(db, "cdr_async_questions"), observed === 1 ? 1 : 0);
  });
});

test("an existing different body is not overwritten or used to discard the original observation", async () => {
  await fixture(db => {
    db.exec(`INSERT INTO cdr_async_questions
      (id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,owner_confirmed,created_at,updated_at)
      VALUES ('question','runtime',1,'target','turn','item','saved',1,2,'different',1,0,0)`);
    reconcileAsyncQuestionJobIn(db, "saved");
    assert.equal(count(db, "cdr_async_question_inbox"), 1);
    assert.equal(db.prepare("SELECT body FROM cdr_async_questions").get()?.body, "different");
  });
});

test("a deleted job or unrelated requested job cannot recreate question authority", async () => {
  await fixture(db => {
    reconcileAsyncQuestionJobIn(db, "other"); assert.equal(count(db, "cdr_async_questions"), 0);
    db.exec("DELETE FROM codex_turn_queue"); reconcileAsyncQuestionJobIn(db, "saved");
    assert.equal(count(db, "cdr_async_questions"), 0); assert.equal(count(db, "cdr_async_question_inbox"), 1);
  });
});

test("borrowed mutation rejects calls without a transaction", async () => {
  await fixture(db => {
    db.exec("ROLLBACK");
    assert.throws(() => reconcileAsyncQuestionJobIn(db, "saved"), /Borrowed mutation requires an active transaction/);
    assert.equal(count(db, "cdr_async_questions"), 0);
  });
});
