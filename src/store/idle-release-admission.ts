import type { DatabaseSync } from "node:sqlite";
import { StoreIntegrityError } from "./schema-assembly.ts";
import { decodeTextField, textDecoderFor, decodeI64 } from "./sqlite-values.ts";

interface IdleIntent {
  intentId: string;
  ownerId: string;
  generation: bigint;
  threadId: string;
  turnId: string;
  jobId: string;
  revision: bigint;
  state: string;
  detail: string;
}
const SELECT_INTENT = `SELECT intent_id,owner_id,generation,thread_id,turn_id,job_id,revision,state,detail,
  CAST(intent_id AS BLOB) AS b_intent_id,
  CAST(owner_id AS BLOB) AS b_owner_id,
  CAST(thread_id AS BLOB) AS b_thread_id,
  CAST(turn_id AS BLOB) AS b_turn_id,
  CAST(job_id AS BLOB) AS b_job_id,
  CAST(state AS BLOB) AS b_state,
  CAST(detail AS BLOB) AS b_detail,
  (SELECT encoding FROM pragma_encoding) AS encoding
  FROM cdr_idle_release WHERE thread_id=?`;

/** The caller owns the connection and transaction, exactly as before_enqueue. */
export function beforeEnqueue(db: DatabaseSync, thread: string): void {
  if (typeof thread !== "string") throw new TypeError("Expected a well-formed thread ID");
  for (const c of thread) {
    const p=c.codePointAt(0)!;
    if (p>=0xd800 && p<=0xdfff) throw new TypeError("Expected a well-formed thread ID");
  }
  const stmt = db.prepare(SELECT_INTENT);
  stmt.setReadBigInts(true);
  const row = stmt.get(thread);
  if (row === undefined) return;
  const decoder = textDecoderFor(row.encoding);
  const text = (name: string): string => decodeTextField(row[name],row["b_"+name],name,false,decoder)!;
  const old: IdleIntent = {
    intentId:text("intent_id"), ownerId:text("owner_id"),
    generation:decodeI64(row.generation,"generation"),
    threadId:text("thread_id"), turnId:text("turn_id"), jobId:text("job_id"),
    revision:decodeI64(row.revision,"revision"),
    state:text("state"), detail:text("detail"),
  };
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