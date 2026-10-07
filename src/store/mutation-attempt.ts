// Pre-dispatch evidence, never a lease or permission to replay.

import type { DatabaseSync } from "node:sqlite";

import { sha256SerdeValue } from "../core/serde-json.ts";
import { openExisting } from "./existing-store.ts";
import { openInitialized } from "./owned-driver.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";

const MAX_PREPARED = 1024n;
const MAX_CONFIRMED = 256n;
const MIN_I64 = -9223372036854775808n;
const MAX_I64 = 9223372036854775807n;

// Rust char::is_whitespace matches Unicode White_Space, which includes NEL (U+0085)
// but does NOT include BOM / Zero Width No-Break Space (U+FEFF).
const RUST_WHITESPACE_REGEX =
  /^[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]*$/;

function isRustTrimEmpty(value: string): boolean {
  return RUST_WHITESPACE_REGEX.test(value);
}

function isWellFormedString(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (
    typeof (value as unknown as { isWellFormed?: unknown }).isWellFormed ===
    "function"
  ) {
    return (value as unknown as { isWellFormed: () => boolean }).isWellFormed();
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      i++;
      if (i >= value.length) {
        return false;
      }
      const next = value.charCodeAt(i);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function decodeBool(value: unknown): boolean {
  return value === 1 || value === 1n;
}

function refused(message: string): StoreIntegrityError {
  return new StoreIntegrityError(message);
}

/**
 * Returns current UNIX epoch timestamp in seconds with wall-clock millisecond fidelity.
 * Note: Date.now() / 1000 provides millisecond fidelity vs Rust SystemTime sub-millisecond precision.
 */
function getNowSeconds(): number {
  const now = Date.now() / 1000;
  if (!Number.isFinite(now) || now < 0) {
    throw refused("invalid system wall clock timestamp");
  }
  return now;
}

export interface NewAttempt {
  runtimeId: string;
  ownerId: string;
  generation: bigint;
  attemptId: string;
  wireId: string;
  method: string;
  targetThreadId: string | null;
  scoped: boolean;
  payload: unknown;
}

export interface Completion {
  runtimeId: string;
  ownerId: string;
  generation: bigint;
  attemptId: string;
  wireId: string;
  outcome: string;
}

export function ownerIsCurrent(db: DatabaseSync, runtime: string): void {
  if (!isWellFormedString(runtime)) {
    throw refused(
      "mutation journal runtime changed or is missing; dispatch held",
    );
  }
  const statement = db.prepare(
    "SELECT runtime_id, CAST(runtime_id AS BLOB) AS runtime_bytes FROM codex_mutation_runtime WHERE singleton=1",
  );
  const row = statement.get() as Record<string, unknown> | undefined;
  if (!row) {
    throw refused(
      "mutation journal runtime changed or is missing; dispatch held",
    );
  }
  const current = row.runtime_id;
  const runtimeBytes = row.runtime_bytes;
  if (typeof current !== "string" || !(runtimeBytes instanceof Uint8Array)) {
    throw refused(
      "mutation journal runtime changed or is missing; dispatch held",
    );
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(runtimeBytes);
  } catch {
    throw refused(
      "mutation journal runtime changed or is missing; dispatch held",
    );
  }
  if (decoded !== runtime || current !== decoded) {
    throw refused(
      "mutation journal runtime changed or is missing; dispatch held",
    );
  }
}

export async function activate(path: string, runtime: string): Promise<void> {
  if (!isWellFormedString(runtime) || isRustTrimEmpty(runtime)) {
    throw refused("empty mutation runtime");
  }
  const db = await openInitialized(path);
  try {
    const statement = db.prepare(
      "INSERT INTO codex_mutation_runtime(singleton,runtime_id) VALUES(1,?) " +
        "ON CONFLICT(singleton) DO UPDATE SET runtime_id=excluded.runtime_id",
    );
    statement.run(runtime);
    // Never delete prepared attempts, even when their process/owner has changed.
  } finally {
    try {
      db.close();
    } catch {
      // preserve any active error
    }
  }
}

export function unblocked(db: DatabaseSync, target: string | null = null): void {
  if (target !== null && !isWellFormedString(target)) {
    throw refused("invalid mutation attempt identity");
  }
  const statement = db.prepare(
    "SELECT attempt_id,method FROM codex_mutation_attempts " +
      "WHERE state='prepared' AND (?1 IS NULL OR scoped=0 OR target_thread_id=?1) " +
      "ORDER BY sequence LIMIT 1",
  );
  const row = statement.get(target ?? null) as
    | Record<string, unknown>
    | undefined;
  if (row) {
    const attemptId = row.attempt_id;
    const method = row.method;
    if (typeof attemptId !== "string" || typeof method !== "string") {
      throw refused("invalid mutation attempt row in database");
    }
    throw refused(
      `unresolved mutation ${attemptId} (${method}); dispatch held without replay`,
    );
  }
}

export function check(
  path: string,
  runtime: string,
  target: string | null = null,
): void {
  const db = openExisting(path);
  try {
    ownerIsCurrent(db, runtime);
    unblocked(db, target);
  } finally {
    try {
      db.close();
    } catch {
      // preserve original error
    }
  }
}

export function begin(path: string, attempt: NewAttempt): void {
  beginChecked(path, attempt, () => undefined);
}

/**
 * Serialize a durable authority check with the final writer claim.
 *
 * The caller must carry the original admission identity across all waits. The
 * check must use this transaction's connection, not a separate connection or a
 * newly captured revision. It runs again after INSERT to reject changed
 * authority before commit. A committed claim remains evidence, not replay
 * permission, if stop/cancellation wins after this function returns.
 */
export function beginChecked(
  path: string,
  attempt: NewAttempt,
  authorityCheck: (db: DatabaseSync) => undefined,
): void {
  // Capture ORIGINAL primitive input fields and payload SHA BEFORE any callbacks or DB calls.
  const runtimeId = attempt.runtimeId;
  const ownerId = attempt.ownerId;
  const generation = attempt.generation;
  const attemptId = attempt.attemptId;
  const wireId = attempt.wireId;
  const method = attempt.method;
  const targetThreadId = attempt.targetThreadId;
  const scoped = attempt.scoped;
  const payload = attempt.payload;

  if (
    !isWellFormedString(runtimeId) ||
    isRustTrimEmpty(runtimeId) ||
    !isWellFormedString(ownerId) ||
    isRustTrimEmpty(ownerId) ||
    !isWellFormedString(attemptId) ||
    isRustTrimEmpty(attemptId) ||
    !isWellFormedString(wireId) ||
    isRustTrimEmpty(wireId) ||
    !isWellFormedString(method) ||
    isRustTrimEmpty(method) ||
    typeof generation !== "bigint" ||
    generation < 1n ||
    generation > MAX_I64 ||
    typeof scoped !== "boolean" ||
    (scoped &&
      (targetThreadId === null ||
        !isWellFormedString(targetThreadId) ||
        isRustTrimEmpty(targetThreadId))) ||
    (!scoped && targetThreadId !== null && !isWellFormedString(targetThreadId))
  ) {
    throw refused("invalid mutation attempt identity");
  }

  const hash = sha256SerdeValue(payload);

  const db = openExisting(path);
  let committed = false;
  try {
    db.exec("BEGIN IMMEDIATE;");
    try {
      ownerIsCurrent(db, runtimeId);

      const check1 = authorityCheck(db);
      if (check1 !== undefined) {
        throw refused("authority check must return undefined synchronously");
      }

      unblocked(db, scoped ? targetThreadId : null);

      const countStmt = db.prepare(
        "SELECT count(*) FROM codex_mutation_attempts WHERE state='prepared'",
      );
      countStmt.setReadBigInts(true);
      const countRow = countStmt.get() as Record<string, unknown> | undefined;
      const countVal = countRow ? Object.values(countRow)[0] : undefined;
      if (typeof countVal !== "bigint") {
        throw refused("failed to read prepared mutation count");
      }
      if (countVal >= MAX_PREPARED) {
        throw refused(
          "unresolved mutation capacity reached; no eviction or dispatch",
        );
      }

      const now = getNowSeconds();

      const insertStmt = db.prepare(
        "INSERT INTO codex_mutation_attempts(attempt_id,runtime_id,owner_id,generation," +
          "wire_id,method,target_thread_id,scoped,request_sha256,state,created_at,updated_at) " +
          "VALUES(?,?,?,?,?,?,?,?,?,'prepared',?,?)",
      );
      const insertResult = insertStmt.run(
        attemptId,
        runtimeId,
        ownerId,
        generation,
        wireId,
        method,
        targetThreadId,
        scoped ? 1 : 0,
        hash,
        now,
        now,
      );
      if (insertResult.changes !== 1 && insertResult.changes !== 1n) {
        throw refused("mutation intent insert did not claim a row");
      }

      ownerIsCurrent(db, runtimeId);

      const retainedStmt = db.prepare(
        "SELECT EXISTS(SELECT 1 FROM codex_mutation_attempts " +
          "WHERE attempt_id=? AND runtime_id=? AND owner_id=? AND generation=? AND wire_id=? " +
          "AND method=? AND target_thread_id IS ? AND scoped=? AND request_sha256=? AND state='prepared')",
      );
      retainedStmt.setReadBigInts(true);
      const retainedRow = retainedStmt.get(
        attemptId,
        runtimeId,
        ownerId,
        generation,
        wireId,
        method,
        targetThreadId,
        scoped ? 1 : 0,
        hash,
      ) as Record<string, unknown> | undefined;
      const retainedVal = retainedRow ? Object.values(retainedRow)[0] : undefined;
      const retained = decodeBool(retainedVal);
      if (!retained) {
        throw refused("mutation intent changed before commit");
      }

      const check2 = authorityCheck(db);
      if (check2 !== undefined) {
        throw refused("authority check must return undefined synchronously");
      }

      if (!db.isTransaction) {
        throw refused("mutation transaction ended before commit");
      }
      db.exec("COMMIT;");
      committed = true;
    } finally {
      if (!committed) {
        try {
          if (db.isTransaction) {
            db.exec("ROLLBACK;");
          }
        } catch {
          // ignore rollback failure to preserve original error
        }
      }
    }
  } finally {
    try {
      db.close();
    } catch {
      // ignore close failure to preserve original error
    }
  }
}

export function finish(path: string, completion: Completion): void {
  const runtimeId = completion.runtimeId;
  const ownerId = completion.ownerId;
  const generation = completion.generation;
  const attemptId = completion.attemptId;
  const wireId = completion.wireId;
  const outcome = completion.outcome;

  if (
    outcome !== "not_sent" &&
    outcome !== "reply_ok" &&
    outcome !== "reply_error"
  ) {
    throw refused("unknown outcome cannot settle a mutation attempt");
  }

  if (
    !isWellFormedString(runtimeId) ||
    !isWellFormedString(ownerId) ||
    !isWellFormedString(attemptId) ||
    !isWellFormedString(wireId) ||
    typeof generation !== "bigint" ||
    generation < MIN_I64 ||
    generation > MAX_I64
  ) {
    throw refused(
      "mutation completion lost its exact owner/request occurrence",
    );
  }

  const db = openExisting(path);
  let committed = false;
  try {
    db.exec("BEGIN IMMEDIATE;");
    try {
      ownerIsCurrent(db, runtimeId);

      const now = getNowSeconds();

      const updateStmt = db.prepare(
        "UPDATE codex_mutation_attempts SET state=?,updated_at=? " +
          "WHERE attempt_id=? AND runtime_id=? AND owner_id=? AND generation=? AND wire_id=? AND state='prepared'",
      );
      const updateResult = updateStmt.run(
        outcome,
        now,
        attemptId,
        runtimeId,
        ownerId,
        generation,
        wireId,
      );
      if (updateResult.changes !== 1 && updateResult.changes !== 1n) {
        throw refused(
          "mutation completion lost its exact owner/request occurrence",
        );
      }

      const retainedStmt = db.prepare(
        "SELECT EXISTS(SELECT 1 FROM codex_mutation_attempts " +
          "WHERE attempt_id=? AND runtime_id=? AND owner_id=? AND generation=? AND wire_id=? AND state=?)",
      );
      retainedStmt.setReadBigInts(true);
      const retainedRow = retainedStmt.get(
        attemptId,
        runtimeId,
        ownerId,
        generation,
        wireId,
        outcome,
      ) as Record<string, unknown> | undefined;
      const retainedVal = retainedRow ? Object.values(retainedRow)[0] : undefined;
      const retained = decodeBool(retainedVal);

      ownerIsCurrent(db, runtimeId);

      if (!retained) {
        throw refused("mutation completion changed before commit");
      }

      // Prune only definite history. Never expire an unknown attempt to make room.
      const pruneStmt = db.prepare(
        "DELETE FROM codex_mutation_attempts WHERE sequence IN " +
          "(SELECT sequence FROM codex_mutation_attempts WHERE state!='prepared' " +
          "ORDER BY updated_at DESC,sequence DESC LIMIT -1 OFFSET ?)",
      );
      pruneStmt.run(MAX_CONFIRMED);

      if (!db.isTransaction) {
        throw refused("mutation transaction ended before commit");
      }
      db.exec("COMMIT;");
      committed = true;
    } finally {
      if (!committed) {
        try {
          if (db.isTransaction) {
            db.exec("ROLLBACK;");
          }
        } catch {
          // ignore rollback failure to preserve original error
        }
      }
    }
  } finally {
    try {
      db.close();
    } catch {
      // ignore close failure to preserve original error
    }
  }
}
