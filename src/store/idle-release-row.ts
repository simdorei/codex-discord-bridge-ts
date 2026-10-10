import type {DatabaseSync} from "node:sqlite";
import {decodeTextField,textDecoderFor,decodeI64} from "./sqlite-values.ts";
export interface IdleIntent {
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
export const IDLE_COLUMNS = `intent_id,owner_id,generation,thread_id,turn_id,job_id,revision,state,detail,
  CAST(intent_id AS BLOB) AS b_intent_id,
  CAST(owner_id AS BLOB) AS b_owner_id,
  CAST(thread_id AS BLOB) AS b_thread_id,
  CAST(turn_id AS BLOB) AS b_turn_id,
  CAST(job_id AS BLOB) AS b_job_id,
  CAST(state AS BLOB) AS b_state,
  CAST(detail AS BLOB) AS b_detail,
  (SELECT encoding FROM pragma_encoding) AS encoding
`;

export function selectIdleIntentIn(db: DatabaseSync, thread: string): IdleIntent | null {
  const stmt = db.prepare(`SELECT ${IDLE_COLUMNS} FROM cdr_idle_release WHERE thread_id=?`);
  stmt.setReadBigInts(true);
  const row = stmt.get(thread);
  if (row === undefined) return null;
  return decodeIdleIntentRow(row);
}
export function decodeIdleIntentRow(row:Record<string,unknown>):IdleIntent {
  const decoder = textDecoderFor(row.encoding);
  const text = (name: string): string => decodeTextField(row[name],row["b_"+name],name,false,decoder)!;
  const old: IdleIntent = {
    intentId:text("intent_id"), ownerId:text("owner_id"),
    generation:decodeI64(row.generation,"generation"),
    threadId:text("thread_id"), turnId:text("turn_id"), jobId:text("job_id"),
    revision:decodeI64(row.revision,"revision"),
    state:text("state"), detail:text("detail"),
  };
  return old;
}
