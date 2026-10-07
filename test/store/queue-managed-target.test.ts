import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { I64_MAX, I64_MIN } from "../../src/protocol/ids.ts";
import { openInitialized } from "../../src/store/owned-driver.ts";
import {
  InvalidAppServerManagedTarget,
  InvalidAppServerManagedTargetError,
  SystemTime,
  SystemTimeError,
  containsManagedTargetIn,
  ensureManagedTargetTableIn,
  markAppServerManagedTarget,
  markManagedTargetIn,
} from "../../src/store/queue-managed-target.ts";

/**
 * Test fixture allocating an isolated temporary directory and initialized store.
 * Guaranteed to close db and remove directory in finally block even on assertion failures.
 */
async function fixture(
  run: (path: string, db: DatabaseSync) => Promise<void> | void,
): Promise<void> {
  const root = resolve(realpathSync(tmpdir()));
  const dir = mkdtempSync(join(root, "cdr-ts-queue-managed-target-"));
  const path = join(dir, "store.sqlite");
  const db = await openInitialized(path);
  try {
    await run(path, db);
  } finally {
    try {
      db.close();
    } catch {
      // ignore close failure
    }
    const actual = resolve(realpathSync(dir));
    assert.equal(actual.toLowerCase(), resolve(dir).toLowerCase());
    assert.equal(dirname(actual).toLowerCase(), root.toLowerCase());
    rmSync(actual, { recursive: true, force: true });
  }
}

/**
 * Directory fixture without pre-opening a connection,
 * for testing owned connection lifecycle and error paths before file creation.
 */
async function dirFixture(
  run: (path: string, dir: string) => Promise<void> | void,
): Promise<void> {
  const root = resolve(realpathSync(tmpdir()));
  const dir = mkdtempSync(join(root, "cdr-ts-queue-managed-target-dir-"));
  const path = join(dir, "store.sqlite");
  try {
    await run(path, dir);
  } finally {
    const actual = resolve(realpathSync(dir));
    assert.equal(actual.toLowerCase(), resolve(dir).toLowerCase());
    assert.equal(dirname(actual).toLowerCase(), root.toLowerCase());
    rmSync(actual, { recursive: true, force: true });
  }
}

test("error classes export exact naming, kinds, and prototype hierarchy", () => {
  assert.equal(InvalidAppServerManagedTarget, InvalidAppServerManagedTargetError);
  assert.equal(SystemTime, SystemTimeError);

  const targetErr = new InvalidAppServerManagedTargetError("sample-target");
  assert.equal(targetErr.name, "InvalidAppServerManagedTargetError");
  assert.equal(targetErr.kind, "InvalidAppServerManagedTarget");
  assert.equal(
    targetErr.message,
    "invalid direct app-server managed target: sample-target",
  );
  assert.ok(targetErr instanceof Error);
  assert.ok(targetErr instanceof InvalidAppServerManagedTargetError);

  const sysErrNum = new SystemTimeError(42.5);
  assert.equal(sysErrNum.name, "SystemTimeError");
  assert.equal(sysErrNum.kind, "SystemTime");
  assert.equal(sysErrNum.gap, 42.5);
  assert.equal(sysErrNum.message, "system clock is before the Unix epoch: 42.5");
  assert.ok(sysErrNum instanceof Error);
  assert.ok(sysErrNum instanceof SystemTimeError);

  const sysErrStr = new SystemTimeError("skew detected");
  assert.equal(sysErrStr.gap, undefined);
  assert.equal(
    sysErrStr.message,
    "system clock is before the Unix epoch: skew detected",
  );

  const sysErrDef = new SystemTimeError();
  assert.equal(sysErrDef.gap, undefined);
  assert.equal(
    sysErrDef.message,
    "system clock is before the Unix epoch: second time provided was later than self",
  );
});

test("owned wrapper records valid thread, generation, and exact observedAt timestamps", async () => {
  await dirFixture(async (path) => {
    const originalNow = Date.now;
    let sampleCount = 0;
    const fixedNow = 1700000000500;
    try {
      Date.now = () => {
        sampleCount++;
        if (sampleCount > 1) {
          throw new Error("Date.now must be sampled at most once");
        }
        return fixedNow;
      };
      await markAppServerManagedTarget(path, "valid-thread-1", 42n);
      assert.equal(sampleCount, 1);
    } finally {
      Date.now = originalNow;
    }

    const verifyDb = await openInitialized(path);
    try {
      const stmt = verifyDb.prepare(
        "SELECT thread_id, app_server_generation, created_at, updated_at FROM codex_app_server_managed_targets WHERE thread_id = ?",
      );
      stmt.setReadBigInts(true);
      const row = stmt.get("valid-thread-1") as
        | {
            thread_id: string;
            app_server_generation: bigint;
            created_at: number;
            updated_at: number;
          }
        | undefined;
      assert.ok(row !== undefined);
      assert.equal(row.thread_id, "valid-thread-1");
      assert.equal(row.app_server_generation, 42n);
      assert.equal(row.created_at, fixedNow / 1000);
      assert.equal(row.updated_at, fixedNow / 1000);
    } finally {
      verifyDb.close();
    }
  });
});

test("upsert preserves created_at even on lower positive generation or clock regression", async () => {
  await dirFixture(async (path) => {
    const originalNow = Date.now;
    const t1 = 1700000020000;
    const t2 = 1700000010000; // clock regression: earlier timestamp

    try {
      Date.now = () => t1;
      await markAppServerManagedTarget(path, "upsert-thread", 100n);

      Date.now = () => t2;
      await markAppServerManagedTarget(path, "upsert-thread", 50n); // lower positive generation
    } finally {
      Date.now = originalNow;
    }

    const verifyDb = await openInitialized(path);
    try {
      const stmt = verifyDb.prepare(
        "SELECT thread_id, app_server_generation, created_at, updated_at FROM codex_app_server_managed_targets WHERE thread_id = ?",
      );
      stmt.setReadBigInts(true);
      const row = stmt.get("upsert-thread") as
        | {
            thread_id: string;
            app_server_generation: bigint;
            created_at: number;
            updated_at: number;
          }
        | undefined;
      assert.ok(row !== undefined);
      assert.equal(row.thread_id, "upsert-thread");
      assert.equal(row.app_server_generation, 50n);
      assert.equal(row.created_at, t1 / 1000); // preserved from first insertion
      assert.equal(row.updated_at, t2 / 1000); // updated to second timestamp
    } finally {
      verifyDb.close();
    }
  });
});

test("thread validation rejects empty and Rust whitespace (including NEL U+0085) BEFORE clock or file open", async () => {
  await dirFixture(async (path) => {
    const originalNow = Date.now;
    try {
      Date.now = () => {
        throw new Error("Date.now must not be invoked on invalid threadId");
      };

      const invalidThreadIds = [
        "",
        " ",
        " leading-space",
        "trailing-space ",
        "\tleading-tab",
        "trailing-newline\n",
        "\rleading-cr",
        "\u0085leading-nel", // U+0085 NEL
        "trailing-nel\u0085",
        "\u00a0nbsp", // U+00A0 NO-BREAK SPACE
        "\u1680ogham", // U+1680 OGHAM SPACE MARK
        "\u2000en-quad", // U+2000
        "\u200aen-hair", // U+200A
        "\u2028line-sep", // U+2028
        "\u2029para-sep", // U+2029
        "\u202fnarrow-nbsp", // U+202F
        "\u205fmed-math", // U+205F
        "\u3000ideographic", // U+3000 IDEOGRAPHIC SPACE
      ];

      for (const invalidId of invalidThreadIds) {
        await assert.rejects(
          () => markAppServerManagedTarget(path, invalidId, 1n),
          (err: unknown) => {
            assert.ok(err instanceof InvalidAppServerManagedTargetError);
            assert.equal(err.kind, "InvalidAppServerManagedTarget");
            assert.equal(err.name, "InvalidAppServerManagedTargetError");
            assert.equal(
              err.message,
              `invalid direct app-server managed target: ${invalidId}`,
            );
            return true;
          },
        );
      }
      assert.equal(existsSync(path), false);
    } finally {
      Date.now = originalNow;
    }
  });
});

test("internal whitespace, NUL, BOM (U+FEFF), and supplementary characters are valid thread targets", async () => {
  await dirFixture(async (path) => {
    const validThreads = [
      "thread with internal spaces",
      "thread\u0085internal-nel",
      "thread\u0000with-nul",
      "\u0000leading-nul",
      "\uFEFFthread-with-leading-bom", // U+FEFF is excluded from Rust whitespace
      "thread-with-trailing-bom\uFEFF",
      "thread-😀-🎉-supplementary",
    ];

    for (const validId of validThreads) {
      await markAppServerManagedTarget(path, validId, 10n);
    }

    const verifyDb = await openInitialized(path);
    try {
      for (const validId of validThreads) {
        assert.equal(containsManagedTargetIn(verifyDb, validId), true);
      }
    } finally {
      verifyDb.close();
    }
  });
});

test("path and threadId lone surrogates are rejected with TypeError before clock or file open", async () => {
  await dirFixture(async (path) => {
    const originalNow = Date.now;
    try {
      Date.now = () => {
        throw new Error("Date.now must not be invoked on validation error");
      };

      await assert.rejects(
        () => markAppServerManagedTarget(null as unknown as string, "t", 1n),
        { name: "TypeError", message: "path must be a string" },
      );
      await assert.rejects(
        () => markAppServerManagedTarget("bad\uD800path", "t", 1n),
        { name: "TypeError", message: "path contains lone surrogates" },
      );
      await assert.rejects(
        () => markAppServerManagedTarget(path, 123 as unknown as string, 1n),
        { name: "TypeError", message: "threadId must be a string" },
      );
      await assert.rejects(
        () => markAppServerManagedTarget(path, "t\uDC00bad", 1n),
        { name: "TypeError", message: "threadId contains lone surrogates" },
      );

      assert.equal(existsSync(path), false);
    } finally {
      Date.now = originalNow;
    }
  });
});

test("wrong thread validation beats bad clock before file open", async () => {
  await dirFixture(async (path) => {
    const originalNow = Date.now;
    try {
      Date.now = () => -99999; // negative clock
      await assert.rejects(
        () => markAppServerManagedTarget(path, "", 1n),
        (err: unknown) => {
          assert.ok(err instanceof InvalidAppServerManagedTargetError);
          assert.equal(err.kind, "InvalidAppServerManagedTarget");
          return true;
        },
      );
      assert.equal(existsSync(path), false);
    } finally {
      Date.now = originalNow;
    }
  });
});

test("i64 primitive boundary validation rejects invalid types and out-of-range before clock or file open", async () => {
  await dirFixture(async (path) => {
    const originalNow = Date.now;
    try {
      Date.now = () => {
        throw new Error("Date.now must not be invoked on i64 primitive error");
      };

      await assert.rejects(
        () => markAppServerManagedTarget(path, "t", 123 as unknown as bigint),
        { name: "TypeError", message: "generation must be a bigint" },
      );
      await assert.rejects(
        () => markAppServerManagedTarget(path, "t", I64_MAX + 1n),
        {
          name: "RangeError",
          message: `generation out of signed i64 range: ${(I64_MAX + 1n).toString()}`,
        },
      );
      await assert.rejects(
        () => markAppServerManagedTarget(path, "t", I64_MIN - 1n),
        {
          name: "RangeError",
          message: `generation out of signed i64 range: ${(I64_MIN - 1n).toString()}`,
        },
      );
      assert.equal(existsSync(path), false);
    } finally {
      Date.now = originalNow;
    }
  });
});

test("clock negative or nonfinite wins first over gen <= 0n", async () => {
  await dirFixture(async (path) => {
    const originalNow = Date.now;
    try {
      Date.now = () => -5000;
      await assert.rejects(
        () => markAppServerManagedTarget(path, "t", 0n),
        (err: unknown) => {
          assert.ok(err instanceof SystemTimeError);
          assert.equal(err.kind, "SystemTime");
          assert.equal(err.gap, 5000);
          assert.match(err.message, /^system clock is before the Unix epoch: 5000/);
          return true;
        },
      );

      Date.now = () => NaN;
      await assert.rejects(
        () => markAppServerManagedTarget(path, "t", -1n),
        { name: "TypeError", message: "system clock must be finite" },
      );

      Date.now = () => Infinity;
      await assert.rejects(
        () => markAppServerManagedTarget(path, "t", 0n),
        { name: "TypeError", message: "system clock must be finite" },
      );

      Date.now = () => -Infinity;
      await assert.rejects(
        () => markAppServerManagedTarget(path, "t", -10n),
        { name: "TypeError", message: "system clock must be finite" },
      );

      assert.equal(existsSync(path), false);
    } finally {
      Date.now = originalNow;
    }
  });
});

test("generation <= 0n fails AFTER clock/open/BEGIN, fresh migrations persist, and target row is absent", async () => {
  await dirFixture(async (path) => {
    for (const nonPositiveGen of [0n, -1n, I64_MIN]) {
      await assert.rejects(
        () => markAppServerManagedTarget(path, "t-sem", nonPositiveGen),
        (err: unknown) => {
          assert.ok(err instanceof InvalidAppServerManagedTargetError);
          assert.equal(err.kind, "InvalidAppServerManagedTarget");
          assert.equal(err.message, "invalid direct app-server managed target: t-sem");
          return true;
        },
      );
    }

    assert.equal(existsSync(path), true);
    const verifyDb = await openInitialized(path);
    try {
      const targetTableStmt = verifyDb.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_app_server_managed_targets'",
      );
      assert.equal(targetTableStmt.get(), undefined);

      const baseQueueStmt = verifyDb.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_turn_queue'",
      );
      const queueRow = baseQueueStmt.get() as { name: string } | undefined;
      assert.ok(queueRow !== undefined);
      assert.equal(queueRow.name, "codex_turn_queue");
    } finally {
      verifyDb.close();
    }
  });
});

test("markManagedTargetIn requires DatabaseSync, untrimmed thread, positive gen, and accepts signed I64_MAX", async () => {
  await fixture(async (_path, db) => {
    assert.throws(
      () => markManagedTargetIn(null as unknown as DatabaseSync, "t", 1n, 1.0),
      { name: "TypeError", message: "db must be a DatabaseSync instance" },
    );
    assert.throws(
      () => markManagedTargetIn(db, " ", 1n, 1.0),
      (err: unknown) => err instanceof InvalidAppServerManagedTargetError,
    );
    assert.throws(
      () => markManagedTargetIn(db, "t", 0n, 1.0),
      (err: unknown) => err instanceof InvalidAppServerManagedTargetError,
    );
    assert.throws(
      () => markManagedTargetIn(db, "t", -1n, 1.0),
      (err: unknown) => err instanceof InvalidAppServerManagedTargetError,
    );
    assert.throws(
      () => markManagedTargetIn(db, "t", 1n, "not-number" as unknown as number),
      { name: "TypeError", message: "observedAt must be a number" },
    );

    // Signed I64_MAX accepted
    markManagedTargetIn(db, "t-i64-max", I64_MAX, 100.0);
    const stmt = db.prepare(
      "SELECT app_server_generation FROM codex_app_server_managed_targets WHERE thread_id = ?",
    );
    stmt.setReadBigInts(true);
    const row = stmt.get("t-i64-max") as { app_server_generation: bigint } | undefined;
    assert.ok(row !== undefined);
    assert.equal(row.app_server_generation, I64_MAX);
  });
});

test("markManagedTargetIn caller transaction rollback undoes upsert and table creation, handle remains usable", async () => {
  await dirFixture(async (path) => {
    const db = await openInitialized(path);
    try {
      db.exec("BEGIN IMMEDIATE;");
      markManagedTargetIn(db, "tx-target", 1n, 200.0);
      db.exec("ROLLBACK;");

      const stmt = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_app_server_managed_targets'",
      );
      assert.equal(stmt.get(), undefined);

      // Caller handle is still fully usable
      db.exec("BEGIN IMMEDIATE;");
      assert.throws(
        () => markManagedTargetIn(db, "bad-thread-lead ", 1n, 200.0),
        (err: unknown) => err instanceof InvalidAppServerManagedTargetError,
      );
      db.exec("ROLLBACK;"); // transaction rolled back cleanly by caller
      assert.equal(db.isTransaction, false);
    } finally {
      db.close();
    }
  });
});

test("markManagedTargetIn does not invent finite or positive guards on observedAt (native SQLite observations)", async () => {
  await fixture(async (_path, db) => {
    // Negative timestamp is passed directly without synthetic guard
    markManagedTargetIn(db, "neg-time", 1n, -500.25);
    // Infinity is passed directly without synthetic guard
    markManagedTargetIn(db, "inf-time", 1n, Infinity);

    const stmt = db.prepare(
      "SELECT created_at, updated_at FROM codex_app_server_managed_targets WHERE thread_id = ?",
    );
    stmt.setReadBigInts(true);

    const negRow = stmt.get("neg-time") as
      | { created_at: number; updated_at: number }
      | undefined;
    assert.ok(negRow !== undefined);
    assert.equal(negRow.created_at, -500.25);
    assert.equal(negRow.updated_at, -500.25);

    const infRow = stmt.get("inf-time") as
      | { created_at: number; updated_at: number }
      | undefined;
    assert.ok(infRow !== undefined);
    assert.equal(infRow.created_at, Infinity);
    assert.equal(infRow.updated_at, Infinity);
  });
});

test("NaN observedAt triggers native SQLite NOT NULL constraint and preserves caller transaction", async () => {
  await fixture(async (_path, db) => {
    db.exec("BEGIN IMMEDIATE;");
    assert.throws(
      () => markManagedTargetIn(db, "nan-time", 1n, NaN),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /NOT NULL constraint failed/i);
        return true;
      },
    );
    assert.equal(db.isTransaction, true); // Caller transaction remains open
    db.exec("ROLLBACK;");
    assert.equal(db.isTransaction, false);
  });
});

test("ensureManagedTargetTableIn and containsManagedTargetIn create ONLY target table if absent", async () => {
  await dirFixture(async (path) => {
    const db = new DatabaseSync(path);
    try {
      const beforeStmt = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_app_server_managed_targets'",
      );
      assert.equal(beforeStmt.get(), undefined);

      // Invalid Unicode rejects BEFORE table creation
      assert.throws(
        () => containsManagedTargetIn(db, "bad\uD800"),
        { name: "TypeError", message: "threadId contains lone surrogates" },
      );
      assert.equal(beforeStmt.get(), undefined);

      // Calling contains on absent table mutates schema by CREATE TABLE IF NOT EXISTS
      const absentResult = containsManagedTargetIn(db, "missing-thread");
      assert.equal(absentResult, false);
      assert.ok(beforeStmt.get() !== undefined);

      // Only codex_app_server_managed_targets is created, turn queue table is absent
      const queueStmt = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_turn_queue'",
      );
      assert.equal(queueStmt.get(), undefined);

      // Existing row returns true via native bigint decode
      markManagedTargetIn(db, "existing-thread", 1n, 123.0);
      assert.equal(containsManagedTargetIn(db, "existing-thread"), true);
    } finally {
      db.close();
    }
  });
});

test("native BEFORE INSERT ABORT trigger causes rollback and preserves caller db handle on borrowed path", async () => {
  await dirFixture(async (path) => {
    // Setup table and trigger
    const setupDb = await openInitialized(path);
    try {
      ensureManagedTargetTableIn(setupDb);
      setupDb.exec(
        "CREATE TRIGGER abort_target_insert BEFORE INSERT ON codex_app_server_managed_targets " +
          "BEGIN SELECT RAISE(ABORT, 'abort trigger block'); END;",
      );
    } finally {
      setupDb.close();
    }

    // Owned markAppServerManagedTarget fails, rolls back, and closes owned db
    await assert.rejects(
      () => markAppServerManagedTarget(path, "blocked-thread", 1n),
      /abort trigger block/,
    );

    // Borrowed markManagedTargetIn preserves caller db handle on trigger abort
    const callerDb = await openInitialized(path);
    try {
      callerDb.exec("BEGIN IMMEDIATE;");
      assert.throws(
        () => markManagedTargetIn(callerDb, "borrowed-block", 1n, 1.0),
        /abort trigger block/,
      );
      // Caller connection is not closed; transaction is rolled back by caller
      callerDb.exec("ROLLBACK;");
      assert.equal(callerDb.isTransaction, false);
    } finally {
      callerDb.close();
    }
  });
});

test("native BEFORE UPDATE IGNORE trigger preserves existing row without throwing", async () => {
  await fixture(async (_path, db) => {
    ensureManagedTargetTableIn(db);
    db.exec(
      "CREATE TRIGGER ignore_target_update BEFORE UPDATE ON codex_app_server_managed_targets " +
        "BEGIN SELECT RAISE(IGNORE); END;",
    );

    markManagedTargetIn(db, "static-thread", 1n, 100.0);
    // Subsequent mark triggers UPDATE which IGNORE skips
    markManagedTargetIn(db, "static-thread", 2n, 200.0);

    const stmt = db.prepare(
      "SELECT app_server_generation, created_at, updated_at FROM codex_app_server_managed_targets WHERE thread_id = ?",
    );
    stmt.setReadBigInts(true);
    const row = stmt.get("static-thread") as
      | {
          app_server_generation: bigint;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    assert.ok(row !== undefined);
    assert.equal(row.app_server_generation, 1n); // preserved by IGNORE
    assert.equal(row.created_at, 100.0);
    assert.equal(row.updated_at, 100.0); // preserved by IGNORE
  });
});

test("explicit millisecond precision gap note: float64 REAL in SQLite vs integer millisecond sampling", () => {
  /*
   * Precision Gap Note:
   * Date.now() in JavaScript samples integer milliseconds since Unix epoch, unlike Rust
   * SystemTime::now() which has nanosecond resolution.
   * The store divides Date.now() by 1000 to produce observedAt as a floating-point seconds value,
   * which SQLite stores as an IEEE 754 float64 REAL. Decimal fractional seconds are binary64
   * approximations rather than exact decimal fractions. Roundtripping holds for this chosen
   * sample value, but this is a demonstration of the chosen value only, not a universal proof.
   */
  const sampleNow = 1712345678912;
  const observedAt = sampleNow / 1000;
  assert.equal(observedAt * 1000, sampleNow);
});
