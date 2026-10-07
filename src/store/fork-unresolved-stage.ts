import type { DatabaseSync } from "node:sqlite";

import {
  FailurePhase,
  priorError,
  unresolvedMessage,
  unresolvedNotice,
  UNRESOLVED_FORK_ERROR_PREFIX,
} from "./fork-unresolved-format.ts";
import { SystemTimeError } from "./queue-attach-goal.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";
import {
  decodeI64,
  decodeTextField,
  textDecoderFor,
  type SqliteTextDecoder,
} from "./sqlite-values.ts";

export { FailurePhase, UNRESOLVED_FORK_ERROR_PREFIX };

export class ForkHandoffConflictingIntentError extends Error {
  readonly kind = "ConflictingIntent" as const;
  readonly sourceThreadId: string;

  constructor(sourceThreadId: string) {
    super(`a different fork handoff already fences source thread ${sourceThreadId}`);
    this.name = "ForkHandoffConflictingIntentError";
    this.sourceThreadId = sourceThreadId;
    Object.setPrototypeOf(this, new.target.prototype);
    Object.freeze(this);
  }
}

function hasLoneSurrogates(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      i++;
      if (i >= s.length) {
        return true;
      }
      const next = s.charCodeAt(i);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validateInputString(name: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(`Expected string for ${name}, received ${value === null ? "null" : typeof value}`);
  }
  if (hasLoneSurrogates(value)) {
    throw new TypeError(`Invalid Unicode surrogate in ${name}`);
  }
  return value;
}

function validatePhase(phase: unknown): asserts phase is FailurePhase {
  if (
    phase !== FailurePhase.ForkOutcome &&
    phase !== FailurePhase.Finalize &&
    phase !== FailurePhase.Cancellation
  ) {
    throw new TypeError("invalid failure phase");
  }
}

/**
 * Returns current time as fractional seconds since the Unix epoch.
 *
 * Precision gap note: JavaScript's Date.now() provides millisecond precision
 * (seconds as f64 = ms / 1000), whereas Rust's SystemTime::now() provides
 * nanosecond precision. This sub-millisecond precision gap is explicit and accepted.
 */
export function now(): number {
  const ms = Date.now();
  if (!Number.isFinite(ms)) {
    throw new TypeError("system clock must be finite");
  }
  if (ms < 0) {
    throw new SystemTimeError(
      "system clock is before the Unix epoch: negative timestamp",
    );
  }
  return ms / 1000;
}

function getRowField(row: unknown, name: string, index: number): unknown {
  if (typeof row === "object" && row !== null) {
    if (name in row) {
      return (row as Record<string, unknown>)[name];
    }
    if (Array.isArray(row)) {
      return row[index];
    }
  }
  return undefined;
}

interface Notice {
  readonly deliveryId: string;
  readonly jobId: string;
  readonly targetThreadId: string;
  readonly turnId: string;
  readonly channelId: bigint;
  readonly content: string;
  readonly previouslyStaged: boolean;
}

function stageNotice(db: DatabaseSync, notice: Notice): void {
  const currentNow = now();
  if (notice.previouslyStaged) {
    db.prepare(
      "UPDATE codex_delivery_outbox SET content = ?, updated_at = ? " +
        "WHERE delivery_id = ? AND content != ?",
    ).run(notice.content, currentNow, notice.deliveryId, notice.content);
  } else {
    db.prepare(
      "INSERT INTO codex_delivery_outbox (delivery_id, job_id, target_thread_id, " +
        "turn_id, channel_id, content, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING",
    ).run(
      notice.deliveryId,
      notice.jobId,
      notice.targetThreadId,
      notice.turnId,
      notice.channelId,
      notice.content,
      currentNow,
      currentNow,
    );
  }
}

function updateQueueMarker(
  db: DatabaseSync,
  source: string,
  jobId: string,
  state: string,
  storedError: string,
  previousForkError: string,
  forkError: string,
): void {
  const marker = unresolvedMessage(
    forkError,
    priorError(storedError, previousForkError),
  );
  const updatedAt = now();
  const res = db.prepare(
    "UPDATE codex_turn_queue SET last_error = ?, updated_at = ? " +
      "WHERE job_id = ? AND target_thread_id = ? AND state = ? AND last_error = ?",
  ).run(marker, updatedAt, jobId, source, state, storedError);
  const rawChanges = res?.changes;
  const changes = typeof rawChanges === "bigint"
    ? rawChanges
    : typeof rawChanges === "number"
      ? BigInt(rawChanges)
      : 0n;
  if (changes !== 1n) {
    throw new ForkHandoffConflictingIntentError(source);
  }
}

function stageQueueNotices(
  db: DatabaseSync,
  handoffId: string,
  source: string,
  previousForkError: string,
  forkError: string,
  phase: FailurePhase,
  decoder: SqliteTextDecoder,
): void {
  const stmt = db.prepare(
    "SELECT job_id, CAST(job_id AS BLOB) AS raw_job_id, channel_id, " +
      "state, CAST(state AS BLOB) AS raw_state, " +
      "last_error, CAST(last_error AS BLOB) AS raw_last_error " +
      "FROM codex_turn_queue " +
      "WHERE target_thread_id = ? AND state IN ('pending', 'starting') " +
      "ORDER BY created_at, job_id",
  );
  if (typeof stmt.setReadBigInts === "function") {
    stmt.setReadBigInts(true);
  }
  const rows = stmt.all(source) as Array<Record<string, unknown>>;
  const jobs: Array<{
    jobId: string;
    channelId: bigint;
    state: string;
    storedError: string;
  }> = [];

  for (const row of rows) {
    const jobId = decodeTextField(
      getRowField(row, "job_id", 0),
      getRowField(row, "raw_job_id", 1),
      "job_id",
      false,
      decoder,
    );
    if (jobId === null || hasLoneSurrogates(jobId)) {
      throw new StoreIntegrityError(
        "Invalid UTF-8 in job_id: contains lone surrogate characters",
      );
    }
    const channelId = decodeI64(
      getRowField(row, "channel_id", 2),
      "channel_id",
    );
    const state = decodeTextField(
      getRowField(row, "state", 3),
      getRowField(row, "raw_state", 4),
      "state",
      false,
      decoder,
    );
    if (state === null || hasLoneSurrogates(state)) {
      throw new StoreIntegrityError(
        "Invalid UTF-8 in state: contains lone surrogate characters",
      );
    }
    const storedError = decodeTextField(
      getRowField(row, "last_error", 5),
      getRowField(row, "raw_last_error", 6),
      "last_error",
      false,
      decoder,
    );
    if (storedError === null || hasLoneSurrogates(storedError)) {
      throw new StoreIntegrityError(
        "Invalid UTF-8 in last_error: contains lone surrogate characters",
      );
    }
    jobs.push({ jobId, channelId, state, storedError });
  }

  for (const { jobId, channelId, state, storedError } of jobs) {
    const noticeId = state === "starting"
      ? `fork-unresolved-starting:${jobId}`
      : `fork-unresolved:${jobId}`;
    const noticeJobId = state === "starting"
      ? noticeId
      : jobId;

    updateQueueMarker(
      db,
      source,
      jobId,
      state,
      storedError,
      previousForkError,
      forkError,
    );

    stageNotice(db, {
      deliveryId: noticeId,
      jobId: noticeJobId,
      targetThreadId: source,
      turnId: `fork-unresolved:${handoffId}`,
      channelId,
      content: unresolvedNotice(
        forkError,
        priorError(storedError, previousForkError),
        phase,
      ),
      previouslyStaged: storedError.startsWith(UNRESOLVED_FORK_ERROR_PREFIX),
    });
  }
}

function stageIntakeNotices(
  db: DatabaseSync,
  handoffId: string,
  source: string,
  previousForkError: string,
  forkError: string,
  phase: FailurePhase,
  decoder: SqliteTextDecoder,
): void {
  const stmt = db.prepare(
    "SELECT job_id, CAST(job_id AS BLOB) AS raw_job_id, channel_id, " +
      "last_error, CAST(last_error AS BLOB) AS raw_last_error " +
      "FROM codex_prompt_intakes WHERE target_thread_id = ? " +
      "ORDER BY created_at, job_id",
  );
  if (typeof stmt.setReadBigInts === "function") {
    stmt.setReadBigInts(true);
  }
  const rows = stmt.all(source) as Array<Record<string, unknown>>;
  const intakes: Array<{
    jobId: string;
    channelId: bigint;
    storedError: string;
  }> = [];

  for (const row of rows) {
    const jobId = decodeTextField(
      getRowField(row, "job_id", 0),
      getRowField(row, "raw_job_id", 1),
      "job_id",
      false,
      decoder,
    );
    if (jobId === null || hasLoneSurrogates(jobId)) {
      throw new StoreIntegrityError(
        "Invalid UTF-8 in job_id: contains lone surrogate characters",
      );
    }
    const channelId = decodeI64(
      getRowField(row, "channel_id", 2),
      "channel_id",
    );
    const storedError = decodeTextField(
      getRowField(row, "last_error", 3),
      getRowField(row, "raw_last_error", 4),
      "last_error",
      false,
      decoder,
    );
    if (storedError === null || hasLoneSurrogates(storedError)) {
      throw new StoreIntegrityError(
        "Invalid UTF-8 in last_error: contains lone surrogate characters",
      );
    }
    intakes.push({ jobId, channelId, storedError });
  }

  for (const { jobId, channelId, storedError } of intakes) {
    const previouslyStaged = storedError.startsWith(UNRESOLVED_FORK_ERROR_PREFIX);
    const previousError = priorError(storedError, previousForkError);
    const marker = unresolvedMessage(forkError, previousError);
    const updatedAt = now();
    const res = db.prepare(
      "UPDATE codex_prompt_intakes SET last_error = ?, updated_at = ? " +
        "WHERE job_id = ? AND target_thread_id = ? AND last_error = ?",
  ).run(marker, updatedAt, jobId, source, storedError);
    const rawChanges = res?.changes;
    const changes = typeof rawChanges === "bigint"
      ? rawChanges
      : typeof rawChanges === "number"
        ? BigInt(rawChanges)
        : 0n;
    if (changes !== 1n) {
      throw new ForkHandoffConflictingIntentError(source);
    }

    const noticeId = `fork-unresolved-intake:${jobId}`;
    stageNotice(db, {
      deliveryId: noticeId,
      jobId: noticeId,
      targetThreadId: source,
      turnId: `fork-unresolved-intake:${handoffId}`,
      channelId,
      content: unresolvedNotice(forkError, previousError, phase),
      previouslyStaged,
    });
  }
}

export function stageUnresolvedNoticesIn(
  db: DatabaseSync,
  handoffId: string,
  source: string,
  previousForkError: string,
  forkError: string,
  phase: FailurePhase,
): void {
  validateInputString("handoffId", handoffId);
  validateInputString("source", source);
  validateInputString("previousForkError", previousForkError);
  validateInputString("forkError", forkError);
  validatePhase(phase);

  const encRow = db.prepare("PRAGMA encoding;").get() as Record<string, unknown> | undefined;
  const enc = encRow ? Object.values(encRow)[0] : undefined;
  const decoder = textDecoderFor(enc);

  stageQueueNotices(
    db,
    handoffId,
    source,
    previousForkError,
    forkError,
    phase,
    decoder,
  );
  stageIntakeNotices(
    db,
    handoffId,
    source,
    previousForkError,
    forkError,
    phase,
    decoder,
  );
}
