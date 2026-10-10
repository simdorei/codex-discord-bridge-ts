import {legacyStopSupersededIn} from './async-resolution-legacy-stop.ts';
import type { DatabaseSync } from "node:sqlite";
import { StoreIntegrityError } from "./schema-assembly.ts";
import { textDecoderFor } from "./sqlite-values.ts";
import { parseSerdeValue } from "../core/serde-json-parse.ts";
import { asyncRecoveryPolicyHeldIn } from "./async-resolution-policy.ts";
import { asyncLegacySteerHeldIn } from "./async-resolution-legacy-steer.ts";
import { asyncLifecycleOrdinary } from "./async-resolution-ordinary.ts";
import { asyncLifecycleDeclaredControl } from "./async-resolution-declared-control.ts";
import { cleanupRefusalFromOutcome } from "./async-resolution-cleanup-refusal.ts";
import { openInitialized } from "./owned-driver.ts";
import { asyncQuestionDispatchHeldIn } from "./queue-admission-guards.ts";

const EVIDENCE_BYTES = 131072;
const TARGET_RECORDS = 128;

function requireThread(thread: string): void {
  if (typeof thread !== "string" || /[\uD800-\uDFFF]/u.test(thread)) {
    throw new TypeError("Expected a well-formed string");
  }
}

function exists(db: DatabaseSync, sql: string, value: string): boolean {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  const row = statement.get(value);
  if (row === undefined || typeof row.held !== "bigint") {
    throw new StoreIntegrityError("Expected integer EXISTS result");
  }
  return row.held !== 0n;
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return exists(db,
    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?) AS held", table);
}

/** Borrowed handle; caller has already checked the obligations table. */
export function asyncUnsettledObligationHeldIn(db: DatabaseSync, thread: string): boolean {
  requireThread(thread);
  return exists(db,
    "SELECT EXISTS(SELECT 1 FROM cdr_async_unsettled_obligations WHERE thread_id=?) AS held", thread);
}

// Project type and bytes, never TEXT: node:sqlite eagerly converts row columns.
// This keeps invalid TEXT/outcome decoding behind Rust's row-count/control gates.
const LIFECYCLE_SQL = `
  SELECT typeof(CASE WHEN length(CAST(payload_json AS BLOB))<=?2 THEN payload_json END) AS payload_type,
    CAST(CASE WHEN length(CAST(payload_json AS BLOB))<=?2 THEN payload_json END AS BLOB) AS payload_bytes,
    typeof(CASE WHEN length(CAST(outcome_json AS BLOB))<=?2 THEN outcome_json END) AS outcome_type,
    CAST(CASE WHEN length(CAST(outcome_json AS BLOB))<=?2 THEN outcome_json END AS BLOB) AS outcome_bytes,
    typeof(ingress_id) AS ingress_type, CAST(ingress_id AS BLOB) AS ingress_bytes
  FROM discord_ingress_journal
  WHERE target_thread_id=?1 AND owner_id IS NULL AND state!='completed'
    AND NOT(phase IN ('result_recorded','stop_accepted') AND outcome_json IS NOT NULL)
  ORDER BY created_at,ingress_id LIMIT 129`;

/** Read-only admission check, without opening/closing or managing a transaction. */
export function asyncLifecycleAdmissionHeldIn(db: DatabaseSync, thread: string): boolean {
  requireThread(thread);
  if (!exists(db,
    "SELECT EXISTS(SELECT 1 FROM cdr_async_execution_obligations WHERE thread_id=?) AS held", thread)
    || !hasTable(db, "discord_ingress_journal")) return false;

  let decoder: ReturnType<typeof textDecoderFor> | undefined;
  function decode(kind: unknown, bytes: unknown, column: string): string | null {
    if (kind === "null" && bytes === null) return null;
    if (kind !== "text" || !(bytes instanceof Uint8Array)) {
      throw new StoreIntegrityError(`Expected SQLite TEXT or NULL for ${column}`);
    }
    decoder ??= textDecoderFor(db.prepare("PRAGMA encoding").get()?.encoding);
    try {
      return decoder.decode(bytes);
    } catch {
      // Native prepare/step errors propagate; conversion errors use the existing
      // TS store taxonomy, not a claim of identical rusqlite exception classes.
      throw new StoreIntegrityError(`Invalid SQLite text encoding for ${column}`);
    }
  }

  const statement = db.prepare(LIFECYCLE_SQL);
  statement.setReadBigInts(true);
  let count = 0;
  for (const row of statement.iterate(thread, EVIDENCE_BYTES)) {
    if (++count > TARGET_RECORDS) return true;
    const encoded = decode(row.payload_type, row.payload_bytes, "payload_json");
    if (encoded === null) return true;
    let payload: unknown;
    try { payload = parseSerdeValue(encoded); } catch { return true; }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return true;
    if (!asyncLifecycleDeclaredControl(payload) && asyncLifecycleOrdinary(payload)) continue;

    const ingress = decode(row.ingress_type, row.ingress_bytes, "ingress_id");
    if (ingress === null) throw new StoreIntegrityError("Expected SQLite TEXT for ingress_id");
    if (legacyStopSupersededIn(db, thread, ingress, payload)) continue;

    const outcomeText = decode(row.outcome_type, row.outcome_bytes, "outcome_json");
    let outcome: unknown;
    if (outcomeText !== null) {
      try { outcome = parseSerdeValue(outcomeText); } catch { outcome = undefined; }
    }
    if (cleanupRefusalFromOutcome(outcome) === undefined) return true;
  }
  return false;
}

/** Parent order is part of the contract: policy, unsettled, lifecycle, legacy. */
export function asyncResolutionHeldIn(db: DatabaseSync, thread: string): boolean {
  if (asyncRecoveryPolicyHeldIn(db, thread)) return true;
  if (hasTable(db, "cdr_async_execution_obligations")) {
    if (asyncUnsettledObligationHeldIn(db, thread)) return true;
    if (asyncLifecycleAdmissionHeldIn(db, thread)) return true;
  }
  return asyncLegacySteerHeldIn(db, thread);
}

export class AsyncResolutionHeldError extends Error {
  readonly kind = "AsyncResolutionHeld";
  readonly threadId: string;
  readonly reason: string;
  constructor(threadId: string, reason: string) {
    super(`[cdr-rust:async-resolution-held:v1] ${threadId}: ${reason}`);
    this.name = "AsyncResolutionHeldError"; this.threadId = threadId; this.reason = reason;
  }
}

export function assertAsyncAdmissionIn(db: DatabaseSync, thread: string): void {
  if (asyncResolutionHeldIn(db, thread)) throw new AsyncResolutionHeldError(thread,
    "original async execution, lifecycle request or recovery authorization is unresolved; no automatic retry");
}

async function withInitialized<T>(path: string, read: (db: DatabaseSync) => T): Promise<T> {
  const db = await openInitialized(path);
  try { return read(db); } finally { db.close(); }
}

export async function asyncResolutionAdmissionHeld(path: string, thread: string): Promise<boolean> {
  requireThread(thread);
  return withInitialized(path, db => asyncResolutionHeldIn(db, thread));
}

/** Rust opens a second initialized handle only after admission returns false. */
export async function asyncQuestionTargetDispatchHeld(path: string, thread: string): Promise<boolean> {
  if (await asyncResolutionAdmissionHeld(path, thread)) return true;
  return withInitialized(path, db => asyncQuestionDispatchHeldIn(db, thread));
}
