import { randomUUID } from "node:crypto";
import { asyncResolutionHeldIn } from "./async-resolution-admission.ts";
import type { StoredQueueJob } from "./queue-read.ts";
import type { DatabaseSync } from "node:sqlite";
import { StoreIntegrityError } from "./schema-assembly.ts";
import {selectIdleIntentIn as selectIntent} from "./idle-release-row.ts";
import { decodeI64 } from "./sqlite-values.ts";

/** The caller owns the connection and transaction, exactly as before_enqueue. */
export function beforeEnqueue(db: DatabaseSync, thread: string): void {
  if (typeof thread !== "string") throw new TypeError("Expected a well-formed thread ID");
  for (const c of thread) {
    const p=c.codePointAt(0)!;
    if (p>=0xd800 && p<=0xdfff) throw new TypeError("Expected a well-formed thread ID");
  }
  const old = selectIntent(db, thread);
  if (old === null) return;
  if (old.state === "Settled" || old.state === "AwaitUnload") return;
  if (old.state !== "Candidate") {
    throw new StoreIntegrityError(
      `idle release ${old.state} requires review for thread ${thread}; new prompt was not enqueued: ${old.detail}`);
  }
  const result = db.prepare(`UPDATE cdr_idle_release SET state=?,detail=?,revision=revision+1
    WHERE intent_id=? AND owner_id=? AND generation=? AND thread_id=? AND turn_id=?
    AND job_id=? AND revision=? AND state=?`).run(
      "Settled","CancelledBeforeSend",old.intentId,old.ownerId,old.generation,
      old.threadId,old.turnId,old.jobId,old.revision,old.state);
  if (BigInt(result.changes) !== 1n) {
    throw new StoreIntegrityError("idle release compare-and-set lost");
  }
}

export function botIdleIn(db: DatabaseSync, thread: string): boolean {
  if (asyncResolutionHeldIn(db, thread)) return false;
  const stmt=db.prepare(`SELECT
    NOT EXISTS(SELECT 1 FROM codex_turn_queue WHERE target_thread_id=?1)
    AND NOT EXISTS(SELECT 1 FROM cdr_async_questions WHERE thread_id=?1
      AND state NOT IN ('submitted','rejected','closed_unknown')
      AND NOT (state='expired' AND chosen IS NULL AND dispatch_mode IS NULL
        AND reply_job_id IS NULL AND accepted_turn_id IS NULL AND preparation_json IS NULL))
    AND NOT EXISTS(SELECT 1 FROM cdr_async_question_inbox WHERE thread_id=?1 AND state!='expired')
    AND NOT EXISTS(SELECT 1 FROM codex_dead_generation_holds WHERE target_thread_id=?1)
    AND NOT EXISTS(SELECT 1 FROM codex_archive_fences WHERE target_thread_id=?1)
    AND NOT EXISTS(SELECT 1 FROM cdr_cleanup_fences WHERE target_thread_id=?1) AS idle`);
  stmt.setReadBigInts(true); return decodeI64(stmt.get(thread)?.idle,"idle")!==0n;
}
/** Only stages an unsent candidate. Never sends unsubscribe or resumes a thread. */
export function stageIdleReleaseCandidateIn(db: DatabaseSync, job: StoredQueueJob, owner: string): void {
  if(!db.isTransaction) throw new StoreIntegrityError("Borrowed mutation requires an active transaction");
  if(!botIdleIn(db,job.targetThreadId)) return;
  const old=selectIntent(db,job.targetThreadId);
  if(old!==null&&old.state!=="Settled") return;
  const count=db.prepare("SELECT COUNT(*) AS n FROM cdr_idle_release WHERE state!='Settled'");
  count.setReadBigInts(true);
  if(decodeI64(count.get()?.n,"idle release count")>=128n) return;
  db.exec("DELETE FROM cdr_idle_release WHERE state='Settled' AND thread_id NOT IN (SELECT thread_id FROM cdr_idle_release WHERE state='Settled' ORDER BY rowid DESC LIMIT 32)");
  db.prepare(`INSERT OR REPLACE INTO cdr_idle_release(intent_id,owner_id,generation,thread_id,turn_id,job_id,revision,state)
    VALUES(?,?,?,?,?,?,1,'Candidate')`).run(randomUUID(),owner,job.appServerGeneration,job.targetThreadId,job.turnId,job.jobId);
}
