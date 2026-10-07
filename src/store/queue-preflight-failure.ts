import { I64_MAX, I64_MIN } from "../protocol/ids.ts";
import { openInitialized } from "./owned-driver.ts";
import { selectJob, type StoredQueueJob } from "./queue-read.ts";

export class SystemTimeError extends Error {
  readonly kind = "SystemTime" as const;

  constructor(
    message = "system clock is before the Unix epoch: time is earlier than 1970-01-01T00:00:00Z",
  ) {
    super(
      message.startsWith("system clock is before the Unix epoch")
        ? message
        : `system clock is before the Unix epoch: ${message}`,
    );
    this.name = "SystemTimeError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function isWellFormedString(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= s.length) return false;
      const next = s.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const UNICODE_WHITE_SPACE_PREFIX = /^\p{White_Space}+/u;
const UNICODE_WHITE_SPACE_SUFFIX = /\p{White_Space}+$/u;

export function trimUnicodeWhitespace(s: string): string {
  return s
    .replace(UNICODE_WHITE_SPACE_PREFIX, "")
    .replace(UNICODE_WHITE_SPACE_SUFFIX, "");
}

export function takeUnicodeScalarChars(s: string, limit = 1000): string {
  let result = "";
  let count = 0;
  for (const char of s) {
    if (count >= limit) {
      break;
    }
    result += char;
    count++;
  }
  return result;
}

function truncateError(error: string): string {
  const trimmed = trimUnicodeWhitespace(error);
  return takeUnicodeScalarChars(trimmed, 1000);
}

function now(): number {
  // Date.now() provides millisecond precision vs frozen Rust submillisecond f64.
  const milliseconds = Date.now();
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("system clock must be finite");
  }
  if (milliseconds < 0) {
    throw new SystemTimeError(
      "system clock is before the Unix epoch: time is earlier than 1970-01-01T00:00:00Z",
    );
  }
  return milliseconds / 1000;
}

const UPDATE_PREFLIGHT_FAILURE_SQL =
  "UPDATE codex_turn_queue SET " +
  "attempt_count = CASE WHEN attempt_count < 9223372036854775807 " +
  "THEN attempt_count + 1 ELSE attempt_count END, " +
  "last_error = ?, updated_at = ? " +
  "WHERE job_id = ? AND app_server_generation = ? AND state = 'pending'";

export async function recordPreflightFailure(
  path: string,
  jobId: string,
  generation: bigint,
  error: string,
): Promise<StoredQueueJob | null> {
  if (typeof path !== "string" || !isWellFormedString(path)) {
    throw new TypeError("Invalid database path");
  }
  if (typeof jobId !== "string" || !isWellFormedString(jobId)) {
    throw new TypeError("Invalid job id");
  }
  if (typeof generation !== "bigint") {
    throw new TypeError("Invalid generation");
  }
  if (generation < I64_MIN || generation > I64_MAX) {
    throw new RangeError(
      `generation out of signed i64 range: ${generation.toString()}`,
    );
  }
  if (typeof error !== "string" || !isWellFormedString(error)) {
    throw new TypeError("Invalid error string");
  }

  const snapshotPath = path;
  const snapshotJobId = jobId;
  const snapshotGeneration = generation;
  const snapshotError = error;

  const db = await openInitialized(snapshotPath);
  let committed = false;
  try {
    db.exec("BEGIN IMMEDIATE;");

    const boundedError = truncateError(snapshotError);
    const updatedAt = now();
    const stmt = db.prepare(UPDATE_PREFLIGHT_FAILURE_SQL);
    const result = stmt.run(
      boundedError,
      updatedAt,
      snapshotJobId,
      snapshotGeneration,
    );

    const updated = result.changes === 1 || result.changes === 1n;
    const job = updated ? selectJob(db, snapshotJobId) : null;

    db.exec("COMMIT;");
    committed = true;
    return job;
  } finally {
    if (!committed) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // ignore rollback error on failure path
      }
    }
    try {
      db.close();
    } catch {
      // ignore close failure
    }
  }
}
