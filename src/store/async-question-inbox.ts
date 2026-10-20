import { StoreIntegrityError } from "./schema-assembly.ts";
import type { DatabaseSync } from "node:sqlite";

const PROMOTE = `INSERT OR IGNORE INTO cdr_async_questions
  (id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,owner_confirmed,created_at,updated_at)
  SELECT i.id,i.runtime_id,i.generation,i.thread_id,i.turn_id,i.item_id,i.candidate_job_id,i.candidate_channel_id,i.candidate_owner_id,i.body,1,i.created_at,i.created_at
  FROM cdr_async_question_inbox i WHERE (?1 IS NULL OR i.runtime_id=?1) AND (?2 IS NULL OR i.generation=?2)
  AND (?3 IS NULL OR i.candidate_job_id=?3) AND i.state='waiting'
  AND EXISTS(SELECT 1 FROM codex_turn_queue q WHERE q.job_id=i.candidate_job_id AND q.target_thread_id=i.thread_id
    AND q.turn_id=i.turn_id AND q.state='running' AND q.goal_waiting=0
    AND q.channel_id=i.candidate_channel_id AND q.owner_user_id=i.candidate_owner_id
    AND (q.turn_observation_generation=i.generation OR (q.turn_observation_generation IS NULL AND q.app_server_generation=i.generation))
    AND ((i.candidate_generation IS NULL AND i.candidate_attempt_count IS NULL AND q.app_server_generation=i.generation)
      OR (q.app_server_generation=i.candidate_generation AND q.execution_generation IS i.candidate_execution_generation AND q.attempt_count=i.candidate_attempt_count)))
  AND (SELECT COUNT(*) FROM codex_turn_queue q WHERE q.target_thread_id=i.thread_id AND q.state!='pending')=1`;

const CONSUME = `DELETE FROM cdr_async_question_inbox WHERE (?1 IS NULL OR runtime_id=?1) AND (?2 IS NULL OR generation=?2)
  AND (?3 IS NULL OR candidate_job_id=?3) AND state='waiting'
  AND EXISTS(SELECT 1 FROM cdr_async_questions q WHERE q.id=cdr_async_question_inbox.id
    AND q.runtime_id=cdr_async_question_inbox.runtime_id AND q.generation=cdr_async_question_inbox.generation
    AND q.origin_job_id=cdr_async_question_inbox.candidate_job_id AND q.channel_id=cdr_async_question_inbox.candidate_channel_id
    AND q.owner_user_id=cdr_async_question_inbox.candidate_owner_id AND q.body=cdr_async_question_inbox.body AND q.owner_confirmed=1)`;

/** Borrowed completion transaction: preserve exact question ownership before deleting its job. */
export function reconcileAsyncQuestionJobIn(db: DatabaseSync, jobId: string): void {
  if (typeof jobId !== "string" || /[\uD800-\uDFFF]/u.test(jobId)) throw new TypeError("Expected a well-formed job ID");
  if (!db.isTransaction) throw new StoreIntegrityError("Borrowed mutation requires an active transaction");
  reconcileAsyncQuestionsIn(db,null,null,jobId);
}

/** Shared exact reconciliation SQL for live observation and completion ownership. */
export function reconcileAsyncQuestionsIn(db:DatabaseSync,runtime:string|null,generation:bigint|null,job:string|null):bigint{
  if(!db.isTransaction)throw new StoreIntegrityError("Borrowed mutation requires an active transaction");
  for(const value of [runtime,job])if(value!==null&&(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value)))throw new TypeError("Expected well-formed question scope");
  if(generation!==null&&(typeof generation!=="bigint"||generation<-(1n<<63n)||generation>=(1n<<63n)))throw new TypeError("Expected i64 question generation");
  const inserted=BigInt(db.prepare(PROMOTE).run(runtime,generation,job).changes);
  db.prepare(CONSUME).run(runtime,generation,job);return inserted;
}
