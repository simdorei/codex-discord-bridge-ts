import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import { describe, it } from "node:test";
import { asyncLegacySteerHeldIn } from "../../src/store/async-resolution-legacy-steer.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";

const DDL_QUESTIONS =
  "CREATE TABLE cdr_async_questions (id TEXT, thread_id TEXT, state TEXT, dispatch_mode TEXT);";
const DDL_OBLIGATIONS =
  "CREATE TABLE cdr_async_execution_obligations (question_id TEXT, thread_id TEXT);";

function withDb(fn: (db: DatabaseSync) => void): void {
  const root = realpathSync(tmpdir());
  const dir = mkdtempSync(join(root, "steer-test-"));
  const initialDirRealpath = realpathSync(dir);
  assert.strictEqual(dirname(initialDirRealpath), root);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(initialDirRealpath, "fixture.db"));
    fn(db);
  } finally {
    try {
      if (db?.isOpen) {
        try {
          if (db.isTransaction) {
            try { db.exec("ROLLBACK"); } catch { /* ignore */ }
          }
        } finally {
          db.close();
        }
      }
    } finally {
      const currentRealpath = realpathSync(dir);
      assert.strictEqual(currentRealpath, initialDirRealpath);
      assert.strictEqual(dirname(currentRealpath), root);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

describe("asyncLegacySteerHeldIn leaf", () => {
  it("returns false when questions table is absent before ledger probe, or is a view", () => {
    withDb((db) => {
      db.exec("CREATE TABLE cdr_async_execution_obligations (bad_col TEXT);");
      assert.strictEqual(asyncLegacySteerHeldIn(db, "t1"), false);
    });
    withDb((db) => {
      db.exec("CREATE VIEW cdr_async_questions AS SELECT 'q1' AS id, 't1' AS thread_id, 'dispatching' AS state, 'steer' AS dispatch_mode;");
      assert.strictEqual(asyncLegacySteerHeldIn(db, "t1"), false);
    });
  });

  it("evaluates matching steer question and filters wrong state, mode, thread, case", () => {
    withDb((db) => {
      db.exec(DDL_QUESTIONS);
      db.exec("INSERT INTO cdr_async_questions VALUES ('q1', 't1', 'dispatching', 'steer');");
      assert.strictEqual(asyncLegacySteerHeldIn(db, "t1"), true);
      assert.strictEqual(asyncLegacySteerHeldIn(db, "t2"), false);
      assert.strictEqual(asyncLegacySteerHeldIn(db, "T1"), false);
      db.exec("INSERT INTO cdr_async_questions VALUES ('q2', 't3', 'completed', 'steer');");
      assert.strictEqual(asyncLegacySteerHeldIn(db, "t3"), false);
      db.exec("INSERT INTO cdr_async_questions VALUES ('q3', 't4', 'dispatching', 'start');");
      assert.strictEqual(asyncLegacySteerHeldIn(db, "t4"), false);
    });
  });

  it("handles obligations table absence, view, exact question exclusion, and partial unrecorded", () => {
    withDb((db) => {
      db.exec(DDL_QUESTIONS);
      db.exec("INSERT INTO cdr_async_questions VALUES ('q1', 't1', 'dispatching', 'steer');");
      assert.strictEqual(asyncLegacySteerHeldIn(db, "t1"), true);
      db.exec("CREATE VIEW cdr_async_execution_obligations AS SELECT 'q1' AS question_id, 't1' AS thread_id;");
      assert.strictEqual(asyncLegacySteerHeldIn(db, "t1"), true);
    });
    withDb((db) => {
      db.exec(DDL_QUESTIONS);
      db.exec(DDL_OBLIGATIONS);
      db.exec("INSERT INTO cdr_async_questions VALUES ('q1', 't1', 'dispatching', 'steer');");
      db.exec("INSERT INTO cdr_async_execution_obligations VALUES ('q1', 'other_thread');");
      assert.strictEqual(asyncLegacySteerHeldIn(db, "t1"), false);
      db.exec("INSERT INTO cdr_async_questions VALUES ('q2', 't1', 'dispatching', 'steer');");
      assert.strictEqual(asyncLegacySteerHeldIn(db, "t1"), true);
    });
  });

  it("propagates native SQLite errors when columns are missing or db is closed", () => {
    withDb((db) => {
      db.exec(DDL_QUESTIONS);
      db.exec("CREATE TABLE cdr_async_execution_obligations (wrong_col TEXT);");
      assert.throws(() => asyncLegacySteerHeldIn(db, "t1"), (err) => !(err instanceof StoreIntegrityError) && err instanceof Error);
    });
    withDb((db) => {
      db.exec("CREATE TABLE cdr_async_questions (id TEXT);");
      assert.throws(() => asyncLegacySteerHeldIn(db, "t1"), (err) => !(err instanceof StoreIntegrityError) && err instanceof Error);
    });
    withDb((db) => {
      db.close();
      assert.throws(() => asyncLegacySteerHeldIn(db, "t1"), (err) => !(err instanceof StoreIntegrityError) && err instanceof Error);
    });
  });

  it("accepts empty thread and astral pair, rejects non-string and lone surrogates before SQL", () => {
    withDb((db) => {
      db.exec(DDL_QUESTIONS);
      assert.strictEqual(asyncLegacySteerHeldIn(db, ""), false);
      db.exec("INSERT INTO cdr_async_questions VALUES ('q1', '', 'dispatching', 'steer');");
      assert.strictEqual(asyncLegacySteerHeldIn(db, ""), true);

      const astral = "th-\u{1F600}";
      db.exec(`INSERT INTO cdr_async_questions VALUES ('q2', '${astral}', 'dispatching', 'steer');`);
      assert.strictEqual(asyncLegacySteerHeldIn(db, astral), true);
      assert.strictEqual(asyncLegacySteerHeldIn(db, "incident-reviewed"), false);
    });

    withDb((db) => {
      db.close();
      const invalidInputs: unknown[] = [null, 123, "\uD800", "\uDFFF", "bad\uD800text"];
      for (const input of invalidInputs) {
        assert.throws(
          () => asyncLegacySteerHeldIn(db, input as string),
          { name: "TypeError", message: "Expected a well-formed string" },
        );
      }
    });

    const fakeNoQueryDb = {
      prepare: () => {
        throw new Error("fail: SQL query should not be reached during validation");
      },
    } as unknown as DatabaseSync;
    assert.throws(
      () => asyncLegacySteerHeldIn(fakeNoQueryDb, "\uD800"),
      { name: "TypeError", message: "Expected a well-formed string" },
    );
  });

  it("observes caller uncommitted transaction and preserves caller transaction state", () => {
    withDb((db) => {
      db.exec(DDL_QUESTIONS);
      db.exec("BEGIN");
      assert.strictEqual(db.isTransaction, true);
      db.exec("INSERT INTO cdr_async_questions VALUES ('q1', 't1', 'dispatching', 'steer');");
      assert.strictEqual(asyncLegacySteerHeldIn(db, "t1"), true);
      assert.strictEqual(db.isTransaction, true);
      db.exec("ROLLBACK");
      assert.strictEqual(db.isTransaction, false);
      assert.strictEqual(asyncLegacySteerHeldIn(db, "t1"), false);
    });
  });

  it("remains usable and succeeds when PRAGMA query_only is enabled", () => {
    withDb((db) => {
      db.exec(DDL_QUESTIONS);
      db.exec("INSERT INTO cdr_async_questions VALUES ('q1', 't1', 'dispatching', 'steer');");
      db.exec("PRAGMA query_only = ON;");
      assert.strictEqual(asyncLegacySteerHeldIn(db, "t1"), true);
      assert.strictEqual(asyncLegacySteerHeldIn(db, "t2"), false);
    });
  });

  it("verifies StrictBigInt real statement and handles fake DB contracts", () => {
    withDb((db) => {
      const stmt = db.prepare("SELECT EXISTS(SELECT 1) AS held;");
      stmt.setReadBigInts(true);
      const row = stmt.get() as { held: unknown };
      assert.strictEqual(typeof row.held, "bigint");
      assert.strictEqual(row.held, 1n);
    });

    let readBigIntsFlag = false;
    const fakeDbFlagSet = {
      prepare: () => ({
        setReadBigInts: (f: boolean) => { readBigIntsFlag = f; },
        get: () => ({ held: 1n }),
      } as unknown as StatementSync),
    } as unknown as DatabaseSync;
    assert.strictEqual(asyncLegacySteerHeldIn(fakeDbFlagSet, "t1"), true);
    assert.strictEqual(readBigIntsFlag, true);

    const fakeGet = (getVal: () => unknown) => ({
      prepare: () => ({ setReadBigInts: () => {}, get: getVal } as unknown as StatementSync),
    } as unknown as DatabaseSync);

    assert.throws(
      () => asyncLegacySteerHeldIn(fakeGet(() => undefined), "t1"),
      (err) => err instanceof StoreIntegrityError && err.message === "SQLite integrity check failed: Expected integer EXISTS result",
    );
    assert.throws(
      () => asyncLegacySteerHeldIn(fakeGet(() => ({ held: 1 })), "t1"),
      (err) => err instanceof StoreIntegrityError && err.message === "SQLite integrity check failed: Expected integer EXISTS result",
    );

    let count = 0;
    const fakeDb2n = fakeGet(() => {
      count++;
      return count === 1 ? { held: 1n } : count === 2 ? { held: 0n } : { held: 2n };
    });
    assert.strictEqual(asyncLegacySteerHeldIn(fakeDb2n, "t1"), true);
  });

  it("propagates prepare error unchanged (labeled: not a real SQL claim)", () => {
    const sentinel = new Error("sentinel error identity");
    const fakeDb = {
      prepare: () => {
        throw sentinel;
      },
    } as unknown as DatabaseSync;
    assert.throws(
      () => asyncLegacySteerHeldIn(fakeDb, "t1"),
      (err: unknown) => err === sentinel,
    );
  });
});
