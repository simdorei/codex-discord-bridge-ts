import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";
import {
  REVIEWED_INCIDENT_THREAD,
  asyncRecoveryPolicyHeldIn,
} from "../../src/store/async-resolution-policy.ts";

function withTestDb(run: (db: DatabaseSync, dbPath: string, testDir: string) => void): void {
  const origRoot = fs.realpathSync(os.tmpdir());
  const tempDir = fs.mkdtempSync(path.join(origRoot, "cdr-policy-test-"));
  const initialDirRealpath = fs.realpathSync(tempDir);
  assert.equal(path.dirname(initialDirRealpath), origRoot);
  const dbPath = path.join(initialDirRealpath, `db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    run(db, dbPath, initialDirRealpath);
  } finally {
    try {
      db?.close();
    } finally {
      const currentDirRealpath = fs.realpathSync(tempDir);
      assert.equal(currentDirRealpath, initialDirRealpath);
      assert.equal(path.dirname(currentDirRealpath), origRoot);
      fs.rmSync(currentDirRealpath, { recursive: true, force: true });
    }
  }
}

test("REVIEWED_INCIDENT_THREAD matches exact frozen literal", () => {
  assert.equal(REVIEWED_INCIDENT_THREAD, "01a06156-56cd-70b0-af02-2de7445ba4c7");
});

test("exact incident holds unconditionally on absent table, missing column, view, and closed db", () => {
  withTestDb((db, _dbPath, testDir) => {
    // 1. Absent table
    assert.equal(asyncRecoveryPolicyHeldIn(db, REVIEWED_INCIDENT_THREAD), true);

    // 2. Missing thread_id column
    db.exec("CREATE TABLE cdr_async_recovery_policies (other_col TEXT)");
    assert.equal(asyncRecoveryPolicyHeldIn(db, REVIEWED_INCIDENT_THREAD), true);

    // 3. View in place of table
    db.exec("DROP TABLE cdr_async_recovery_policies");
    db.exec("CREATE VIEW cdr_async_recovery_policies AS SELECT 1 AS dummy");
    assert.equal(asyncRecoveryPolicyHeldIn(db, REVIEWED_INCIDENT_THREAD), true);

    // 4. Closed handle shows no db access
    const closedDb = new DatabaseSync(path.join(testDir, "closed-incident.db"));
    closedDb.close();
    assert.equal(asyncRecoveryPolicyHeldIn(closedDb, REVIEWED_INCIDENT_THREAD), true);
  });
});

test("unrelated thread returns false on absent table and view", () => {
  withTestDb((db) => {
    const thread = "unrelated-thread-001";
    assert.equal(asyncRecoveryPolicyHeldIn(db, thread), false);

    db.exec("CREATE VIEW cdr_async_recovery_policies AS SELECT 'unrelated-thread-001' AS thread_id");
    assert.equal(asyncRecoveryPolicyHeldIn(db, thread), false);
  });
});

test("matching row returns true regardless of bogus registration fields; different thread and case variant false", () => {
  withTestDb((db) => {
    db.exec(`CREATE TABLE cdr_async_recovery_policies (
      thread_id TEXT,
      format_version INTEGER,
      policy TEXT,
      bogus_extra TEXT
    )`);
    db.prepare(`INSERT INTO cdr_async_recovery_policies (thread_id, format_version, policy, bogus_extra)
      VALUES (?, ?, ?, ?)`).run("target-held", 9999, "bogus_policy_name", "bogus_value");

    assert.equal(asyncRecoveryPolicyHeldIn(db, "target-held"), true);
    assert.equal(asyncRecoveryPolicyHeldIn(db, "target-other"), false);
    assert.equal(asyncRecoveryPolicyHeldIn(db, "TARGET-HELD"), false);

    const incidentUpper = REVIEWED_INCIDENT_THREAD.toUpperCase();
    assert.equal(asyncRecoveryPolicyHeldIn(db, incidentUpper), false);
  });
});

test("empty thread accepted: false with absent table, true when matching row present", () => {
  withTestDb((db) => {
    assert.equal(asyncRecoveryPolicyHeldIn(db, ""), false);

    db.exec("CREATE TABLE cdr_async_recovery_policies (thread_id TEXT)");
    db.prepare("INSERT INTO cdr_async_recovery_policies (thread_id) VALUES (?)").run("");
    assert.equal(asyncRecoveryPolicyHeldIn(db, ""), true);
  });
});

test("valid astral surrogate pair is accepted and matches row", () => {
  withTestDb((db) => {
    const astralThread = "thread-🚀-𐍈";
    db.exec("CREATE TABLE cdr_async_recovery_policies (thread_id TEXT)");
    assert.equal(asyncRecoveryPolicyHeldIn(db, astralThread), false);

    db.prepare("INSERT INTO cdr_async_recovery_policies (thread_id) VALUES (?)").run(astralThread);
    assert.equal(asyncRecoveryPolicyHeldIn(db, astralThread), true);
  });
});

test("lone surrogates and non-strings rejected with TypeError before db access", () => {
  withTestDb((_db, _dbPath, testDir) => {
    const closedDb = new DatabaseSync(path.join(testDir, "closed-reject.db"));
    closedDb.close();

    const invalidInputs: unknown[] = [
      "\uD800",
      "\uDFFF",
      "\uDC00",
      "prefix\uD800suffix",
      `${REVIEWED_INCIDENT_THREAD}\uD800`,
      `\uD800${REVIEWED_INCIDENT_THREAD.slice(1)}`,
      12345,
      null,
      undefined,
      {},
      true,
    ];

    for (const input of invalidInputs) {
      assert.throws(
        () => asyncRecoveryPolicyHeldIn(closedDb, input as string),
        TypeError,
      );
    }
  });
});

test("SQL errors propagate natively from missing thread column and closed db, not StoreIntegrityError", () => {
  withTestDb((db, _dbPath, testDir) => {
    db.exec("CREATE TABLE cdr_async_recovery_policies (unrelated_col TEXT)");
    assert.throws(
      () => asyncRecoveryPolicyHeldIn(db, "unrelated-thread"),
      (err: unknown) => err instanceof Error && !(err instanceof StoreIntegrityError),
    );

    const closedDb = new DatabaseSync(path.join(testDir, "closed-err.db"));
    closedDb.close();
    assert.throws(
      () => asyncRecoveryPolicyHeldIn(closedDb, "unrelated-thread"),
      (err: unknown) => err instanceof Error && !(err instanceof StoreIntegrityError),
    );
  });
});

test("narrow instrumented proof: exists() throws StoreIntegrityError on malformed row shape", () => {
  // Narrow instrumented mock clearly labeled: simulates non-bigint / undefined from statement.get
  const malformedDb = {
    prepare(_sql: string) {
      return {
        setReadBigInts(_enabled: boolean) {},
        get(_param: unknown) {
          return { held: "not-a-bigint" };
        },
      };
    },
  } as unknown as DatabaseSync;

  assert.throws(
    () => asyncRecoveryPolicyHeldIn(malformedDb, "unrelated-thread"),
    StoreIntegrityError,
  );

  const undefinedRowDb = {
    prepare(_sql: string) {
      return {
        setReadBigInts(_enabled: boolean) {},
        get(_param: unknown) {
          return undefined;
        },
      };
    },
  } as unknown as DatabaseSync;

  assert.throws(
    () => asyncRecoveryPolicyHeldIn(undefinedRowDb, "unrelated-thread"),
    StoreIntegrityError,
  );
});

test("caller transaction uncommitted row is visible, transaction preserved without implicit commit, rollback possible", () => {
  withTestDb((db) => {
    db.exec("CREATE TABLE cdr_async_recovery_policies (thread_id TEXT)");
    const getSchemaVersion = () =>
      Number((db.prepare("PRAGMA schema_version").get() as { schema_version: number | bigint }).schema_version);
    const initialSchemaVersion = getSchemaVersion();

    db.exec("BEGIN");
    try {
      assert.equal(db.isTransaction, true);
      db.prepare("INSERT INTO cdr_async_recovery_policies (thread_id) VALUES (?)").run("tx-thread");

      // Visible to predicate within uncommitted transaction
      assert.equal(asyncRecoveryPolicyHeldIn(db, "tx-thread"), true);
      // Predicate preserved transaction state (no commit/abort)
      assert.equal(db.isTransaction, true);

      // Caller rollback remains possible
      db.exec("ROLLBACK");
      assert.equal(db.isTransaction, false);

      // After rollback, row is not present
      assert.equal(asyncRecoveryPolicyHeldIn(db, "tx-thread"), false);

      // Schema version remained identical; no writes or schema changes by predicate
      assert.equal(getSchemaVersion(), initialSchemaVersion);

      // db remains open and usable
      const row = db.prepare("SELECT 1 AS alive").get() as { alive: number | bigint };
      assert.equal(Number(row.alive), 1);
    } finally {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
    }
  });
});
