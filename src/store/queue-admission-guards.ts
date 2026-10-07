import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { I64_MIN, I64_MAX } from "../protocol/ids.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";

function requireText(value: string): void {
  if (typeof value !== "string") throw new TypeError("Expected a well-formed string");
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) {
      throw new TypeError("Expected a well-formed string");
    }
  }
}
function exists(db: DatabaseSync, sql: string, value: SQLInputValue): boolean {
  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  const row = stmt.get(value);
  if (row === undefined || typeof row.held !== "bigint") {
    throw new StoreIntegrityError("Expected integer EXISTS result");
  }
  return row.held !== 0n;
}
const STOP_REFUSAL = "stop custody differs or could not be preserved; no stop acceptance";

/** Borrowed connection: no transaction, schema migration, or ownership change. */
export function requireUnheldOriginIn(db: DatabaseSync, event: bigint | null): void {
  if (event === null) return;
  if (typeof event !== "bigint" || event < I64_MIN || event > I64_MAX) {
    throw new TypeError("Expected a signed i64 event ID or null");
  }
  if (exists(db, `SELECT EXISTS(SELECT 1 FROM discord_ingress_journal WHERE event_id=?
         AND json_type(outcome_json,'$.stop_hold') IS NOT NULL) AS held`, event)) {
    throw new StoreIntegrityError(STOP_REFUSAL);
  }
}

export function requireUnheldKeyIn(db: DatabaseSync, key: string): void {
  requireText(key);
  if (exists(db, `SELECT EXISTS(SELECT 1 FROM discord_ingress_journal WHERE ingress_id=?
         AND json_type(outcome_json,'$.stop_hold') IS NOT NULL) AS held`, key)) {
    throw new StoreIntegrityError(STOP_REFUSAL);
  }
}

/** This is dispatch_held_in only; it does not replace the wider admission guard. */
export function asyncQuestionDispatchHeldIn(db: DatabaseSync, thread: string): boolean {
  requireText(thread);
  return exists(db, `SELECT EXISTS(SELECT 1 FROM cdr_async_questions WHERE thread_id=?
    AND dispatch_mode='start' AND state='dispatching') AS held`, thread);
}