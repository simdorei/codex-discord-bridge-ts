import type { DatabaseSync } from "node:sqlite";

import { I64_MAX, I64_MIN } from "../protocol/ids.ts";
import { targetIsHeldIn } from "./dead-generation-admission.ts";
import { openInitialized } from "./owned-driver.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";
import {
  decodeTextField,
  textDecoderFor,
  type SqliteTextDecoder,
} from "./sqlite-values.ts";

export class InvalidQueueStateError extends Error {
  readonly kind = "InvalidQueueState" as const;

  constructor(message: string) {
    super(
      message.startsWith("invalid durable queue state: ")
        ? message
        : `invalid durable queue state: ${message}`,
    );
    this.name = "InvalidQueueStateError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SystemTimeError extends Error {
  readonly kind = "SystemTime" as const;

  constructor(message = "system clock is before the Unix epoch") {
    super(
      message.startsWith("system clock is before the Unix epoch")
        ? message
        : `system clock is before the Unix epoch: ${message}`,
    );
    this.name = "SystemTimeError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
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

function assertI64(value: unknown, name: string): bigint {
  if (typeof value !== "bigint") {
    throw new TypeError(
      `Expected bigint for ${name}, received ${value === null ? "null" : typeof value}`,
    );
  }
  if (value < I64_MIN || value > I64_MAX) {
    throw new RangeError(
      `Integer overflow for ${name}: value ${value.toString()} out of i64 range`,
    );
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

function decodeJobId(
  nativeVal: unknown,
  rawBlob: unknown,
  decoder: SqliteTextDecoder,
): string {
  const decoded = decodeTextField(nativeVal, rawBlob, "job_id", false, decoder);
  if (decoded === null || !isScalarUnicode(decoded)) {
    throw new StoreIntegrityError(
      "Invalid UTF-8 in job_id: contains lone surrogate characters",
    );
  }
  return decoded;
}

/**
 * Translates frozen goal.rs attach_goal_turn.
 * Excludes observed_if_owned and wrappers per specification slice.
 */
export async function attachGoalTurn(
  path: string,
  targetThreadId: string,
  turnId: string,
  generation: bigint,
): Promise<boolean> {
  assertScalarUnicode(path, "path");
  assertScalarUnicode(targetThreadId, "targetThreadId");
  assertScalarUnicode(turnId, "turnId");
  assertI64(generation, "generation");

  const db = await openInitialized(path);
  let primaryError: unknown = null;
  try {
    db.exec("BEGIN IMMEDIATE;");
    if (targetIsHeldIn(db, targetThreadId)) {
      try {
        db.exec("ROLLBACK;");
      }
      catch {
        // ignore rollback error on early exit
      }
      return false;
    }

    const stmt = db.prepare(
      "SELECT job_id, CAST(job_id AS BLOB) AS raw_job_id FROM codex_turn_queue WHERE target_thread_id = ? " +
        "AND state = 'running' AND goal_waiting = 1 AND app_server_generation = ?",
    );
    const rows = stmt.all(targetThreadId, generation) as Array<Record<string, unknown>>;
    const encRow = db.prepare("PRAGMA encoding;").get() as Record<string, unknown> | undefined;
    const enc = encRow ? Object.values(encRow)[0] : undefined;
    const decoder = textDecoderFor(enc);

    const jobIds: string[] = [];
    for (const row of rows) {
      const rawJobId =
        typeof row === "object" && row !== null
          ? "job_id" in row
            ? row.job_id
            : Array.isArray(row)
              ? row[0]
              : undefined
          : undefined;
      const rawBlob =
        typeof row === "object" && row !== null
          ? "raw_job_id" in row
            ? row.raw_job_id
            : Array.isArray(row)
              ? row[1]
              : undefined
          : undefined;
      jobIds.push(decodeJobId(rawJobId, rawBlob, decoder));
    }

    if (jobIds.length === 0) {
      db.exec("COMMIT;");
      return false;
    }

    if (jobIds.length !== 1) {
      throw new InvalidQueueStateError(
        `multiple goal-waiting jobs for ${targetThreadId}`,
      );
    }

    const jobId = jobIds[0]!;
    const updatedAt = now();
    const updateStmt = db.prepare(
      "UPDATE codex_turn_queue SET turn_id = ?, turn_observation_generation = ?, " +
        "goal_waiting = 0, updated_at = ? WHERE job_id = ?",
    );
    updateStmt.run(turnId, generation, updatedAt, jobId);
    db.exec("COMMIT;");
    return true;
  }
  catch (err) {
    primaryError = err;
    if (db.isTransaction) {
      try {
        db.exec("ROLLBACK;");
      }
      catch {
        // preserve primary error
      }
    }
    throw err;
  }
  finally {
    try {
      db.close();
    }
    catch (closeErr) {
      if (primaryError === null) {
        throw closeErr;
      }
    }
  }
}
