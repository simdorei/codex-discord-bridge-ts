import type { DatabaseSync } from "node:sqlite";

import {
  definiteMessage,
  definiteNotice,
  previousNonForkError,
} from "./fork-definite-format.ts";
import { SystemTimeError } from "./queue-attach-goal.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";
import {
  decodeI64,
  decodeTextField,
  textDecoderFor,
  type SqliteTextDecoder,
} from "./sqlite-values.ts";

export class ForkHandoffConflictingIntentError extends Error {
  readonly kind = "ConflictingIntent" as const;
  readonly sourceThreadId: string;

  constructor(sourceThreadId: string) {
    super(
      `a different fork handoff already fences source thread ${sourceThreadId}`,
    );
    this.name = "ForkHandoffConflictingIntentError";
    this.sourceThreadId = sourceThreadId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface StagedQueueJobRow {
  readonly jobId: string;
  readonly channelId: bigint;
  readonly state: string;
  readonly storedError: string;
}

function isScalarUnicode(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code !== undefined && code >= 0xd800 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertScalarUnicode(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(
      `Expected string for ${name}, received ${value === null ? "null" : typeof value}`,
    );
  }
  if (!isScalarUnicode(value)) {
    throw new TypeError(`Invalid Unicode surrogate in ${name}`);
  }
  return value;
}

/**
 * Returns current time as fractional seconds since the Unix epoch.
 *
 * Precision gap note: JavaScript's Date.now() provides millisecond precision
 * (seconds as f64 = ms / 1000), whereas Rust's SystemTime::now() provides
 * nanosecond precision. This sub-millisecond precision gap is explicit and accepted.
 */
function now(): number {
  const ms = Date.now();
  if (!Number.isFinite(ms))
  {
    throw new TypeError("system clock must be finite");
  }
  if (ms < 0) {
    throw new SystemTimeError(
      "system clock is before the Unix epoch: negative timestamp",
    );
  }
  return ms / 1000;
}

function decodeRequiredText(
  nativeVal: unknown,
  rawBlob: unknown,
  fieldName: string,
  decoder: SqliteTextDecoder,
): string {
  const decoded = decodeTextField(nativeVal, rawBlob, fieldName, false, decoder);
  if (decoded === null || !isScalarUnicode(decoded)) {
    throw new StoreIntegrityError(
      `Invalid UTF-8 in ${fieldName}: contains lone surrogate characters`,
    );
  }
  return decoded;
}

/**
 * Translates frozen definite_failure.rs stage_definite_notices.
 *
 * Eagerly queries and decodes all pending and starting queue jobs for the
 * source thread within the caller's active transaction, applies CAS marker
 * updates to each job, and stages delivery outbox notices.
 */
export function stageDefiniteNoticesIn(
  db: DatabaseSync,
  handoffId: string,
  source: string,
  forkError: string,
): bigint {
  if (!db || typeof db !== "object") {
    throw new TypeError("Expected DatabaseSync instance for db");
  }
  assertScalarUnicode(handoffId, "handoffId");
  assertScalarUnicode(source, "source");
  assertScalarUnicode(forkError, "forkError");

  const selectStmt = db.prepare(
    "SELECT " +
      "job_id, " +
      "CAST(job_id AS BLOB) AS raw_job_id, " +
      "channel_id, " +
      "state, " +
      "CAST(state AS BLOB) AS raw_state, " +
      "last_error, " +
      "CAST(last_error AS BLOB) AS raw_last_error " +
    "FROM codex_turn_queue " +
    "WHERE target_thread_id = ? AND state IN ('pending', 'starting') " +
    "ORDER BY created_at, job_id",
  );
  selectStmt.setReadBigInts(true);
  const rows = selectStmt.all(source) as Array<Record<string, unknown>>;

  const encRow = db.prepare("PRAGMA encoding;").get() as Record<string, unknown> | undefined;
  const enc = encRow ? Object.values(encRow)[0] : undefined;
  const decoder = textDecoderFor(enc);

  const jobs: StagedQueueJobRow[] = [];
  for (const rawRow of rows) {
    if (typeof rawRow !== "object" || rawRow === null) {
      throw new StoreIntegrityError(
        "Expected row object from codex_turn_queue query",
      );
    }
    const row = rawRow as Record<string, unknown>;
    const jobId = decodeRequiredText(
      row.job_id,
      row.raw_job_id,
      "job_id",
      decoder,
    );
    const channelId = decodeI64(row.channel_id, "channel_id");
    const state = decodeRequiredText(
      row.state,
      row.raw_state,
      "state",
      decoder,
    );
    const storedError = decodeRequiredText(
      row.last_error,
      row.raw_last_error,
      "last_error",
      decoder,
    );
    jobs.push({
      jobId,
      channelId,
      state,
      storedError,
    });
  }

  for (const job of jobs) {
    const previousError = previousNonForkError(job.storedError);
    const queueError = definiteMessage(forkError, previousError);
    const markerTime = now();
    const updateStmt = db.prepare(
      "UPDATE codex_turn_queue SET last_error = ?, updated_at = ? " +
        "WHERE job_id = ? AND target_thread_id = ? AND state = ? AND last_error = ?",
    );
    const updateResult = updateStmt.run(
      queueError,
      markerTime,
      job.jobId,
      source,
      job.state,
      job.storedError,
    );
    if (updateResult.changes !== 1 && updateResult.changes !== 1n) {
      throw new ForkHandoffConflictingIntentError(source);
    }

    const noticeId = `fork-definite:${handoffId}:${job.jobId}`;
    const noticeTime = now();
    const outboxStmt = db.prepare(
      "INSERT INTO codex_delivery_outbox (delivery_id, job_id, target_thread_id, " +
        "turn_id, channel_id, content, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING",
    );
    outboxStmt.run(
      noticeId,
      noticeId,
      source,
      `fork-definite:${handoffId}`,
      job.channelId,
      definiteNotice(forkError, previousError),
      noticeTime,
      noticeTime,
    );
  }

  return BigInt(jobs.length);
}
