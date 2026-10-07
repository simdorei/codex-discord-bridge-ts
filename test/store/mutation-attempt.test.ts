import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";
import { afterEach, describe, it } from "node:test";

import { sha256SerdeValue } from "../../src/core/serde-json.ts";
import { openExisting } from "../../src/store/existing-store.ts";
import {
  activate,
  begin,
  beginChecked,
  check,
  finish,
  ownerIsCurrent,
  unblocked,
  type Completion,
  type NewAttempt,
} from "../../src/store/mutation-attempt.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";

const __filename = fileURLToPath(import.meta.url);

if (!isMainThread) {
  const { dbPath, attemptId, barrierBuffer } = workerData as {
    dbPath: string;
    attemptId: string;
    barrierBuffer: SharedArrayBuffer;
  };
  const barrier = new Int32Array(barrierBuffer);
  parentPort?.postMessage("ready");
  Atomics.wait(barrier, 0, 0, 10_000);
  try {
    begin(dbPath, {
      runtimeId: "runtime-a",
      ownerId: "instance-a",
      generation: 1n,
      attemptId,
      wireId: attemptId,
      method: "thread/settings/update",
      targetThreadId: "A",
      scoped: true,
      payload: null,
    });
    parentPort?.postMessage("success");
  } catch {
    parentPort?.postMessage("error");
  }
  process.exit(0);
}

const MAX_I64 = 9223372036854775807n;

const trackedTempDirs: string[] = [];
const trackedDbHandles: DatabaseSync[] = [];
const trackedWorkers: Worker[] = [];

const SYSTEM_TMP = resolve(realpathSync(tmpdir()));

function createTempFixtureDir(): string {
  const dir = mkdtempSync(join(SYSTEM_TMP, "cdr-ts-mutation-"));
  const resolved = resolve(realpathSync(dir));
  trackedTempDirs.push(resolved);
  return resolved;
}

function openTrackedDb(path: string): DatabaseSync {
  const db = openExisting(path);
  trackedDbHandles.push(db);
  return db;
}

function safeRemoveTempDir(dir: string): void {
  const resolved = resolve(dir);
  const parent = resolve(dirname(resolved));
  const base = basename(resolved);
  const isTmpParent =
    parent === SYSTEM_TMP || parent.toLowerCase() === SYSTEM_TMP.toLowerCase();

  if (isTmpParent && base.startsWith("cdr-ts-mutation-")) {
    rmSync(resolved, { recursive: true, force: true });
  } else {
    throw new Error(
      `Refusing to remove directory outside expected tmpdir pattern: ${resolved}`,
    );
  }
}

async function fixture(): Promise<{ tempDir: string; dbPath: string }> {
  const tempDir = createTempFixtureDir();
  const dbPath = join(tempDir, "state.sqlite");
  await activate(dbPath, "runtime-a");
  return { tempDir, dbPath };
}

function makeAttempt(
  id: string,
  target: string | null = "A",
  overrides: Partial<NewAttempt> = {},
): NewAttempt {
  return {
    runtimeId: "runtime-a",
    ownerId: "instance-a",
    generation: 1n,
    attemptId: id,
    wireId: id,
    method: "thread/settings/update",
    targetThreadId: target,
    scoped: target !== null,
    payload: null,
    ...overrides,
  };
}

function makeCompletion(
  id: string,
  outcome: string = "reply_ok",
  overrides: Partial<Completion> = {},
): Completion {
  return {
    runtimeId: "runtime-a",
    ownerId: "instance-a",
    generation: 1n,
    attemptId: id,
    wireId: id,
    outcome,
    ...overrides,
  };
}

describe("mutation-attempt real transaction test slice", () => {
  afterEach(async () => {
    for (const worker of trackedWorkers) {
      try {
        await worker.terminate();
      } catch {
        // ignore worker termination failure on cleanup
      }
    }
    trackedWorkers.length = 0;

    for (const db of trackedDbHandles) {
      try {
        db.close();
      } catch {
        // ignore close error on cleanup
      }
    }
    trackedDbHandles.length = 0;

    for (const dir of trackedTempDirs) {
      safeRemoveTempDir(dir);
    }
    trackedTempDirs.length = 0;
  });

  it("mutation_attempt_scope_exact_completion_and_duplicate_cas", async () => {
    const { dbPath } = await fixture();
    begin(dbPath, makeAttempt("a", "A"));
    assert.throws(() => check(dbPath, "runtime-a", "A"), StoreIntegrityError);
    check(dbPath, "runtime-a", "B");
    begin(dbPath, makeAttempt("b", "B"));

    const badCompletions: Completion[] = [
      makeCompletion("a", "reply_ok", { ownerId: "other" }),
      makeCompletion("a", "reply_ok", { generation: 2n }),
      makeCompletion("a", "reply_ok", { wireId: "new-occurrence" }),
    ];
    for (const bad of badCompletions) {
      assert.throws(() => finish(dbPath, bad), StoreIntegrityError);
    }

    finish(dbPath, makeCompletion("b", "reply_ok"));
    assert.throws(() => check(dbPath, "runtime-a", "A"), StoreIntegrityError);
    check(dbPath, "runtime-a", "B");

    finish(dbPath, makeCompletion("a", "reply_error"));
    assert.throws(
      () => finish(dbPath, makeCompletion("a", "reply_ok")),
      StoreIntegrityError,
    );
    check(dbPath, "runtime-a", "A");

    assert.throws(() => begin(dbPath, makeAttempt("a", "new-target")), (err) => {
      return err instanceof Error;
    });
  });

  it("mutation_attempt_cold_owner_never_clears_or_finishes_old_attempt", async () => {
    const { dbPath } = await fixture();
    begin(dbPath, makeAttempt("a", "A"));
    await activate(dbPath, "runtime-new");

    assert.throws(
      () => finish(dbPath, makeCompletion("a", "reply_ok")),
      StoreIntegrityError,
    );
    assert.throws(
      () => check(dbPath, "runtime-new", "A"),
      StoreIntegrityError,
    );
    check(dbPath, "runtime-new", "B");
    assert.throws(
      () => check(dbPath, "runtime-a", "B"),
      StoreIntegrityError,
    );

    const db = openTrackedDb(dbPath);
    const row = db
      .prepare(
        "SELECT state FROM codex_mutation_attempts WHERE attempt_id='a'",
      )
      .get() as { state: string };
    assert.strictEqual(row.state, "prepared");
  });

  it("mutation_attempt_unknown_scope_is_global_and_never_borrows_a_target", async () => {
    const { dbPath } = await fixture();
    begin(dbPath, makeAttempt("a", "A"));

    assert.throws(
      () =>
        begin(
          dbPath,
          makeAttempt("global", null, {
            scoped: false,
            method: "unregistered/mutate",
          }),
        ),
      StoreIntegrityError,
    );

    finish(dbPath, makeCompletion("a", "not_sent"));

    begin(
      dbPath,
      makeAttempt("global", null, {
        scoped: false,
        method: "unregistered/mutate",
      }),
    );

    for (const target of ["A", "B", "C", null]) {
      assert.throws(
        () => check(dbPath, "runtime-a", target),
        StoreIntegrityError,
      );
    }

    assert.throws(
      () => finish(dbPath, makeCompletion("global", "timeout")),
      StoreIntegrityError,
    );
    assert.throws(
      () => finish(dbPath, makeCompletion("global", "unknown")),
      StoreIntegrityError,
    );
  });

  it("mutation_attempt_no_eviction_at_1024_and_confirmed_history_bound_256", async () => {
    const { dbPath } = await fixture();
    begin(dbPath, makeAttempt("unknown", "A"));

    const db = openTrackedDb(dbPath);
    db.exec(
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1023) " +
        "INSERT INTO codex_mutation_attempts(attempt_id,runtime_id,owner_id,generation,wire_id,method," +
        "target_thread_id,scoped,request_sha256,state,created_at,updated_at) " +
        "SELECT 'held-'||x,'runtime-a','instance-a',1,'wire-'||x,'thread/settings/update'," +
        "'target-'||x,1,'fixture','prepared',0,0 FROM n;",
    );

    assert.throws(
      () => begin(dbPath, makeAttempt("overflow", "B")),
      StoreIntegrityError,
    );

    const pendingStmt = db.prepare(
      "SELECT count(*) AS count FROM codex_mutation_attempts WHERE state='prepared'",
    );
    pendingStmt.setReadBigInts(true);
    let pending = (pendingStmt.get() as { count: bigint }).count;
    assert.strictEqual(pending, 1024n);

    db.exec(
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<300) " +
        "INSERT INTO codex_mutation_attempts(attempt_id,runtime_id,owner_id,generation,wire_id,method," +
        "target_thread_id,scoped,request_sha256,state,created_at,updated_at) " +
        "SELECT 'done-'||x,'runtime-a','instance-a',1,'done-wire-'||x,'thread/settings/update'," +
        "'done-target-'||x,1,'fixture','reply_ok',0,0 FROM n;",
    );

    assert.throws(
      () => finish(dbPath, makeCompletion("held-1", "not_sent")),
      StoreIntegrityError,
    );
    finish(dbPath, makeCompletion("held-1", "not_sent", { wireId: "wire-1" }));

    const confirmedStmt = db.prepare(
      "SELECT count(*) AS count FROM codex_mutation_attempts WHERE state!='prepared'",
    );
    confirmedStmt.setReadBigInts(true);
    const confirmed = (confirmedStmt.get() as { count: bigint }).count;
    assert.strictEqual(confirmed, 256n);

    assert.throws(() => check(dbPath, "runtime-a", "A"), StoreIntegrityError);

    pending = (pendingStmt.get() as { count: bigint }).count;
    assert.strictEqual(pending, 1023n);
  });

  it("mutation_attempt_insert_ignore_or_removed_claim_never_grants_dispatch", async () => {
    const triggers = [
      "CREATE TRIGGER fail BEFORE INSERT ON codex_mutation_attempts BEGIN SELECT RAISE(IGNORE); END;",
      "CREATE TRIGGER fail AFTER INSERT ON codex_mutation_attempts BEGIN DELETE FROM codex_mutation_attempts WHERE attempt_id=NEW.attempt_id; END;",
      "CREATE TRIGGER fail AFTER INSERT ON codex_mutation_attempts BEGIN UPDATE codex_mutation_runtime SET runtime_id='other'; END;",
      "CREATE TRIGGER fail AFTER INSERT ON codex_mutation_attempts BEGIN UPDATE codex_mutation_attempts SET owner_id='tampered' WHERE attempt_id=NEW.attempt_id; END;",
      "CREATE TRIGGER fail AFTER INSERT ON codex_mutation_attempts BEGIN UPDATE codex_mutation_attempts SET generation=NEW.generation+1 WHERE attempt_id=NEW.attempt_id; END;",
      "CREATE TRIGGER fail AFTER INSERT ON codex_mutation_attempts BEGIN UPDATE codex_mutation_attempts SET wire_id='tampered' WHERE attempt_id=NEW.attempt_id; END;",
      "CREATE TRIGGER fail AFTER INSERT ON codex_mutation_attempts BEGIN UPDATE codex_mutation_attempts SET method='tampered' WHERE attempt_id=NEW.attempt_id; END;",
      "CREATE TRIGGER fail AFTER INSERT ON codex_mutation_attempts BEGIN UPDATE codex_mutation_attempts SET target_thread_id='tampered' WHERE attempt_id=NEW.attempt_id; END;",
      "CREATE TRIGGER fail AFTER INSERT ON codex_mutation_attempts BEGIN UPDATE codex_mutation_attempts SET request_sha256='tampered' WHERE attempt_id=NEW.attempt_id; END;",
    ];

    for (const trigger of triggers) {
      const { dbPath } = await fixture();
      const db = openTrackedDb(dbPath);
      db.exec(trigger);
      db.close();

      assert.throws(
        () => begin(dbPath, makeAttempt("a", "A")),
        StoreIntegrityError,
      );

      const verifyDb = openTrackedDb(dbPath);
      ownerIsCurrent(verifyDb, "runtime-a");
      const countStmt = verifyDb.prepare(
        "SELECT count(*) AS count FROM codex_mutation_attempts",
      );
      countStmt.setReadBigInts(true);
      assert.strictEqual((countStmt.get() as { count: bigint }).count, 0n);
      verifyDb.close();
    }
  });

  it("mutation_attempt_failed_completion_rolls_back_and_prepared_retained", async () => {
    const triggers = [
      "CREATE TRIGGER fail AFTER UPDATE ON codex_mutation_attempts BEGIN DELETE FROM codex_mutation_attempts WHERE attempt_id=NEW.attempt_id; END;",
      "CREATE TRIGGER fail AFTER UPDATE ON codex_mutation_attempts BEGIN UPDATE codex_mutation_attempts SET owner_id='tampered' WHERE attempt_id=NEW.attempt_id; END;",
      "CREATE TRIGGER fail AFTER UPDATE ON codex_mutation_attempts BEGIN UPDATE codex_mutation_runtime SET runtime_id='other'; END;",
    ];

    for (const trigger of triggers) {
      const { dbPath } = await fixture();
      begin(dbPath, makeAttempt("a", "A"));

      const db = openTrackedDb(dbPath);
      db.exec(trigger);
      db.close();

      assert.throws(
        () => finish(dbPath, makeCompletion("a", "reply_ok")),
        StoreIntegrityError,
      );
      assert.throws(
        () => check(dbPath, "runtime-a", "A"),
        StoreIntegrityError,
      );

      const verifyDb = openTrackedDb(dbPath);
      ownerIsCurrent(verifyDb, "runtime-a");
      const stmt = verifyDb.prepare(
        "SELECT state, owner_id FROM codex_mutation_attempts WHERE attempt_id='a'",
      );
      const row = stmt.get() as { state: string; owner_id: string };
      assert.strictEqual(row.state, "prepared");
      assert.strictEqual(row.owner_id, "instance-a");
      verifyDb.close();
    }
  });

  it("mutation_attempt_absent_store_fails_closed_without_create", async () => {
    const { tempDir, dbPath } = await fixture();
    const missing = join(tempDir, "missing.sqlite");

    assert.throws(() => check(missing, "runtime-a", "A"));
    assert.strictEqual(existsSync(missing), false);

    assert.throws(() => begin(missing, makeAttempt("a", "A")));
    assert.strictEqual(existsSync(missing), false);

    assert.throws(() => finish(missing, makeCompletion("a", "reply_ok")));
    assert.strictEqual(existsSync(missing), false);

    const db = openTrackedDb(dbPath);
    db.exec("DELETE FROM codex_mutation_runtime;");
    db.close();
    assert.throws(() => check(dbPath, "runtime-a", "B"), StoreIntegrityError);
  });

  it("mutation_attempt_golden_vector_sha_and_bigint_generation", async () => {
    const { dbPath } = await fixture();
    const goldenPayload = {
      "2": 2n,
      "10": 10n,
      z: { b: 2n, a: 1n },
      id: 9007199254740993n,
      f: 1.0,
    };
    const expectedHash =
      "23ef518ed45170de2d7918e7bac16f9e3acdbbfdae3a0707cce7cba63ee7e465";
    const goldenGen = 9007199254740993n;

    assert.strictEqual(sha256SerdeValue(goldenPayload), expectedHash);

    begin(
      dbPath,
      makeAttempt("golden", "A", {
        generation: goldenGen,
        payload: goldenPayload,
      }),
    );

    const db = openTrackedDb(dbPath);
    const stmt = db.prepare(
      "SELECT * FROM codex_mutation_attempts WHERE attempt_id='golden'",
    );
    stmt.setReadBigInts(true);
    const row = stmt.get() as Record<string, unknown>;
    assert.strictEqual(row.request_sha256, expectedHash);
    assert.strictEqual(row.generation, goldenGen);
    assert.strictEqual("payload" in row, false);
    assert.strictEqual("raw_payload" in row, false);

    const colNames = (
      db.prepare("PRAGMA table_info('codex_mutation_attempts')").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    assert.ok(colNames.includes("request_sha256"));
    assert.ok(!colNames.includes("payload"));
    assert.ok(!colNames.includes("raw_payload"));
    db.close();

    assert.throws(
      () =>
        finish(
          dbPath,
          makeCompletion("golden", "reply_ok", {
            generation: goldenGen - 1n,
          }),
        ),
      StoreIntegrityError,
    );
    assert.throws(
      () =>
        finish(
          dbPath,
          makeCompletion("golden", "reply_ok", {
            generation: goldenGen + 1n,
          }),
        ),
      StoreIntegrityError,
    );

    finish(
      dbPath,
      makeCompletion("golden", "reply_ok", { generation: goldenGen }),
    );

    const verifyDb = openTrackedDb(dbPath);
    const finalState = verifyDb
      .prepare(
        "SELECT state FROM codex_mutation_attempts WHERE attempt_id='golden'",
      )
      .get() as { state: string };
    assert.strictEqual(finalState.state, "reply_ok");
    verifyDb.close();
  });

  it("mutation_attempt_input_boundaries_and_unicode_nel_whitespace", async () => {
    const { tempDir, dbPath } = await fixture();

    const nel = "\u0085";
    const nelPath = join(tempDir, "nel.sqlite");
    await assert.rejects(() => activate(nelPath, nel), StoreIntegrityError);
    assert.strictEqual(existsSync(nelPath), false);

    assert.throws(
      () => begin(dbPath, makeAttempt("nel-runtime", "A", { runtimeId: nel })),
      StoreIntegrityError,
    );
    assert.throws(
      () => begin(dbPath, makeAttempt("nel-owner", "A", { ownerId: nel })),
      StoreIntegrityError,
    );
    assert.throws(() => begin(dbPath, makeAttempt(nel, "A")), StoreIntegrityError);
    assert.throws(
      () => begin(dbPath, makeAttempt("nel-wire", "A", { wireId: nel })),
      StoreIntegrityError,
    );
    assert.throws(
      () => begin(dbPath, makeAttempt("nel-method", "A", { method: nel })),
      StoreIntegrityError,
    );
    assert.throws(
      () =>
        begin(dbPath, makeAttempt("nel-target", "A", { targetThreadId: nel })),
      StoreIntegrityError,
    );

    const bom = "\uFEFF";
    const bomDbPath = join(tempDir, "bom.sqlite");
    await activate(bomDbPath, bom);
    assert.strictEqual(existsSync(bomDbPath), true);
    begin(bomDbPath, {
      runtimeId: bom,
      ownerId: bom,
      generation: 1n,
      attemptId: "bom-attempt",
      wireId: bom,
      method: bom,
      targetThreadId: bom,
      scoped: true,
      payload: null,
    });
    assert.throws(() => check(bomDbPath, bom, bom), StoreIntegrityError);

    assert.throws(
      () => begin(dbPath, makeAttempt("gen-0", "A", { generation: 0n })),
      StoreIntegrityError,
    );
    assert.throws(
      () => begin(dbPath, makeAttempt("gen-neg", "A", { generation: -1n })),
      StoreIntegrityError,
    );
    assert.throws(
      () =>
        begin(
          dbPath,
          makeAttempt("gen-num", "A", {
            generation: 1 as unknown as bigint,
          }),
        ),
      StoreIntegrityError,
    );
    assert.throws(
      () =>
        begin(dbPath, makeAttempt("gen-over", "A", { generation: MAX_I64 + 1n })),
      StoreIntegrityError,
    );

    begin(dbPath, makeAttempt("gen-max", "A-max", { generation: MAX_I64 }));

    const boundaryDb = openTrackedDb(dbPath);
    boundaryDb.exec(
      "INSERT INTO codex_mutation_attempts(attempt_id,runtime_id,owner_id,generation,wire_id,method,target_thread_id,scoped,request_sha256,state,created_at,updated_at) VALUES " +
        "('signed-gen-0','runtime-a','instance-a',0,'wire-sg-0','thread/settings/update','target-sg-0',1,'sha-sg-0','prepared',0,0)," +
        "('signed-gen-neg','runtime-a','instance-a',-1,'wire-sg-neg','thread/settings/update','target-sg-neg',1,'sha-sg-neg','prepared',0,0)," +
        "('signed-gen-min','runtime-a','instance-a',-9223372036854775808,'wire-sg-min','thread/settings/update','target-sg-min',1,'sha-sg-min','prepared',0,0);",
    );

    assert.throws(
      () =>
        finish(
          dbPath,
          makeCompletion("signed-gen-min", "not_sent", {
            generation: 1n,
            wireId: "wire-sg-min",
          }),
        ),
      StoreIntegrityError,
    );
    finish(
      dbPath,
      makeCompletion("signed-gen-min", "not_sent", {
        generation: -9223372036854775808n,
        wireId: "wire-sg-min",
      }),
    );

    const minStmt = boundaryDb.prepare(
      "SELECT generation, state FROM codex_mutation_attempts WHERE attempt_id='signed-gen-min'",
    );
    minStmt.setReadBigInts(true);
    const minRow = minStmt.get() as { generation: bigint; state: string };
    assert.strictEqual(minRow.generation, -9223372036854775808n);
    assert.strictEqual(minRow.state, "not_sent");
    boundaryDb.close();

    assert.throws(
      () => begin(dbPath, makeAttempt("sc-null", null, { scoped: true })),
      StoreIntegrityError,
    );
    assert.throws(
      () => begin(dbPath, makeAttempt("sc-empty", "")),
      StoreIntegrityError,
    );
    assert.throws(
      () => begin(dbPath, makeAttempt("sc-nel", " \u0085 ")),
      StoreIntegrityError,
    );
    assert.throws(
      () =>
        begin(
          dbPath,
          makeAttempt("sc-bad", null, {
            scoped: false,
            targetThreadId: 123 as unknown as string,
          }),
        ),
      StoreIntegrityError,
    );

    const absentPath = join(tempDir, "nonexistent-target.sqlite");
    assert.throws(
      () =>
        begin(
          absentPath,
          makeAttempt("fail-closed", "A", { generation: 0n }),
        ),
      StoreIntegrityError,
    );
    assert.strictEqual(existsSync(absentPath), false);
  });

  it("mutation_attempt_critical_checked_admission_authority", async () => {
    const { dbPath } = await fixture();
    const db = openTrackedDb(dbPath);
    db.exec(
      "CREATE TABLE admission_authority (" +
        "revision INTEGER NOT NULL," +
        "runtime_id TEXT NOT NULL," +
        "owner_id TEXT NOT NULL," +
        "generation INTEGER NOT NULL," +
        "wire_id TEXT NOT NULL," +
        "target_thread_id TEXT NOT NULL" +
        "); " +
        "INSERT INTO admission_authority(revision, runtime_id, owner_id, generation, wire_id, target_thread_id) " +
        "VALUES (100, 'runtime-a', 'instance-a', 1, 'wire-admit-1', 'A');",
    );

    const originalSeal = Object.freeze({
      revision: 100n,
      runtimeId: "runtime-a",
      ownerId: "instance-a",
      generation: 1n,
      wireId: "wire-admit-1",
      targetThreadId: "A",
    });

    let firstConnection: DatabaseSync | null = null;
    let callbackCalls = 0;
    const authorityCheck = (checkDb: DatabaseSync): undefined => {
      callbackCalls++;
      if (!firstConnection) {
        firstConnection = checkDb;
      }
      assert.strictEqual(checkDb, firstConnection);
      assert.strictEqual(checkDb.isTransaction, true);
      const stmt = checkDb.prepare(
        "SELECT revision, runtime_id, owner_id, generation, wire_id, target_thread_id FROM admission_authority",
      );
      stmt.setReadBigInts(true);
      const row = stmt.get() as {
        revision: bigint;
        runtime_id: string;
        owner_id: string;
        generation: bigint;
        wire_id: string;
        target_thread_id: string;
      };
      if (
        row.revision !== originalSeal.revision ||
        row.runtime_id !== originalSeal.runtimeId ||
        row.owner_id !== originalSeal.ownerId ||
        row.generation !== originalSeal.generation ||
        row.wire_id !== originalSeal.wireId ||
        row.target_thread_id !== originalSeal.targetThreadId
      ) {
        throw new StoreIntegrityError(
          "admission authority check failed: seal mismatch",
        );
      }
      return undefined;
    };

    db.exec(
      "CREATE TRIGGER tamper_revision AFTER INSERT ON codex_mutation_attempts " +
        "BEGIN UPDATE admission_authority SET revision = revision + 1; END;",
    );
    db.close();

    const admitAttempt = makeAttempt("admit-1", "A", { wireId: "wire-admit-1" });
    assert.throws(
      () => beginChecked(dbPath, admitAttempt, authorityCheck),
      (err) =>
        err instanceof StoreIntegrityError &&
        err.message.includes("admission authority check failed"),
    );
    assert.strictEqual(callbackCalls, 2);

    const verifyDb = openTrackedDb(dbPath);
    const revStmt = verifyDb.prepare(
      "SELECT revision FROM admission_authority",
    );
    revStmt.setReadBigInts(true);
    assert.strictEqual((revStmt.get() as { revision: bigint }).revision, 100n);

    const countStmt = verifyDb.prepare(
      "SELECT count(*) AS count FROM codex_mutation_attempts",
    );
    countStmt.setReadBigInts(true);
    assert.strictEqual((countStmt.get() as { count: bigint }).count, 0n);

    verifyDb.exec("DROP TRIGGER tamper_revision;");

    let firstCalls = 0;
    assert.throws(() => {
      beginChecked(dbPath, makeAttempt("admit-fail-first", "A"), () => {
        firstCalls++;
        throw new Error("abort on first check");
      });
    });
    assert.strictEqual(firstCalls, 1);
    assert.strictEqual((countStmt.get() as { count: bigint }).count, 0n);

    let secondCalls = 0;
    assert.throws(() => {
      beginChecked(dbPath, makeAttempt("admit-fail-second", "A"), (conn) => {
        secondCalls++;
        assert.strictEqual(conn.isTransaction, true);
        if (secondCalls === 2) {
          throw new Error("abort on second check");
        }
        return undefined;
      });
    });
    assert.strictEqual(secondCalls, 2);
    assert.strictEqual((countStmt.get() as { count: bigint }).count, 0n);
    verifyDb.close();
  });

  it("mutation_attempt_callback_mutation_defense_and_sync_undefined", async () => {
    const { dbPath } = await fixture();
    const mutableAttempt: NewAttempt = {
      runtimeId: "runtime-a",
      ownerId: "instance-a",
      generation: 1n,
      attemptId: "mut-attempt",
      wireId: "mut-wire",
      method: "thread/settings/update",
      targetThreadId: "A",
      scoped: true,
      payload: { original: true },
    };

    let checkCalls = 0;
    beginChecked(dbPath, mutableAttempt, (conn) => {
      checkCalls++;
      assert.strictEqual(conn.isTransaction, true);
      mutableAttempt.runtimeId = "runtime-mutated";
      mutableAttempt.ownerId = "owner-mutated";
      mutableAttempt.generation = 999n;
      mutableAttempt.attemptId = "attempt-mutated";
      mutableAttempt.wireId = "wire-mutated";
      mutableAttempt.method = "method-mutated";
      mutableAttempt.targetThreadId = "B";
      mutableAttempt.scoped = false;
      mutableAttempt.payload = { mutated: true };
      return undefined;
    });
    assert.strictEqual(checkCalls, 2);

    const verifyDb = openTrackedDb(dbPath);
    const stmt = verifyDb.prepare(
      "SELECT attempt_id, runtime_id, owner_id, generation, wire_id, method, target_thread_id, scoped, request_sha256 " +
        "FROM codex_mutation_attempts WHERE attempt_id='mut-attempt'",
    );
    stmt.setReadBigInts(true);
    const row = stmt.get() as {
      attempt_id: string;
      runtime_id: string;
      owner_id: string;
      generation: bigint;
      wire_id: string;
      method: string;
      target_thread_id: string;
      scoped: bigint;
      request_sha256: string;
    };
    assert.strictEqual(row.attempt_id, "mut-attempt");
    assert.strictEqual(row.runtime_id, "runtime-a");
    assert.strictEqual(row.owner_id, "instance-a");
    assert.strictEqual(row.generation, 1n);
    assert.strictEqual(row.wire_id, "mut-wire");
    assert.strictEqual(row.method, "thread/settings/update");
    assert.strictEqual(row.target_thread_id, "A");
    assert.strictEqual(row.scoped, 1n);
    assert.strictEqual(row.request_sha256, sha256SerdeValue({ original: true }));

    assert.throws(
      () => {
        beginChecked(
          dbPath,
          makeAttempt("promise-attempt", "B"),
          ((_conn: DatabaseSync) => Promise.resolve(undefined)) as unknown as (
            db: DatabaseSync,
          ) => undefined,
        );
      },
      (err) =>
        err instanceof StoreIntegrityError &&
        err.message.includes(
          "authority check must return undefined synchronously",
        ),
    );

    const promiseRow = verifyDb
      .prepare(
        "SELECT 1 FROM codex_mutation_attempts WHERE attempt_id='promise-attempt'",
      )
      .get();
    assert.strictEqual(promiseRow, undefined);
    verifyDb.close();
  });

  it("mutation_attempt_real_concurrent_same_target_ownership", async () => {
    const { dbPath } = await fixture();
    const barrierBuffer = new SharedArrayBuffer(4);
    const barrier = new Int32Array(barrierBuffer);
    barrier[0] = 0;

    const results: string[] = [];
    let readyCount = 0;

    const createWorker = (attemptId: string): Promise<Worker> => {
      return new Promise((resolveWorker, rejectWorker) => {
        const worker = new Worker(__filename, {
          workerData: { dbPath, attemptId, barrierBuffer },
          execArgv: [],
        });
        trackedWorkers.push(worker);

        worker.on("message", (msg: string) => {
          if (msg === "ready") {
            readyCount++;
            if (readyCount === 2) {
              Atomics.store(barrier, 0, 1);
              Atomics.notify(barrier, 0, 2);
            }
          } else if (msg === "success" || msg === "error") {
            results.push(msg);
          }
        });

        worker.on("error", (err) => {
          rejectWorker(err);
        });

        worker.on("exit", () => {
          resolveWorker(worker);
        });
      });
    };

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Worker test timeout after 10000ms")),
        10_000,
      );
      timer.unref();
    });

    try {
      await Promise.race([
        Promise.all([
          createWorker("worker-attempt-1"),
          createWorker("worker-attempt-2"),
        ]),
        timeoutPromise,
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }

    assert.strictEqual(readyCount, 2);
    assert.strictEqual(results.length, 2);
    const successes = results.filter((r) => r === "success").length;
    const errors = results.filter((r) => r === "error").length;

    assert.strictEqual(successes, 1);
    assert.strictEqual(errors, 1);

    const verifyDb = openTrackedDb(dbPath);
    const countStmt = verifyDb.prepare(
      "SELECT count(*) AS count FROM codex_mutation_attempts WHERE state='prepared' AND target_thread_id='A'",
    );
    countStmt.setReadBigInts(true);
    assert.strictEqual((countStmt.get() as { count: bigint }).count, 1n);
    verifyDb.close();
  });

  it("mutation_attempt_extension_migration_preserves_prior_queue_and_payload_privacy", async () => {
    const { dbPath } = await fixture();
    const db = openTrackedDb(dbPath);
    db.exec(
      "CREATE TABLE fixture_marker(value TEXT); " +
        "INSERT INTO fixture_marker VALUES('unchanged'); " +
        "DROP TABLE codex_mutation_attempts; " +
        "DROP TABLE codex_mutation_runtime;",
    );
    db.close();

    await activate(dbPath, "runtime-a");

    const payload = { input: "private fixture prompt" };
    begin(
      dbPath,
      makeAttempt("a", "A", {
        payload,
      }),
    );

    const verifyDb = openTrackedDb(dbPath);
    const marker = verifyDb
      .prepare("SELECT value FROM fixture_marker")
      .get() as { value: string };
    assert.strictEqual(marker.value, "unchanged");

    const row = verifyDb
      .prepare(
        "SELECT request_sha256 FROM codex_mutation_attempts WHERE attempt_id='a'",
      )
      .get() as { request_sha256: string };
    assert.strictEqual(row.request_sha256.length, 64);
    assert.strictEqual(row.request_sha256.includes("private fixture"), false);
    verifyDb.close();
  });

  it("mutation_attempt_utf8_well_formed_identities_and_surrogate_rejection", async () => {
    const { tempDir, dbPath } = await fixture();

    const invalidHighRuntime = "runtime-\uD800";
    const absentHighPath = join(tempDir, "absent-high.sqlite");
    await assert.rejects(
      () => activate(absentHighPath, invalidHighRuntime),
      StoreIntegrityError,
    );
    assert.strictEqual(existsSync(absentHighPath), false);

    const invalidLowRuntime = "runtime-\uDC00";
    const absentLowPath = join(tempDir, "absent-low.sqlite");
    await assert.rejects(
      () => activate(absentLowPath, invalidLowRuntime),
      StoreIntegrityError,
    );
    assert.strictEqual(existsSync(absentLowPath), false);

    const loneSurrogates = ["\uD800", "\uDC00"];
    for (const bad of loneSurrogates) {
      const attemptsToTest: NewAttempt[] = [
        makeAttempt("bad-runtime", "A", { runtimeId: `runtime-${bad}` }),
        makeAttempt("bad-owner", "A", { ownerId: `owner-${bad}` }),
        makeAttempt(`attempt-${bad}`, "A"),
        makeAttempt("bad-wire", "A", { wireId: `wire-${bad}` }),
        makeAttempt("bad-method", "A", { method: `method-${bad}` }),
        makeAttempt("bad-target-scoped", `target-${bad}`, { scoped: true }),
        makeAttempt("bad-target-unscoped", `target-${bad}`, { scoped: false }),
      ];

      for (const attempt of attemptsToTest) {
        let callbackCalled = false;
        assert.throws(
          () =>
            beginChecked(dbPath, attempt, () => {
              callbackCalled = true;
              return undefined;
            }),
          StoreIntegrityError,
        );
        assert.strictEqual(callbackCalled, false);
      }
    }

    const verifyDb = openTrackedDb(dbPath);
    const countStmt = verifyDb.prepare(
      "SELECT count(*) AS count FROM codex_mutation_attempts WHERE state='prepared'",
    );
    countStmt.setReadBigInts(true);
    assert.strictEqual((countStmt.get() as { count: bigint }).count, 0n);

    const astralChar = "\uD83D\uDE00";
    const literalReplacement = "\uFFFD";

    const astralAttempt = makeAttempt(
      `astral-${astralChar}`,
      `target-${astralChar}`,
      {
        ownerId: `owner-${astralChar}`,
        wireId: `wire-${astralChar}`,
        method: `method/${astralChar}`,
      },
    );
    begin(dbPath, astralAttempt);

    finish(
      dbPath,
      makeCompletion(`astral-${astralChar}`, "reply_ok", {
        ownerId: `owner-${astralChar}`,
        wireId: `wire-${astralChar}`,
      }),
    );

    const astralStmt = verifyDb.prepare(
      "SELECT state FROM codex_mutation_attempts WHERE attempt_id=?",
    );
    assert.strictEqual(
      (astralStmt.get(`astral-${astralChar}`) as { state: string }).state,
      "reply_ok",
    );

    const literalAttempt = makeAttempt(
      `literal-${literalReplacement}`,
      `target-${literalReplacement}`,
      {
        ownerId: `owner-${literalReplacement}`,
        wireId: `wire-${literalReplacement}`,
        method: `method/${literalReplacement}`,
      },
    );
    begin(dbPath, literalAttempt);

    assert.throws(
      () =>
        finish(
          dbPath,
          makeCompletion(`literal-${literalReplacement}`, "reply_ok", {
            ownerId: `owner-${astralChar}`,
            wireId: `wire-${literalReplacement}`,
          }),
        ),
      StoreIntegrityError,
    );
    assert.throws(
      () =>
        finish(
          dbPath,
          makeCompletion(`literal-${literalReplacement}`, "reply_ok", {
            ownerId: `owner-${literalReplacement}`,
            wireId: "wire-mismatch",
          }),
        ),
      StoreIntegrityError,
    );

    const literalStmt = verifyDb.prepare(
      "SELECT state FROM codex_mutation_attempts WHERE attempt_id=?",
    );
    assert.strictEqual(
      (literalStmt.get(`literal-${literalReplacement}`) as { state: string })
        .state,
      "prepared",
    );

    finish(
      dbPath,
      makeCompletion(`literal-${literalReplacement}`, "reply_ok", {
        ownerId: `owner-${literalReplacement}`,
        wireId: `wire-${literalReplacement}`,
      }),
    );
    assert.strictEqual(
      (literalStmt.get(`literal-${literalReplacement}`) as { state: string })
        .state,
      "reply_ok",
    );

    const legitAttempt = makeAttempt(
      `legit-${literalReplacement}`,
      "target-legit",
      {
        ownerId: `owner-${literalReplacement}`,
        wireId: `wire-${literalReplacement}`,
      },
    );
    begin(dbPath, legitAttempt);

    for (const badSurrogate of loneSurrogates) {
      assert.throws(
        () =>
          finish(
            dbPath,
            makeCompletion(`legit-${literalReplacement}`, "reply_ok", {
              ownerId: `owner-${badSurrogate}`,
              wireId: `wire-${literalReplacement}`,
            }),
          ),
        StoreIntegrityError,
      );
      assert.throws(
        () =>
          finish(
            dbPath,
            makeCompletion(`legit-${badSurrogate}`, "reply_ok", {
              ownerId: `owner-${literalReplacement}`,
              wireId: `wire-${literalReplacement}`,
            }),
          ),
        StoreIntegrityError,
      );
      assert.throws(
        () =>
          finish(
            dbPath,
            makeCompletion(`legit-${literalReplacement}`, "reply_ok", {
              ownerId: `owner-${literalReplacement}`,
              wireId: `wire-${badSurrogate}`,
            }),
          ),
        StoreIntegrityError,
      );
    }

    const legitStmt = verifyDb.prepare(
      "SELECT state, owner_id, wire_id FROM codex_mutation_attempts WHERE attempt_id=?",
    );
    const legitRow = legitStmt.get(`legit-${literalReplacement}`) as {
      state: string;
      owner_id: string;
      wire_id: string;
    };
    assert.strictEqual(legitRow.state, "prepared");
    assert.strictEqual(legitRow.owner_id, `owner-${literalReplacement}`);
    assert.strictEqual(legitRow.wire_id, `wire-${literalReplacement}`);

    finish(
      dbPath,
      makeCompletion(`legit-${literalReplacement}`, "reply_ok", {
        ownerId: `owner-${literalReplacement}`,
        wireId: `wire-${literalReplacement}`,
      }),
    );
    const legitRowAfter = legitStmt.get(`legit-${literalReplacement}`) as {
      state: string;
    };
    assert.strictEqual(legitRowAfter.state, "reply_ok");

    begin(
      dbPath,
      makeAttempt("held-literal", `target-${literalReplacement}`),
    );

    verifyDb.exec("BEGIN;");
    assert.strictEqual(verifyDb.isTransaction, true);

    for (const badSurrogate of loneSurrogates) {
      assert.throws(
        () => unblocked(verifyDb, `target-${badSurrogate}`),
        (err) =>
          err instanceof StoreIntegrityError &&
          err.message.includes("invalid mutation attempt identity"),
      );
      assert.strictEqual(verifyDb.isTransaction, true);

      assert.throws(
        () => check(dbPath, "runtime-a", `target-${badSurrogate}`),
        (err) =>
          err instanceof StoreIntegrityError &&
          err.message.includes("invalid mutation attempt identity"),
      );
      assert.strictEqual(verifyDb.isTransaction, true);
    }

    verifyDb.exec("COMMIT;");
    assert.strictEqual(verifyDb.isTransaction, false);

    check(dbPath, "runtime-a", "unrelated-target");
    assert.throws(
      () => check(dbPath, "runtime-a", `target-${literalReplacement}`),
      StoreIntegrityError,
    );

    finish(
      dbPath,
      makeCompletion("held-literal", "reply_ok"),
    );

    check(dbPath, "runtime-a", null);
    check(dbPath, "runtime-a", "");
    unblocked(verifyDb, "");

    for (const badSurrogate of loneSurrogates) {
      assert.throws(
        () => ownerIsCurrent(verifyDb, `runtime-${badSurrogate}`),
        StoreIntegrityError,
      );
      assert.throws(
        () => check(dbPath, `runtime-${badSurrogate}`, "unrelated-target"),
        StoreIntegrityError,
      );
    }

    verifyDb.close();
  });

  describe("corrupt_runtimeUTF8", () => {
    it("rejects invalid UTF-8 bytes and non-TEXT runtime, preserves raw bytes, and preserves caller transactions", async () => {
      const { dbPath } = await fixture();
      const validWithReplacement = "bad\uFFFD";
      await activate(dbPath, validWithReplacement);

      const corruptDb = openTrackedDb(dbPath);
      corruptDb.exec(
        "UPDATE codex_mutation_runtime SET runtime_id = CAST(X'62616480' AS TEXT) WHERE singleton=1;",
      );
      corruptDb.close();

      const probeDb = openTrackedDb(dbPath);
      assert.throws(
        () => ownerIsCurrent(probeDb, validWithReplacement),
        StoreIntegrityError,
      );
      probeDb.close();

      assert.throws(
        () => check(dbPath, validWithReplacement),
        StoreIntegrityError,
      );

      assert.throws(
        () =>
          begin(
            dbPath,
            makeAttempt("attempt-corrupt", "A", {
              runtimeId: validWithReplacement,
            }),
          ),
        StoreIntegrityError,
      );

      let authorityCalled = false;
      assert.throws(
        () =>
          beginChecked(
            dbPath,
            makeAttempt("attempt-checked-corrupt", "A", {
              runtimeId: validWithReplacement,
            }),
            () => {
              authorityCalled = true;
              return undefined;
            },
          ),
        StoreIntegrityError,
      );
      assert.strictEqual(authorityCalled, false);

      const verifyDb = openTrackedDb(dbPath);
      const countStmt = verifyDb.prepare(
        "SELECT count(*) AS count FROM codex_mutation_attempts WHERE state='prepared'",
      );
      countStmt.setReadBigInts(true);
      const countRow = countStmt.get() as { count: bigint } | undefined;
      assert.strictEqual(countRow?.count, 0n);

      const hexStmt = verifyDb.prepare(
        "SELECT hex(CAST(runtime_id AS BLOB)) AS hex_bytes FROM codex_mutation_runtime WHERE singleton=1",
      );
      const hexRow = hexStmt.get() as { hex_bytes: string } | undefined;
      assert.strictEqual(hexRow?.hex_bytes.toUpperCase(), "62616480");
      verifyDb.close();

      const f2 = await fixture();
      await activate(f2.dbPath, validWithReplacement);
      begin(
        f2.dbPath,
        makeAttempt("prep-legit", "A", {
          runtimeId: validWithReplacement,
        }),
      );

      const corruptDb2 = openTrackedDb(f2.dbPath);
      corruptDb2.exec(
        "UPDATE codex_mutation_runtime SET runtime_id = CAST(X'62616480' AS TEXT) WHERE singleton=1;",
      );
      corruptDb2.close();

      assert.throws(
        () =>
          finish(
            f2.dbPath,
            makeCompletion("prep-legit", "reply_ok", {
              runtimeId: validWithReplacement,
            }),
          ),
        StoreIntegrityError,
      );

      const verifyDb2 = openTrackedDb(f2.dbPath);
      const prepStmt = verifyDb2.prepare(
        "SELECT state FROM codex_mutation_attempts WHERE attempt_id='prep-legit'",
      );
      const prepRow = prepStmt.get() as { state: string } | undefined;
      assert.strictEqual(prepRow?.state, "prepared");
      verifyDb2.close();

      const malformedHexes = ["80", "C2", "EDA080", "C080"];
      for (const hex of malformedHexes) {
        const fBad = await fixture();
        const badDb = openTrackedDb(fBad.dbPath);
        badDb.exec(
          `UPDATE codex_mutation_runtime SET runtime_id = CAST(X'${hex}' AS TEXT) WHERE singleton=1;`,
        );
        const row = badDb
          .prepare(
            "SELECT runtime_id FROM codex_mutation_runtime WHERE singleton=1",
          )
          .get() as { runtime_id: string } | undefined;
        assert.strictEqual(typeof row?.runtime_id, "string");
        const nativeDecoded = row?.runtime_id as string;
        assert.throws(
          () => ownerIsCurrent(badDb, nativeDecoded),
          StoreIntegrityError,
        );
        badDb.close();
        assert.throws(
          () => check(fBad.dbPath, nativeDecoded),
          StoreIntegrityError,
        );
      }

      const fValid = await fixture();
      const literalWithReplacement = "runtime-\uFFFD";
      await activate(fValid.dbPath, literalWithReplacement);
      const validDb = openTrackedDb(fValid.dbPath);
      ownerIsCurrent(validDb, literalWithReplacement);
      const hexReplacementStmt = validDb.prepare(
        "SELECT hex(CAST(runtime_id AS BLOB)) AS hex_bytes FROM codex_mutation_runtime WHERE singleton=1",
      );
      const hexReplacementRow = hexReplacementStmt.get() as
        | { hex_bytes: string }
        | undefined;
      assert.strictEqual(
        hexReplacementRow?.hex_bytes.includes("EFBFBD"),
        true,
      );

      const astralRuntime = "runtime-\uD83D\uDE00";
      await activate(fValid.dbPath, astralRuntime);
      ownerIsCurrent(validDb, astralRuntime);

      const bomRuntime = "\uFEFFruntime-bom";
      await activate(fValid.dbPath, bomRuntime);
      ownerIsCurrent(validDb, bomRuntime);

      validDb.exec(
        "UPDATE codex_mutation_runtime SET runtime_id = CAST(X'62616480' AS TEXT) WHERE singleton=1;",
      );
      assert.throws(
        () => ownerIsCurrent(validDb, bomRuntime),
        StoreIntegrityError,
      );
      validDb.close();

      await activate(fValid.dbPath, "runtime-healthy");
      const healthyDb = openTrackedDb(fValid.dbPath);
      ownerIsCurrent(healthyDb, "runtime-healthy");
      healthyDb.close();

      const fBlob = await fixture();
      const blobDb = openTrackedDb(fBlob.dbPath);
      blobDb.exec(
        "UPDATE codex_mutation_runtime SET runtime_id = X'616263' WHERE singleton=1;",
      );
      assert.throws(
        () => ownerIsCurrent(blobDb, "abc"),
        StoreIntegrityError,
      );

      blobDb.exec("BEGIN;");
      assert.strictEqual(blobDb.isTransaction, true);
      assert.throws(
        () => ownerIsCurrent(blobDb, "runtime-a"),
        StoreIntegrityError,
      );
      assert.strictEqual(blobDb.isTransaction, true);
      const probeStmt = blobDb.prepare("SELECT 1 AS probe");
      const probeRow = probeStmt.get() as { probe: number } | undefined;
      assert.strictEqual(probeRow?.probe, 1);
      blobDb.exec("ROLLBACK;");
      assert.strictEqual(blobDb.isTransaction, false);
      blobDb.close();
    });
  });
});
