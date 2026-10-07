import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { I64_MAX, I64_MIN } from "../../src/protocol/ids.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";
import {
  generationIsSealedIn,
  jobCanMutate,
  targetIsHeldIn,
} from "../../src/store/dead-generation-admission.ts";
import {
  EXECUTION_HOLD_PREFIX,
  LEGACY_RESERVE_HOLD_PREFIX,
  holdIn,
  legacyOrCurrentError,
  reasonIn,
  requireUnheldIn,
} from "../../src/store/execution-hold.ts";
import type { QueueJobState, StoredQueueJob } from "../../src/store/queue-read.ts";

const DEAD_GENERATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS codex_app_server_runtime (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), runtime_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS codex_dead_generation_incidents (
    runtime_id TEXT NOT NULL, generation INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL, queue_jobs_json TEXT NOT NULL,
    created_at REAL NOT NULL, PRIMARY KEY(runtime_id, generation));
CREATE TABLE IF NOT EXISTS codex_dead_generation_holds (
    target_thread_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL,
    generation INTEGER NOT NULL, created_at REAL NOT NULL);
`;

const EXECUTION_HOLD_SCHEMA = `
CREATE TABLE IF NOT EXISTS cdr_execution_holds (
    job_id TEXT PRIMARY KEY, target_thread_id TEXT NOT NULL,
    reason TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at REAL NOT NULL
);
`;

function createStoredQueueJob(
  overrides: Partial<StoredQueueJob> = {},
): StoredQueueJob {
  const defaultState: QueueJobState = "Pending";
  return {
    jobId: overrides.jobId ?? "job-default-1",
    targetThreadId: overrides.targetThreadId ?? "target-default-1",
    channelId: overrides.channelId ?? 1001n,
    ownerUserId: overrides.ownerUserId ?? null,
    discordMessageId: overrides.discordMessageId ?? null,
    appServerGeneration: overrides.appServerGeneration ?? 1n,
    executionGeneration: overrides.executionGeneration ?? null,
    turnObservationGeneration: overrides.turnObservationGeneration ?? null,
    goalWaiting: overrides.goalWaiting ?? false,
    prompt: overrides.prompt ?? "test prompt",
    queued: overrides.queued ?? true,
    ackSent: overrides.ackSent ?? false,
    state: overrides.state ?? defaultState,
    attemptCount: overrides.attemptCount ?? 0n,
    turnId: overrides.turnId ?? null,
    baselineTurnIds: overrides.baselineTurnIds ?? [],
    lastError: overrides.lastError ?? "",
    createdAt: overrides.createdAt ?? 1700000000,
    updatedAt: overrides.updatedAt ?? 1700000000,
  };
}

test("targetIsHeldIn: target held vs missing", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(DEAD_GENERATION_SCHEMA);

  assert.equal(targetIsHeldIn(db, "target-1"), false);

  db.prepare(
    "INSERT INTO codex_dead_generation_holds (target_thread_id, runtime_id, generation, created_at) VALUES (?, ?, ?, ?)",
  ).run("target-1", "run-1", 1, 1000.0);

  assert.equal(targetIsHeldIn(db, "target-1"), true);
  assert.equal(targetIsHeldIn(db, "target-2"), false);
  db.close();
});

test("targetIsHeldIn and jobCanMutate: held target shortcircuits with missing runtime/incident tables", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE codex_dead_generation_holds (target_thread_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL, generation INTEGER NOT NULL, created_at REAL NOT NULL);",
  );

  db.prepare(
    "INSERT INTO codex_dead_generation_holds (target_thread_id, runtime_id, generation, created_at) VALUES (?, ?, ?, ?)",
  ).run("thread-held-1", "run-1", 1, 1000.0);

  assert.equal(targetIsHeldIn(db, "thread-held-1"), true);
  assert.equal(targetIsHeldIn(db, "thread-unheld-1"), false);

  const heldJob = createStoredQueueJob({
    targetThreadId: "thread-held-1",
    appServerGeneration: 10n,
  });
  assert.equal(jobCanMutate(db, heldJob), false);

  const unheldJob = createStoredQueueJob({
    targetThreadId: "thread-unheld-1",
    appServerGeneration: 10n,
  });
  assert.throws(() => jobCanMutate(db, unheldJob));
  db.close();
});

test("generationIsSealedIn: singleton 1 join, old runtime ignored, absent runtime returns false", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(DEAD_GENERATION_SCHEMA);

  db.prepare(
    "INSERT INTO codex_dead_generation_incidents (runtime_id, generation, snapshot_json, queue_jobs_json, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("old-runtime-id", 42, "{}", "[]", 1.0);

  assert.equal(generationIsSealedIn(db, 42n), false);

  db.prepare(
    "INSERT INTO codex_app_server_runtime (singleton, runtime_id) VALUES (1, ?)",
  ).run("active-runtime-id");

  assert.equal(generationIsSealedIn(db, 42n), false);

  db.prepare(
    "INSERT INTO codex_dead_generation_incidents (runtime_id, generation, snapshot_json, queue_jobs_json, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("active-runtime-id", 42, "{}", "[]", 2.0);

  assert.equal(generationIsSealedIn(db, 42n), true);
  assert.equal(generationIsSealedIn(db, 999n), false);

  db.prepare(
    "UPDATE codex_app_server_runtime SET runtime_id = ? WHERE singleton = 1",
  ).run("new-runtime-id");
  assert.equal(generationIsSealedIn(db, 42n), false);
  db.close();
});

test("generationIsSealedIn: signed i64 min/max, negative, zero, and 9007199254740993 adjacent distinction", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(DEAD_GENERATION_SCHEMA);

  db.prepare(
    "INSERT INTO codex_app_server_runtime (singleton, runtime_id) VALUES (1, ?)",
  ).run("run-main");

  const insertIncident = db.prepare(
    "INSERT INTO codex_dead_generation_incidents (runtime_id, generation, snapshot_json, queue_jobs_json, created_at) VALUES ('run-main', ?, '{}', '[]', 1.0)",
  );

  insertIncident.run(I64_MIN);
  insertIncident.run(I64_MAX);
  insertIncident.run(-100n);
  insertIncident.run(0n);
  insertIncident.run(9007199254740993n);

  assert.equal(generationIsSealedIn(db, I64_MIN), true);
  assert.equal(generationIsSealedIn(db, I64_MIN + 1n), false);
  assert.equal(generationIsSealedIn(db, I64_MAX), true);
  assert.equal(generationIsSealedIn(db, I64_MAX - 1n), false);
  assert.equal(generationIsSealedIn(db, -100n), true);
  assert.equal(generationIsSealedIn(db, -101n), false);
  assert.equal(generationIsSealedIn(db, 0n), true);
  assert.equal(generationIsSealedIn(db, 1n), false);
  assert.equal(generationIsSealedIn(db, 9007199254740993n), true);
  assert.equal(generationIsSealedIn(db, 9007199254740992n), false);

  assert.throws(
    () => (generationIsSealedIn as unknown as (d: unknown, g: unknown) => unknown)(db, 100),
    StoreIntegrityError,
  );
  assert.throws(
    () => (generationIsSealedIn as unknown as (d: unknown, g: unknown) => unknown)(db, "100"),
    StoreIntegrityError,
  );
  assert.throws(
    () => (generationIsSealedIn as unknown as (d: unknown, g: unknown) => unknown)(db, null),
    StoreIntegrityError,
  );
  assert.throws(
    () => (generationIsSealedIn as unknown as (d: unknown, g: unknown) => unknown)(db, undefined),
    StoreIntegrityError,
  );
  assert.throws(
    () => generationIsSealedIn(db, I64_MAX + 1n),
    StoreIntegrityError,
  );
  assert.throws(
    () => generationIsSealedIn(db, I64_MIN - 1n),
    StoreIntegrityError,
  );
  db.close();
});

test("jobCanMutate: all four combinations and non-object validation", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(DEAD_GENERATION_SCHEMA);

  db.prepare(
    "INSERT INTO codex_app_server_runtime (singleton, runtime_id) VALUES (1, ?)",
  ).run("run-1");
  db.prepare(
    "INSERT INTO codex_dead_generation_holds (target_thread_id, runtime_id, generation, created_at) VALUES ('thread-held', 'run-1', 1, 1000.0)",
  ).run();
  db.prepare(
    "INSERT INTO codex_dead_generation_incidents (runtime_id, generation, snapshot_json, queue_jobs_json, created_at) VALUES ('run-1', 42, '{}', '[]', 1.0)",
  ).run();

  const heldAndSealed = createStoredQueueJob({
    targetThreadId: "thread-held",
    appServerGeneration: 42n,
  });
  assert.equal(jobCanMutate(db, heldAndSealed), false);

  const heldAndUnsealed = createStoredQueueJob({
    targetThreadId: "thread-held",
    appServerGeneration: 99n,
  });
  assert.equal(jobCanMutate(db, heldAndUnsealed), false);

  const unheldAndSealed = createStoredQueueJob({
    targetThreadId: "thread-unheld",
    appServerGeneration: 42n,
  });
  assert.equal(jobCanMutate(db, unheldAndSealed), false);

  const unheldAndUnsealed = createStoredQueueJob({
    targetThreadId: "thread-unheld",
    appServerGeneration: 99n,
  });
  assert.equal(jobCanMutate(db, unheldAndUnsealed), true);

  assert.throws(
    () => (jobCanMutate as unknown as (d: unknown, j: unknown) => unknown)(db, null),
    StoreIntegrityError,
  );
  assert.throws(
    () => (jobCanMutate as unknown as (d: unknown, j: unknown) => unknown)(db, undefined),
    StoreIntegrityError,
  );
  assert.throws(
    () => (jobCanMutate as unknown as (d: unknown, j: unknown) => unknown)(db, "string"),
    StoreIntegrityError,
  );
  db.close();
});

test("holdIn: INSERT OR IGNORE custody, invalid JSON accepted, no overwrite", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(EXECUTION_HOLD_SCHEMA);

  holdIn(db, "job-1", "target-initial", "initial reason", "{not-valid-json");
  assert.equal(reasonIn(db, "job-1"), "initial reason");

  holdIn(db, "job-1", "target-overwrite", "overwrite reason", '{"valid":true}');
  assert.equal(reasonIn(db, "job-1"), "initial reason");

  const row = db.prepare(
    "SELECT target_thread_id, evidence_json FROM cdr_execution_holds WHERE job_id = ?",
  ).get("job-1") as { target_thread_id: string; evidence_json: string } | undefined;
  assert.ok(row);
  assert.equal(row.target_thread_id, "target-initial");
  assert.equal(row.evidence_json, "{not-valid-json");
  db.close();
});

test("caller BEGIN/ROLLBACK and pending reads ownership", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(EXECUTION_HOLD_SCHEMA);

  db.exec("BEGIN");
  holdIn(db, "job-rollback", "target-1", "reason-rollback", "{}");
  assert.equal(reasonIn(db, "job-rollback"), "reason-rollback");
  db.exec("ROLLBACK");
  assert.equal(reasonIn(db, "job-rollback"), null);

  db.exec("BEGIN");
  holdIn(db, "job-commit", "target-2", "reason-commit", "{}");
  assert.equal(reasonIn(db, "job-commit"), "reason-commit");
  db.exec("COMMIT");
  assert.equal(reasonIn(db, "job-commit"), "reason-commit");
  db.close();
});

test("missing reason null vs empty reason throws prefix and exact diagnostic", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(EXECUTION_HOLD_SCHEMA);

  assert.equal(reasonIn(db, "job-missing"), null);
  assert.doesNotThrow(() => requireUnheldIn(db, "job-missing"));

  holdIn(db, "job-empty", "target-empty", "", "{}");
  assert.equal(reasonIn(db, "job-empty"), "");

  assert.throws(
    () => requireUnheldIn(db, "job-empty"),
    (err: unknown) => {
      assert.ok(err instanceof StoreIntegrityError);
      const expected = new StoreIntegrityError(`${EXECUTION_HOLD_PREFIX}`).message;
      assert.equal(err.message, expected);
      return true;
    },
  );

  holdIn(db, "job-nonempty", "target-ne", "disk quota exceeded", "{}");
  assert.throws(
    () => requireUnheldIn(db, "job-nonempty"),
    (err: unknown) => {
      assert.ok(err instanceof StoreIntegrityError);
      const expected = new StoreIntegrityError(
        `${EXECUTION_HOLD_PREFIX}disk quota exceeded`,
      ).message;
      assert.equal(err.message, expected);
      return true;
    },
  );
  db.close();
});

test("legacyOrCurrentError: start of string prefix, case, space, empty, and boundaries", () => {
  assert.equal(legacyOrCurrentError(`${EXECUTION_HOLD_PREFIX}test reason`), true);
  assert.equal(legacyOrCurrentError(`${LEGACY_RESERVE_HOLD_PREFIX}test reason`), true);
  assert.equal(legacyOrCurrentError(EXECUTION_HOLD_PREFIX), true);
  assert.equal(legacyOrCurrentError(LEGACY_RESERVE_HOLD_PREFIX), true);

  assert.equal(legacyOrCurrentError(`prefix ${EXECUTION_HOLD_PREFIX}`), false);
  assert.equal(legacyOrCurrentError("[CDR-RUST:EXECUTION-HELD:V1] msg"), false);
  assert.equal(legacyOrCurrentError("[CDR-RUST:AUTO-RESERVE-HOLD:V1] msg"), false);
  assert.equal(legacyOrCurrentError("[cdr-rust:execution-held:v1]msg"), false);
  assert.equal(legacyOrCurrentError(" [cdr-rust:execution-held:v1] msg"), false);
  assert.equal(legacyOrCurrentError("[cdr-rust:auto-reserve-hold:v1]msg"), false);
  assert.equal(legacyOrCurrentError(""), false);
  assert.equal(legacyOrCurrentError("arbitrary error string"), false);
});

test("reasonIn: BOM, NUL, Korean, emoji preservation, malformed UTF-8 rejection, and nonstring rejection", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(EXECUTION_HOLD_SCHEMA);

  const specialText = "\uFEFF\0한글과 이모지 🚀✨\r\nLine2\tTab";
  holdIn(db, "job-special", "target-1", specialText, "{}");
  assert.equal(reasonIn(db, "job-special"), specialText);

  db.prepare(
    "INSERT INTO cdr_execution_holds (job_id, target_thread_id, reason, evidence_json, created_at) VALUES ('job-bad-utf8', 'target-1', CAST(? AS TEXT), '{}', 1.0)",
  ).run(new Uint8Array([0xff, 0xfe, 0xfd]));

  assert.throws(
    () => reasonIn(db, "job-bad-utf8"),
    (err: unknown) => {
      assert.ok(err instanceof StoreIntegrityError);
      assert.match(err.message, /Invalid text encoding in column reason/);
      return true;
    },
  );

  db.prepare(
    "INSERT INTO cdr_execution_holds (job_id, target_thread_id, reason, evidence_json, created_at) VALUES ('job-blob-reason', 'target-1', ?, '{}', 1.0)",
  ).run(new Uint8Array([1, 2, 3, 4]));
  const typeRow = db.prepare(
    "SELECT typeof(reason) AS physical_type FROM cdr_execution_holds WHERE job_id = 'job-blob-reason'",
  ).get() as { physical_type: string } | undefined;
  assert.ok(typeRow);
  assert.equal(typeRow.physical_type, "blob");

  assert.throws(
    () => reasonIn(db, "job-blob-reason"),
    (err: unknown) => {
      assert.ok(err instanceof StoreIntegrityError);
      assert.match(err.message, /Expected string for column reason/);
      return true;
    },
  );

  assert.throws(
    () => {
      db.prepare(
        "INSERT INTO cdr_execution_holds (job_id, target_thread_id, reason, evidence_json, created_at) VALUES ('job-null-reason', 'target-1', NULL, '{}', 1.0)",
      ).run();
    },
    /NOT NULL/i,
  );
  assert.equal(reasonIn(db, "job-null-reason"), null);
  db.close();
});

test("valid UTF-16LE and UTF-16BE databases with BOM, NUL, and emoji", () => {
  const dbLe = new DatabaseSync(":memory:");
  dbLe.exec("PRAGMA encoding = 'UTF-16le';");
  const encLe = dbLe.prepare("PRAGMA encoding").get() as Record<string, unknown> | undefined;
  assert.ok(encLe);
  assert.equal(encLe["encoding"], "UTF-16le");
  dbLe.exec(EXECUTION_HOLD_SCHEMA);

  const textLe = "\uFEFF\0한국어 UTF-16LE 🎯✨";
  holdIn(dbLe, "job-le", "target-le", textLe, "{}");
  assert.equal(reasonIn(dbLe, "job-le"), textLe);
  dbLe.close();

  const dbBe = new DatabaseSync(":memory:");
  dbBe.exec("PRAGMA encoding = 'UTF-16be';");
  const encBe = dbBe.prepare("PRAGMA encoding").get() as Record<string, unknown> | undefined;
  assert.ok(encBe);
  assert.equal(encBe["encoding"], "UTF-16be");
  dbBe.exec(EXECUTION_HOLD_SCHEMA);

  const textBe = "\uFEFF\0대한민국 UTF-16BE 🌟🔥";
  holdIn(dbBe, "job-be", "target-be", textBe, "{}");
  assert.equal(reasonIn(dbBe, "job-be"), textBe);
  dbBe.close();
});

test("input guards reject invalid UTF-16 and non-string before touching closed connection", () => {
  const closedDb = new DatabaseSync(":memory:");
  closedDb.close();

  assert.throws(() => targetIsHeldIn(closedDb, "\uD800"), StoreIntegrityError);
  assert.throws(
    () => (targetIsHeldIn as unknown as (d: unknown, t: unknown) => unknown)(closedDb, 123),
    StoreIntegrityError,
  );

  assert.throws(() => reasonIn(closedDb, "\uD800"), StoreIntegrityError);
  assert.throws(
    () => (reasonIn as unknown as (d: unknown, id: unknown) => unknown)(closedDb, null),
    StoreIntegrityError,
  );

  assert.throws(() => requireUnheldIn(closedDb, "\uDFFF"), StoreIntegrityError);
  assert.throws(
    () => (requireUnheldIn as unknown as (d: unknown, id: unknown) => unknown)(closedDb, undefined),
    StoreIntegrityError,
  );

  assert.throws(() => holdIn(closedDb, "\uD800", "t", "r", "e"), StoreIntegrityError);
  assert.throws(() => holdIn(closedDb, "id", "\uD800", "r", "e"), StoreIntegrityError);
  assert.throws(() => holdIn(closedDb, "id", "t", "\uD800", "e"), StoreIntegrityError);
  assert.throws(() => holdIn(closedDb, "id", "t", "r", "\uD800"), StoreIntegrityError);
  assert.throws(
    () => (holdIn as unknown as (d: unknown, ...args: unknown[]) => unknown)(closedDb, null, "t", "r", "e"),
    StoreIntegrityError,
  );
  assert.throws(
    () => (holdIn as unknown as (d: unknown, ...args: unknown[]) => unknown)(closedDb, "id", null, "r", "e"),
    StoreIntegrityError,
  );
  assert.throws(
    () => (holdIn as unknown as (d: unknown, ...args: unknown[]) => unknown)(closedDb, "id", "t", null, "e"),
    StoreIntegrityError,
  );
  assert.throws(
    () => (holdIn as unknown as (d: unknown, ...args: unknown[]) => unknown)(closedDb, "id", "t", "r", null),
    StoreIntegrityError,
  );

  assert.throws(() => legacyOrCurrentError("\uD800"), StoreIntegrityError);
  assert.throws(
    () => (legacyOrCurrentError as unknown as (e: unknown) => unknown)(123),
    StoreIntegrityError,
  );

  assert.throws(
    () => (generationIsSealedIn as unknown as (d: unknown, g: unknown) => unknown)(closedDb, 123),
    StoreIntegrityError,
  );
  assert.throws(
    () => generationIsSealedIn(closedDb, I64_MAX + 1n),
    StoreIntegrityError,
  );
});
