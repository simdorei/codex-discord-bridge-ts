import type { DatabaseSync } from "node:sqlite";
import { StoreIntegrityError } from "./schema-assembly.ts";
import { decodeTextField, textDecoderFor } from "./sqlite-values.ts";
import { openInitialized } from "./owned-driver.ts";
import type { StoredQueueJob } from "./queue-read.ts";

export const EXECUTION_HOLD_PREFIX = "[cdr-rust:execution-held:v1] ";
export const LEGACY_RESERVE_HOLD_PREFIX = "[cdr-rust:auto-reserve-hold:v1] ";

function assertStrictUnicode(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new StoreIntegrityError(
      `Expected string for ${name}, received ${value === null ? "null" : typeof value}`,
    );
  }
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code !== undefined && code >= 0xd800 && code <= 0xdfff) {
      throw new StoreIntegrityError(`Invalid Unicode surrogate in ${name}`);
    }
  }
  return value;
}

export function reasonIn(db: DatabaseSync, id: string): string | null {
  const validId = assertStrictUnicode(id, "id");
  const pragmaRow = db.prepare("PRAGMA encoding").get() as
    | Record<string, unknown>
    | undefined;
  if (!pragmaRow) {
    throw new StoreIntegrityError("Failed to query PRAGMA encoding");
  }
  const encoding = Object.values(pragmaRow)[0];
  const decoder = textDecoderFor(encoding);

  const stmt = db.prepare(
    "SELECT reason, CAST(reason AS BLOB) AS reason_blob FROM cdr_execution_holds WHERE job_id = ?",
  );
  const row = stmt.get(validId) as
    | { reason: unknown; reason_blob: unknown }
    | undefined;
  if (row === undefined) {
    return null;
  }
  return decodeTextField(
    row.reason,
    row.reason_blob,
    "reason",
    false,
    decoder,
  );
}

export function requireUnheldIn(db: DatabaseSync, id: string): void {
  const reason = reasonIn(db, id);
  if (reason !== null) {
    throw new StoreIntegrityError(`${EXECUTION_HOLD_PREFIX}${reason}`);
  }
}

export function holdIn(
  db: DatabaseSync,
  id: string,
  target: string,
  reason: string,
  evidence: string,
): void {
  const validId = assertStrictUnicode(id, "id");
  const validTarget = assertStrictUnicode(target, "target");
  const validReason = assertStrictUnicode(reason, "reason");
  const validEvidence = assertStrictUnicode(evidence, "evidence");

  const stmt = db.prepare(
    "INSERT OR IGNORE INTO cdr_execution_holds (job_id, target_thread_id, reason, evidence_json, created_at) VALUES (?, ?, ?, ?, unixepoch())",
  );
  stmt.run(validId, validTarget, validReason, validEvidence);
}

export function legacyOrCurrentError(error: string): boolean {
  assertStrictUnicode(error, "error");
  return (
    error.startsWith(EXECUTION_HOLD_PREFIX) ||
    error.startsWith(LEGACY_RESERVE_HOLD_PREFIX)
  );
}

/** Only Pending jobs consult a durable execution hold; input records stay unchanged. */
export function eligibleJobsIn(db: DatabaseSync, jobs: readonly StoredQueueJob[]): StoredQueueJob[] {
  return jobs.filter(job => job.state !== "Pending" || reasonIn(db, job.jobId) === null);
}

export async function eligibleJobs(path: string, jobs: readonly StoredQueueJob[]): Promise<StoredQueueJob[]> {
  const db = await openInitialized(path);
  try { return eligibleJobsIn(db, jobs); } finally { db.close(); }
}
