import { I64_MAX, I64_MIN } from "../protocol/ids.ts";
import { jobCanMutate } from "./dead-generation-admission.ts";
import { requireUnheldIn } from "./execution-hold.ts";
import { isWellFormedUnicode, recordJobOrigin } from "./mirror-origin.ts";
import { bindRunningIn } from "./new-reply-bind.ts";
import { openInitialized } from "./owned-driver.ts";
import {
  QueueJobNotFoundError,
  selectJob,
  type StoredQueueJob,
} from "./queue-read.ts";

export class DeadGenerationTargetHeldError extends Error {
  readonly kind = "DeadGenerationTargetHeld" as const;
  readonly targetThreadId: string;

  constructor(targetThreadId: string) {
    super(
      `conversation ${targetThreadId} is on hold after app-server process loss; manual review is required`,
    );
    this.name = "DeadGenerationTargetHeldError";
    this.targetThreadId = targetThreadId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SystemTimeError extends Error {
  readonly kind = "SystemTime" as const;
  readonly gapMs: number;

  constructor(gapMs: number) {
    super(`system clock is before the Unix epoch: ${gapMs}ms`);
    this.name = "SystemTimeError";
    this.gapMs = gapMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const UPDATE_RUNNING_SQL =
  "UPDATE codex_turn_queue SET state = 'running', turn_observation_generation = app_server_generation, goal_waiting = 0, turn_id = ?, updated_at = ? " +
  "WHERE job_id = ? AND app_server_generation = ?";

function isValidUnicodeScalarString(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (typeof (value as unknown as { isWellFormed?: () => boolean }).isWellFormed === "function") {
    return (value as unknown as { isWellFormed: () => boolean }).isWellFormed();
  }
  return isWellFormedUnicode(value);
}

export async function markRunning(
  path: string,
  jobId: string,
  turnId: string,
  generation: bigint,
): Promise<StoredQueueJob> {
  if (typeof path !== "string" || !isValidUnicodeScalarString(path)) {
    throw new TypeError("Invalid database path: expected well-formed string");
  }
  if (typeof jobId !== "string" || !isValidUnicodeScalarString(jobId)) {
    throw new TypeError("Invalid job id: expected well-formed string");
  }
  if (typeof turnId !== "string" || !isValidUnicodeScalarString(turnId)) {
    throw new TypeError("Invalid turn id: expected well-formed string");
  }
  if (typeof generation !== "bigint") {
    throw new TypeError("Invalid generation: expected bigint");
  }
  if (generation < I64_MIN || generation > I64_MAX) {
    throw new RangeError(
      `Generation out of signed i64 range: ${generation.toString()}`,
    );
  }

  const pathSnapshot = path;
  const jobIdSnapshot = jobId;
  const turnIdSnapshot = turnId;
  const generationSnapshot = generation;

  const db = await openInitialized(pathSnapshot);
  let committed = false;
  let succeeded = false;

  try {
    db.exec("BEGIN IMMEDIATE;");
    try {
      requireUnheldIn(db, jobIdSnapshot);
      const original = selectJob(db, jobIdSnapshot);
      if (!jobCanMutate(db, original)) {
        throw new DeadGenerationTargetHeldError(original.targetThreadId);
      }

      const nowMs = Date.now();
      if (!Number.isFinite(nowMs)) {
        throw new TypeError("system clock must be finite");
      }
      if (nowMs < 0) {
        const gapMs = -nowMs;
        throw new SystemTimeError(gapMs);
      }
      const nowSeconds = nowMs / 1000;

      const stmt = db.prepare(UPDATE_RUNNING_SQL);
      const result = stmt.run(
        turnIdSnapshot,
        nowSeconds,
        jobIdSnapshot,
        generationSnapshot,
      );
      const changes =
        typeof result.changes === "bigint"
          ? Number(result.changes)
          : result.changes;
      if (changes !== 1) {
        throw new QueueJobNotFoundError(jobIdSnapshot);
      }

      const job = selectJob(db, jobIdSnapshot);
      bindRunningIn(db, job);
      recordJobOrigin(db, job);

      db.exec("COMMIT;");
      committed = true;
      succeeded = true;
      return job;
    } finally {
      if (!committed) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          // ignore rollback failure to preserve primary error
        }
      }
    }
  } finally {
    try {
      db.close();
    } catch (closeError) {
      if (succeeded) {
        throw closeError;
      }
      // preserve primary error when operation failed
    }
  }
}

export { QueueJobNotFoundError };
export type { StoredQueueJob };
