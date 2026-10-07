import type { DatabaseSync } from "node:sqlite";
import { openInitialized } from "./owned-driver.ts";
import { containsManagedTargetIn } from "./queue-managed-target.ts";

const CREATE_TABLE =
  "CREATE TABLE IF NOT EXISTS codex_thread_fork_handoffs (" +
  "handoff_id TEXT PRIMARY KEY, " +
  "ambiguous_job_id TEXT UNIQUE, " +
  "source_thread_id TEXT NOT NULL UNIQUE, " +
  "expected_generation INTEGER NOT NULL, " +
  "discord_channel_id INTEGER NOT NULL, " +
  "discord_thread_id INTEGER NOT NULL, " +
  "quarantine_reason TEXT NOT NULL, " +
  "last_fork_error TEXT NOT NULL DEFAULT '', " +
  "fork_failure_ambiguous INTEGER NOT NULL DEFAULT 0, " +
  "observed_target_thread_id TEXT, " +
  "target_thread_id TEXT UNIQUE, " +
  "completed_generation INTEGER, " +
  "created_at REAL NOT NULL, " +
  "completed_at REAL, " +
  "CHECK ((target_thread_id IS NULL AND completed_generation IS NULL AND completed_at IS NULL) " +
  "OR (target_thread_id IS NOT NULL AND completed_generation IS NOT NULL " +
  "AND completed_at IS NOT NULL)), " +
  "CHECK (target_thread_id IS NULL OR target_thread_id = observed_target_thread_id))";

const MANAGED_TARGET_QUERY =
  "SELECT EXISTS(SELECT 1 FROM codex_thread_fork_handoffs " +
  "WHERE target_thread_id = ? AND completed_at IS NOT NULL)";

const charCodeAt = String.prototype.charCodeAt;

function hasLoneSurrogates(s: string): boolean {
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const code = charCodeAt.call(s, i);
    if (code >= 0xd800 && code <= 0xdbff) {
      i++;
      if (i >= len) {
        return true;
      }
      const next = charCodeAt.call(s, i);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
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

function validateDatabaseHandle(db: unknown): DatabaseSync {
  if (db === null || typeof db !== "object") {
    throw new TypeError("db must be a DatabaseSync instance");
  }
  return db as DatabaseSync;
}

export function ensureForkHandoffTableIn(db: DatabaseSync): void {
  const connection = validateDatabaseHandle(db);
  connection.exec(CREATE_TABLE);

  const statement = connection.prepare(
    "PRAGMA table_info(codex_thread_fork_handoffs)",
  );
  const rows = statement.all() as Array<Record<string, unknown>>;
  const columns: string[] = [];
  for (const row of rows) {
    const name = row["name"];
    if (typeof name === "string") {
      columns.push(name);
    }
  }

  if (!columns.includes("observed_target_thread_id")) {
    connection.exec(
      "ALTER TABLE codex_thread_fork_handoffs ADD COLUMN observed_target_thread_id TEXT",
    );
  }
  if (!columns.includes("last_fork_error")) {
    connection.exec(
      "ALTER TABLE codex_thread_fork_handoffs ADD COLUMN last_fork_error TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!columns.includes("fork_failure_ambiguous")) {
    connection.exec(
      "ALTER TABLE codex_thread_fork_handoffs ADD COLUMN fork_failure_ambiguous INTEGER NOT NULL DEFAULT 0",
    );
  }
  connection.exec(
    "DROP INDEX IF EXISTS codex_thread_fork_handoffs_observed_target",
  );
}

export function managedTargetIn(
  db: DatabaseSync,
  threadId: string,
): boolean {
  const connection = validateDatabaseHandle(db);
  validateStringScalar("threadId", threadId);

  const stmt = connection.prepare(MANAGED_TARGET_QUERY);
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

export {
  ensureForkHandoffTableIn as ensureForkTableIn,
  managedTargetIn as managedForkTargetIn,
};

export async function isAppServerManagedTarget(
  path: string,
  threadId: string,
): Promise<boolean> {
  validateStringScalar("path", path);
  validateStringScalar("threadId", threadId);

  const db = await openInitialized(path);
  let primaryError: unknown = null;
  let hasPrimaryError = false;
  try {
    db.exec("BEGIN IMMEDIATE;");
    try {
      ensureForkHandoffTableIn(db);
      const managed =
        managedTargetIn(db, threadId) || containsManagedTargetIn(db, threadId);
      db.exec("COMMIT;");
      return managed;
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
  }
  finally {
    try {
      db.close();
    } catch (closeErr) {
      if (!hasPrimaryError) {
        throw closeErr;
      }
    }
  }
}
