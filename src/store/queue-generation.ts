import { I64_MAX, I64_MIN } from "../protocol/ids.ts";
import { openInitialized } from "./owned-driver.ts";
import { allJobs, type StoredQueueJob } from "./queue-read.ts";

export interface QueueGenerationAdoption {
  jobs: StoredQueueJob[];
  adoptedCount: bigint;
}

const ADOPT_GENERATION_SQL =
  "UPDATE codex_turn_queue SET app_server_generation = ? " +
  "WHERE state = 'pending' AND app_server_generation != ? AND NOT EXISTS " +
  "(SELECT 1 FROM codex_dead_generation_holds hold " +
  "WHERE hold.target_thread_id = codex_turn_queue.target_thread_id)";

const ADOPT_TARGET_GENERATION_SQL =
  "UPDATE codex_turn_queue SET app_server_generation = ? " +
  "WHERE target_thread_id = ? AND state = 'pending' AND app_server_generation != ? AND NOT EXISTS " +
  "(SELECT 1 FROM codex_dead_generation_holds hold " +
  "WHERE hold.target_thread_id = codex_turn_queue.target_thread_id)";

function isWellFormedString(s: string): boolean {
  if (typeof (s as unknown as { isWellFormed?: () => boolean }).isWellFormed === "function") {
    return (s as unknown as { isWellFormed: () => boolean }).isWellFormed();
  }
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

export async function adoptGeneration(
  path: string,
  generation: bigint,
): Promise<QueueGenerationAdoption> {
  if (typeof path !== "string" || !isWellFormedString(path)) {
    throw new TypeError(`Invalid database path: ${String(path)}`);
  }
  if (typeof generation !== "bigint") {
    throw new TypeError("Invalid generation: expected bigint");
  }
  if (generation < I64_MIN || generation > I64_MAX) {
    throw new RangeError(`Generation out of signed i64 range: ${generation.toString()}`);
  }

  const snapPath = path;
  const snapGeneration = generation;

  const db = await openInitialized(snapPath);
  let committed = false;
  try {
    db.exec("BEGIN IMMEDIATE;");
    const stmt = db.prepare(ADOPT_GENERATION_SQL);
    stmt.setReadBigInts(true);
    const result = stmt.run(snapGeneration, snapGeneration);
    const adoptedCount = typeof result.changes === "bigint" ? result.changes : BigInt(result.changes);
    const jobs = allJobs(db);
    db.exec("COMMIT;");
    committed = true;
    return {
      jobs,
      adoptedCount,
    };
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
      // preserve primary error
    }
  }
}

export async function adoptTargetGeneration(
  path: string,
  target: string,
  generation: bigint,
): Promise<QueueGenerationAdoption> {
  if (typeof path !== "string" || !isWellFormedString(path)) {
    throw new TypeError(`Invalid database path: ${String(path)}`);
  }
  if (typeof target !== "string" || !isWellFormedString(target)) {
    throw new TypeError("Invalid target: expected well-formed string");
  }
  if (typeof generation !== "bigint") {
    throw new TypeError("Invalid generation: expected bigint");
  }
  if (generation < I64_MIN || generation > I64_MAX) {
    throw new RangeError(`Generation out of signed i64 range: ${generation.toString()}`);
  }

  const snapPath = path;
  const snapTarget = target;
  const snapGeneration = generation;

  const db = await openInitialized(snapPath);
  let committed = false;
  try {
    db.exec("BEGIN IMMEDIATE;");
    const stmt = db.prepare(ADOPT_TARGET_GENERATION_SQL);
    stmt.setReadBigInts(true);
    const result = stmt.run(snapGeneration, snapTarget, snapGeneration);
    const adoptedCount = typeof result.changes === "bigint" ? result.changes : BigInt(result.changes);
    const all = allJobs(db);
    const jobs = all.filter((job) => job.targetThreadId === snapTarget);
    db.exec("COMMIT;");
    committed = true;
    return {
      jobs,
      adoptedCount,
    };
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
      // preserve primary error
    }
  }
}
