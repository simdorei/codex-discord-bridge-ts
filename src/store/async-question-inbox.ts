import { StoreIntegrityError } from "./schema-assembly.ts";
import type { DatabaseSync } from "node:sqlite";

const PROMOTE = `INSERT OR IGNORE INTO cdr_async_questions
  (id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,owner_confirmed,created_at,updated_at)
  SELECT i.id,i.runtime_id,i.generation,i.thread_id,i.turn_id,i.item_id,i.candidate_job_id,i.candidate_channel_id,i.candidate_owner_id,i.body,1,i.created_at,i.created_at
  FROM cdr_async_question_inbox i WHERE i.candidate_job_id=?1 AND i.state='waiting'
  AND EXISTS(SELECT 1 FROM codex_turn_queue q WHERE q.job_id=i.candidate_job_id AND q.target_thread_id=i.thread_id
    AND q.turn_id=i.turn_id AND q.state='running' AND q.goal_waiting=0
    AND q.channel_id=i.candidate_channel_id AND q.owner_user_id=i.candidate_owner_id
    AND (q.turn_observation_generation=i.generation OR (q.turn_observation_generation IS NULL AND q.app_server_generation=i.generation))
    AND ((i.candidate_generation IS NULL AND i.candidate_attempt_count IS NULL AND q.app_server_generation=i.generation)
      OR (q.app_server_generation=i.candidate_generation AND q.execution_generation IS i.candidate_execution_generation AND q.attempt_count=i.candidate_attempt_count)))
  AND (SELECT COUNT(*) FROM codex_turn_queue q WHERE q.target_thread_id=i.thread_id AND q.state!='pending')=1`;

const CONSUME = `DELETE FROM cdr_async_question_inbox WHERE candidate_job_id=?1 AND state='waiting'
  AND EXISTS(SELECT 1 FROM cdr_async_questions q WHERE q.id=cdr_async_question_inbox.id
    AND q.runtime_id=cdr_async_question_inbox.runtime_id AND q.generation=cdr_async_question_inbox.generation
    AND q.origin_job_id=cdr_async_question_inbox.candidate_job_id AND q.channel_id=cdr_async_question_inbox.candidate_channel_id
    AND q.owner_user_id=cdr_async_question_inbox.candidate_owner_id AND q.body=cdr_async_question_inbox.body AND q.owner_confirmed=1)`;

/** Borrowed completion transaction: preserve exact question ownership before deleting its job. */
export function reconcileAsyncQuestionJobIn(db: DatabaseSync, jobId: string): void {
  if (typeof jobId !== "string" || /[\uD800-\uDFFF]/u.test(jobId)) throw new TypeError("Expected a well-formed job ID");
  if (!db.isTransaction) throw new StoreIntegrityError("Borrowed mutation requires an active transaction");
  db.prepare(PROMOTE).run(jobId);
  db.prepare(CONSUME).run(jobId);
}
