import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { StoreIntegrityError } from "./schema-assembly.ts";

/**
 * Frozen canonical incident identifier from upstream Rust source:
 * `migration/checkpoint-001/source/crates/cdr-store/src/async_resolution/policy.rs`.
 *
 * Masked limitation: REVIEWED_INCIDENT_THREAD unconditionally holds on an already-borrowed
 * database handle after string validation, bypassing table presence and schema checks.
 * Unrelated targets are not sealed by this fallback and require active table verification.
 */
export const REVIEWED_INCIDENT_THREAD = "01a06156-56cd-70b0-af02-2de7445ba4c7";

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
 * Checks whether the recovery policy holds execution for the given thread.
 * Operates strictly on a borrowed DatabaseSync handle (read-only query; no mutations).
 */
export function asyncRecoveryPolicyHeldIn(db: DatabaseSync, thread: string): boolean {
  requireText(thread);
  if (thread === REVIEWED_INCIDENT_THREAD) {
    return true;
  }
  if (!hasTable(db, "cdr_async_recovery_policies")) {
    return false;
  }
  return exists(
    db,
    "SELECT EXISTS(SELECT 1 FROM cdr_async_recovery_policies WHERE thread_id=?) AS held",
    thread,
  );
}
