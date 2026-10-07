import type { DatabaseSync } from "node:sqlite";
import { I64_MAX, I64_MIN } from "../protocol/ids.ts";
import { openInitialized } from "./owned-driver.ts";

const CREATE_TABLE =
  "CREATE TABLE IF NOT EXISTS codex_app_server_managed_targets (" +
  "thread_id TEXT PRIMARY KEY, " +
  "app_server_generation INTEGER NOT NULL, " +
  "created_at REAL NOT NULL, " +
  "updated_at REAL NOT NULL)";

const UPSERT_TARGET =
  "INSERT INTO codex_app_server_managed_targets " +
  "(thread_id, app_server_generation, created_at, updated_at) " +
  "VALUES (?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET " +
  "app_server_generation = excluded.app_server_generation, " +
  "updated_at = excluded.updated_at";

const CONTAINS_TARGET =
  "SELECT EXISTS(SELECT 1 FROM codex_app_server_managed_targets WHERE thread_id = ?)";

export class InvalidAppServerManagedTargetError extends Error {
  readonly kind = "InvalidAppServerManagedTarget" as const;

  constructor(threadId: string) {
    super(`invalid direct app-server managed target: ${threadId}`);
    this.name = "InvalidAppServerManagedTargetError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SystemTimeError extends Error {
  readonly kind = "SystemTime" as const;
  readonly gap?: number | undefined;

  constructor(gap?: number | string) {
    const detail =
      gap !== undefined ? String(gap) : "second time provided was later than self";
    super(`system clock is before the Unix epoch: ${detail}`);
    this.name = "SystemTimeError";
    if (typeof gap === "number") {
      this.gap = gap;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export {
  InvalidAppServerManagedTargetError as InvalidAppServerManagedTarget,
  SystemTimeError as SystemTime,
};

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

function isRustWhitespace(code: number): boolean {
  return (
    (code >= 0x0009 && code <= 0x000d) ||
    code === 0x0020 ||
    code === 0x0085 ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

function rustTrim(s: string): string {
  let start = 0;
  while (start < s.length && isRustWhitespace(s.charCodeAt(start))) {
    start++;
  }
  let end = s.length;
  while (end > start && isRustWhitespace(s.charCodeAt(end - 1))) {
    end--;
  }
  return s.slice(start, end);
}

function validateStringScalar(name: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  if (hasLoneSurrogates(value)) {
    throw new TypeError(`${name} contains lone surrogates`);
  }
  return value;
}

function validateBigIntI64(name: string, value: unknown): bigint {
  if (typeof value !== "bigint") {
    throw new TypeError(`${name} must be a bigint`);
  }
  if (value < I64_MIN || value > I64_MAX) {
    throw new RangeError(`${name} out of signed i64 range: ${value.toString()}`);
  }
  return value;
}

function validateDatabaseHandle(db: unknown): DatabaseSync {
  if (db === null || typeof db !== "object") {
    throw new TypeError("db must be a DatabaseSync instance");
  }
  return db as DatabaseSync;
}

export async function markAppServerManagedTarget(
  path: string,
  threadId: string,
  generation: bigint,
): Promise<void> {
  validateStringScalar("path", path);
  validateStringScalar("threadId", threadId);
  if (threadId.length === 0 || rustTrim(threadId) !== threadId) {
    throw new InvalidAppServerManagedTargetError(threadId);
  }
  validateBigIntI64("generation", generation);

  const now = Date.now();
  if (!Number.isFinite(now)) {
    throw new TypeError("system clock must be finite");
  }
  if (now < 0) {
    throw new SystemTimeError(-now);
  }
  const observedAt = now / 1000;

  const db = await openInitialized(path);
  let primaryError: unknown = null;
  let hasPrimaryError = false;
  try {
    db.exec("BEGIN IMMEDIATE;");
    try {
      markManagedTargetIn(db, threadId, generation, observedAt);
      db.exec("COMMIT;");
    } catch (err) {
      hasPrimaryError = true;
      primaryError = err;
      try {
        db.exec("ROLLBACK;");
      } catch {
        // preserve primary error on rollback failure
      }
      throw err;
    }
  } catch (err) {
    if (!hasPrimaryError) {
      hasPrimaryError = true;
      primaryError = err;
    }
    throw err;
  } finally {
    try {
      db.close();
    } catch (closeErr) {
      if (!hasPrimaryError) {
        throw closeErr;
      }
    }
  }
}

export function markManagedTargetIn(
  db: DatabaseSync,
  threadId: string,
  generation: bigint,
  observedAt: number,
): void {
  const connection = validateDatabaseHandle(db);
  validateStringScalar("threadId", threadId);
  validateBigIntI64("generation", generation);
  if (typeof observedAt !== "number") {
    throw new TypeError("observedAt must be a number");
  }

  const trimmed = rustTrim(threadId);
  if (trimmed.length === 0 || trimmed !== threadId || generation <= 0n) {
    throw new InvalidAppServerManagedTargetError(threadId);
  }

  ensureManagedTargetTableIn(connection);
  const stmt = connection.prepare(UPSERT_TARGET);
  stmt.run(threadId, generation, observedAt, observedAt);
}

export function ensureManagedTargetTableIn(db: DatabaseSync): void {
  const connection = validateDatabaseHandle(db);
  connection.exec(CREATE_TABLE);
}

export function containsManagedTargetIn(
  db: DatabaseSync,
  threadId: string,
): boolean {
  const connection = validateDatabaseHandle(db);
  validateStringScalar("threadId", threadId);
  ensureManagedTargetTableIn(connection);

  const stmt = connection.prepare(CONTAINS_TARGET);
  stmt.setReadBigInts(true);
  const row = stmt.get(threadId) as Record<string, unknown> | undefined;
  if (!row) {
    return false;
  }
  const values = Object.values(row);
  const val = values[0];
  if (val === 1n) {
    return true;
  }
  if (val === 0n) {
    return false;
  }
  throw new TypeError(`Unexpected exists result: ${String(val)}`);
}
