import { openInitialized } from "./owned-driver.ts";

const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;

const UPDATE_GOAL_WAITING_SQL =
  "UPDATE codex_turn_queue SET goal_waiting = 1, updated_at = ? " +
  "WHERE job_id = ? AND turn_id = ? AND state = 'running' " +
  "AND app_server_generation = ? AND NOT EXISTS " +
  "(SELECT 1 FROM codex_dead_generation_holds hold " +
  "WHERE hold.target_thread_id = codex_turn_queue.target_thread_id)";

class SystemTimeError extends Error {
  readonly kind = "SystemTime" as const;

  constructor(message = "system clock is before the Unix epoch") {
    super(message);
    this.name = "SystemTimeError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Validates that a string contains only well-formed Unicode scalar values,
 * rejecting unpaired UTF-16 high and low surrogates.
 *
 * Uses a manual `charCodeAt` loop instead of `String.prototype.isWellFormed`
 * because the latter is an ES2024 feature and may be undefined under ES2023.
 *
 * Valid surrogate pairs, NUL, BOM, and empty strings are accepted.
 * No normalization is performed.
 */
function validateScalarString(value: string, name: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= value.length) {
        throw new TypeError(`${name} must not contain unpaired surrogates`);
      }
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`${name} must not contain unpaired surrogates`);
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${name} must not contain unpaired surrogates`);
    }
  }
}

/**
 * Module-private clock replicating Rust `SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64()`.
 *
 * Samples Date.now() once as a primitive number.
 * - Non-finite values throw TypeError("system clock must be finite") at the TS boundary.
 * - Negative finite values throw SystemTimeError with kind "SystemTime" and message prefix
 *   "system clock is before the Unix epoch".
 *
 * Millisecond precision gap:
 * Rust `SystemTime::now()` samples the platform clock with sub-microsecond or nanosecond
 * resolution before converting to floating-point seconds (f64).
 * JavaScript `Date.now()` provides millisecond resolution. Dividing the same primitive
 * millisecond value by 1000 produces seconds as f64 with at most 1 ms precision.
 */
function now(): number {
  const rawMs = Date.now();
  if (!Number.isFinite(rawMs)) {
    throw new TypeError("system clock must be finite");
  }
  if (rawMs < 0) {
    throw new SystemTimeError("system clock is before the Unix epoch");
  }
  return rawMs / 1000;
}

/**
 * Marks a queued running turn job as waiting for goal turn attachment.
 *
 * Direct port of Rust `queue/goal.rs::mark_goal_waiting`.
 *
 * Runs a single UPDATE statement on an open initialized database connection without
 * adding an explicit transaction (the function owns the connection).
 * Returns true if exactly 1 row was changed, false otherwise.
 */
export async function markGoalWaiting(
  path: string,
  jobId: string,
  turnId: string,
  generation: bigint,
): Promise<boolean> {
  if (typeof path !== "string") {
    throw new TypeError("path must be a string");
  }
  if (typeof jobId !== "string") {
    throw new TypeError("jobId must be a string");
  }
  if (typeof turnId !== "string") {
    throw new TypeError("turnId must be a string");
  }
  if (typeof generation !== "bigint") {
    throw new TypeError("generation must be a bigint");
  }
  if (generation < I64_MIN || generation > I64_MAX) {
    throw new RangeError(`generation out of i64 range: ${generation.toString()}`);
  }

  const snapshotPath = path;
  const snapshotJobId = jobId;
  const snapshotTurnId = turnId;
  const snapshotGeneration = generation;

  validateScalarString(snapshotPath, "path");
  validateScalarString(snapshotJobId, "jobId");
  validateScalarString(snapshotTurnId, "turnId");

  const db = await openInitialized(snapshotPath);
  try {
    const updatedAt = now();
    const statement = db.prepare(UPDATE_GOAL_WAITING_SQL);
    const result = statement.run(
      updatedAt,
      snapshotJobId,
      snapshotTurnId,
      snapshotGeneration,
    );
    return result.changes === 1 || result.changes === 1n;
  } finally {
    db.close();
  }
}
