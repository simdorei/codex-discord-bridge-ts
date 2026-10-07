import { I64_MAX, I64_MIN } from "../protocol/ids.ts";
import { jobCanMutate } from "./dead-generation-admission.ts";
import { requireUnheldIn } from "./execution-hold.ts";
import { recordJobOrigin } from "./mirror-origin.ts";
import { bindRunningIn } from "./new-reply-bind.ts";
import { openInitialized } from "./owned-driver.ts";
import { QueueJobNotFoundError, selectJob, type StoredQueueJob } from "./queue-read.ts";

class DeadGenerationTargetHeldError extends Error {
  readonly kind = "DeadGenerationTargetHeld" as const;

  constructor(targetThreadId: string) {
    super(
      `conversation ${targetThreadId} is on hold after app-server process loss; manual review is required`,
    );
    this.name = "DeadGenerationTargetHeldError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

class SystemTimeError extends Error {
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
  if (typeof (s as unknown as { isWellFormed?: () => boolean }).isWellFormed === "function") {
    return (s as unknown as { isWellFormed: () => boolean }).isWellFormed();
  }
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
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

const UPDATE_JOB_SQL =
  "UPDATE codex_turn_queue SET state = 'starting', execution_generation = app_server_generation, turn_observation_generation = NULL, goal_waiting = 0, " +
  "attempt_count = CASE WHEN attempt_count < 9223372036854775807 " +
  "THEN attempt_count + 1 ELSE attempt_count END, " +
  "turn_id = NULL, baseline_turn_ids = ?, last_error = '', updated_at = ? " +
  "WHERE job_id = ? AND app_server_generation = ?";

export async function beginAttempt(
  path: string,
  jobId: string,
  baselineTurnIds: readonly string[],
  generation: bigint,
): Promise<StoredQueueJob> {
  if (typeof path !== "string" || !isWellFormedString(path)) {
    throw new TypeError(`Invalid database path: ${String(path)}`);
  }
  if (typeof jobId !== "string" || !isWellFormedString(jobId)) {
    throw new TypeError(`Invalid job id: ${String(jobId)}`);
  }
  if (!Array.isArray(baselineTurnIds)) {
    throw new TypeError("baselineTurnIds must be an array");
  }
  if (typeof generation !== "bigint") {
    throw new TypeError("generation must be a bigint");
  }
  if (generation < I64_MIN || generation > I64_MAX) {
    throw new RangeError(
      `generation out of signed i64 range: ${generation.toString()}`,
    );
  }

  const snapshotPath = path;
  const snapshotJobId = jobId;
  const snapshotGeneration = generation;
  const snapshotBaselineTurnIds: string[] = [];

  for (let i = 0; i < baselineTurnIds.length; i++) {
    const item = baselineTurnIds[i];
    if (typeof item !== "string" || !isWellFormedString(item)) {
      throw new TypeError(
        `baselineTurnIds element ${i} must be a well-formed string`,
      );
    }
    snapshotBaselineTurnIds.push(item);
  }

  const serializedBaseline = JSON.stringify(snapshotBaselineTurnIds);

  const db = await openInitialized(snapshotPath);
  let committed = false;
  try {
    db.exec("BEGIN IMMEDIATE;");

    requireUnheldIn(db, snapshotJobId);

    const original = selectJob(db, snapshotJobId);

    if (!jobCanMutate(db, original)) {
      throw new DeadGenerationTargetHeldError(original.targetThreadId);
    }

    const first = serializedBaseline;
    const updatedAt = now();
    const stmt = db.prepare(UPDATE_JOB_SQL);
    const result = stmt.run(first, updatedAt, snapshotJobId, snapshotGeneration);
    if (result.changes !== 1 && result.changes !== 1n) {
      throw new QueueJobNotFoundError(snapshotJobId);
    }

    const job = selectJob(db, snapshotJobId);

    bindRunningIn(db, job);
    recordJobOrigin(db, job);

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
