import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { StoreIntegrityError } from "./schema-assembly.ts";

function requireText(value: string): void {
  if (typeof value !== "string") {
    throw new TypeError("Expected a well-formed string");
  }
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

function hasTable(db: DatabaseSync, name: string): boolean {
  return exists(
    db,
    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?) AS held",
    name,
  );
}

/**
 * Checks legacy dispatching steer compatibility on a borrowed DatabaseSync handle.
 *
 * Evaluates whether an unrecorded steer-mode question in 'dispatching' state exists
 * for the thread. If the obligations table is present, questions recorded in obligations
 * are excluded. If cdr_async_questions table is absent or a view, returns false.
 */
export function asyncLegacySteerHeldIn(db: DatabaseSync, thread: string): boolean {
  requireText(thread);
  if (!hasTable(db, "cdr_async_questions")) {
    return false;
  }
  const recorded = hasTable(db, "cdr_async_execution_obligations")
    ? " AND NOT EXISTS(SELECT 1 FROM cdr_async_execution_obligations o WHERE o.question_id=q.id)"
    : "";
  return exists(
    db,
    `SELECT EXISTS(SELECT 1 FROM cdr_async_questions q WHERE q.thread_id=? AND q.state='dispatching' AND q.dispatch_mode='steer'${recorded}) AS held`,
    thread,
  );
}
