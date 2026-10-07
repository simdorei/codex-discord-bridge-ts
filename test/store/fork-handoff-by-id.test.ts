import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  forkHandoffByIdIn,
  type AppServerForkHandoff,
} from "../../src/store/fork-handoff-by-id.ts";
import { ensureForkHandoffTable } from "../../src/store/fork-handoff-admission.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";

function withTempDb<T>(fn: (db: DatabaseSync, dbPath: string) => T): T {
  const actualTmp = realpathSync(tmpdir());
  const dir = mkdtempSync(join(actualTmp, "cbts-by-id-"));
  const realDir = realpathSync(dir);
  assert.equal(realpathSync(dir), realDir);
  const dbPath = join(realDir, "test.db");
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    return fn(db, dbPath);
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close on already-closed handle
    }
    assert.equal(realpathSync(dir), realDir);
    assert.equal(dirname(realDir), actualTmp);
    rmSync(realDir, { recursive: true, force: true });
    assert.equal(existsSync(realDir), false);
  }
}

test("unresolved handoff returns all 12 typed fields with optional nulls and i64 extrema while ignoring unrelated corrupt row", () => {
  withTempDb((db) => {
    ensureForkHandoffTable(db);

    db.prepare(
      "INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, expected_generation, discord_channel_id, discord_thread_id, quarantine_reason, last_fork_error, created_at) VALUES (?, ?, 1, 1, 1, 'reason', CAST(x'FF' AS TEXT), 1.0)",
    ).run("h-unrelated-corrupt", "src-unrelated-corrupt");

    db.prepare(
      "INSERT INTO codex_thread_fork_handoffs (handoff_id, ambiguous_job_id, source_thread_id, expected_generation, discord_channel_id, discord_thread_id, quarantine_reason, last_fork_error, fork_failure_ambiguous, observed_target_thread_id, target_thread_id, completed_generation, created_at, completed_at) VALUES (?, NULL, ?, ?, ?, ?, ?, '', 0, NULL, NULL, NULL, 100.0, NULL)",
    ).run(
      "h-unres",
      "src-unres",
      9223372036854775807n,
      -9223372036854775808n,
      0n,
      "quarantine unres",
    );

    const actual = forkHandoffByIdIn(db, "h-unres");
    const expected: AppServerForkHandoff = {
      handoffId: "h-unres",
      ambiguousJobId: null,
      sourceThreadId: "src-unres",
      expectedGeneration: 9223372036854775807n,
      discordChannelId: -9223372036854775808n,
      discordThreadId: 0n,
      quarantineReason: "quarantine unres",
      lastForkError: "",
      forkFailureAmbiguous: false,
      observedTargetThreadId: null,
      targetThreadId: null,
      completedGeneration: null,
    };
    assert.deepEqual(actual, expected);
    assert.equal(forkHandoffByIdIn(db, "h-missing"), null);
  });
});

test("completed handoff returns all 12 typed fields with target and non-zero bool without unresolved filter", () => {
  withTempDb((db) => {
    ensureForkHandoffTable(db);

    db.prepare(
      "INSERT INTO codex_thread_fork_handoffs (handoff_id, ambiguous_job_id, source_thread_id, expected_generation, discord_channel_id, discord_thread_id, quarantine_reason, last_fork_error, fork_failure_ambiguous, observed_target_thread_id, target_thread_id, completed_generation, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, 100.0, 150.0)",
    ).run(
      "h-comp",
      "job-comp-1",
      "src-comp-1",
      42n,
      1001n,
      1002n,
      "quarantine completed",
      "prior-fork-error",
      "tgt-comp-1",
      "tgt-comp-1",
      99n,
    );

    const actual = forkHandoffByIdIn(db, "h-comp");
    const expected: AppServerForkHandoff = {
      handoffId: "h-comp",
      ambiguousJobId: "job-comp-1",
      sourceThreadId: "src-comp-1",
      expectedGeneration: 42n,
      discordChannelId: 1001n,
      discordThreadId: 1002n,
      quarantineReason: "quarantine completed",
      lastForkError: "prior-fork-error",
      forkFailureAmbiguous: true,
      observedTargetThreadId: "tgt-comp-1",
      targetThreadId: "tgt-comp-1",
      completedGeneration: 99n,
    };
    assert.deepEqual(actual, expected);
  });
});

test("first duplicate legacy row without primary key returns full actual typed columns", () => {
  withTempDb((db) => {
    db.exec(`CREATE TABLE codex_thread_fork_handoffs (
      handoff_id TEXT,
      ambiguous_job_id TEXT,
      source_thread_id TEXT,
      expected_generation INTEGER,
      discord_channel_id INTEGER,
      discord_thread_id INTEGER,
      quarantine_reason TEXT,
      last_fork_error TEXT DEFAULT '',
      fork_failure_ambiguous INTEGER DEFAULT 0,
      observed_target_thread_id TEXT,
      target_thread_id TEXT,
      completed_generation INTEGER,
      created_at REAL,
      completed_at REAL
    );`);

    const insert = db.prepare(
      "INSERT INTO codex_thread_fork_handoffs (handoff_id, ambiguous_job_id, source_thread_id, expected_generation, discord_channel_id, discord_thread_id, quarantine_reason, last_fork_error, fork_failure_ambiguous, observed_target_thread_id, target_thread_id, completed_generation, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );

    insert.run(
      "dup-handoff",
      "job-first",
      "src-first",
      11n,
      21n,
      31n,
      "reason first",
      "err first",
      0,
      "tgt-first",
      "tgt-first",
      50n,
      10.0,
      20.0,
    );
    insert.run(
      "dup-handoff",
      "job-second",
      "src-second",
      12n,
      22n,
      32n,
      "reason second",
      "err second",
      1,
      "tgt-second",
      "tgt-second",
      60n,
      30.0,
      40.0,
    );

    const actual = forkHandoffByIdIn(db, "dup-handoff");
    const expected: AppServerForkHandoff = {
      handoffId: "dup-handoff",
      ambiguousJobId: "job-first",
      sourceThreadId: "src-first",
      expectedGeneration: 11n,
      discordChannelId: 21n,
      discordThreadId: 31n,
      quarantineReason: "reason first",
      lastForkError: "err first",
      forkFailureAmbiguous: false,
      observedTargetThreadId: "tgt-first",
      targetThreadId: "tgt-first",
      completedGeneration: 50n,
    };
    assert.deepEqual(actual, expected);
  });
});

test("fresh missing table throws native error and does not ensure table", () => {
  withTempDb((db) => {
    assert.throws(
      () => forkHandoffByIdIn(db, "any-id"),
      (err: unknown) =>
        err instanceof Error &&
        /no such table: codex_thread_fork_handoffs/.test(err.message),
    );
    const checkTable = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='codex_thread_fork_handoffs'",
      )
      .get();
    assert.equal(checkTable, undefined);
  });
});

test("missing legacy columns throws native error without altering table or dropping index", () => {
  withTempDb((db) => {
    db.exec(`CREATE TABLE codex_thread_fork_handoffs (
      handoff_id TEXT PRIMARY KEY,
      source_thread_id TEXT NOT NULL,
      expected_generation INTEGER NOT NULL,
      discord_channel_id INTEGER NOT NULL,
      discord_thread_id INTEGER NOT NULL,
      quarantine_reason TEXT NOT NULL
    );`);
    db.exec(
      "CREATE INDEX codex_thread_fork_handoffs_observed_target ON codex_thread_fork_handoffs (handoff_id);",
    );

    assert.throws(
      () => forkHandoffByIdIn(db, "any-id"),
      (err: unknown) =>
        err instanceof Error && /no such column:/.test(err.message),
    );

    const pragmaCols = db
      .prepare("SELECT name FROM pragma_table_info('codex_thread_fork_handoffs')")
      .all() as Array<{ name: string }>;
    const colNames = pragmaCols.map((c) => c.name);
    assert.equal(colNames.includes("observed_target_thread_id"), false);
    assert.equal(colNames.includes("last_fork_error"), false);
    assert.equal(colNames.includes("fork_failure_ambiguous"), false);

    const indexCheck = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='codex_thread_fork_handoffs_observed_target'",
      )
      .get() as { name: string } | undefined;
    assert.equal(indexCheck?.name, "codex_thread_fork_handoffs_observed_target");
  });
});

test("borrowed caller transaction remains intact and allows rollback", () => {
  withTempDb((db) => {
    ensureForkHandoffTable(db);
    db.exec("BEGIN IMMEDIATE;");
    db.prepare(
      "INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, expected_generation, discord_channel_id, discord_thread_id, quarantine_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("h-tx", "src-tx", 1n, 2n, 3n, "reason-tx", 1.0);

    const inTx = forkHandoffByIdIn(db, "h-tx");
    assert.notEqual(inTx, null);
    assert.equal(inTx?.handoffId, "h-tx");

    db.exec("ROLLBACK;");

    const afterRollback = forkHandoffByIdIn(db, "h-tx");
    assert.equal(afterRollback, null);

    db.exec("BEGIN IMMEDIATE;");
    db.prepare(
      "INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, expected_generation, discord_channel_id, discord_thread_id, quarantine_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("h-tx2", "src-tx2", 5n, 6n, 7n, "reason-tx2", 2.0);
    db.exec("COMMIT;");
    const committed = forkHandoffByIdIn(db, "h-tx2");
    assert.equal(committed?.handoffId, "h-tx2");
  });
});

test("strict JS input validates before DB access even on closed database", () => {
  withTempDb((db) => {
    db.close();

    const invalidTypes: unknown[] = [
      123,
      true,
      null,
      undefined,
      {},
      [],
      Symbol("test"),
      42n,
    ];
    for (const val of invalidTypes) {
      assert.throws(
        () => forkHandoffByIdIn(db, val as string),
        { name: "TypeError", message: "Expected a well-formed string" },
      );
    }

    const loneSurrogates = ["\uD800", "\uDFFF", "pre\uD800post", "\uD83D", "\uDC4D"];
    for (const val of loneSurrogates) {
      assert.throws(
        () => forkHandoffByIdIn(db, val),
        { name: "TypeError", message: "Expected a well-formed string" },
      );
    }

    assert.throws(
      () => forkHandoffByIdIn(db, "valid-string"),
      (err: unknown) => err instanceof Error && !(err instanceof TypeError),
    );
  });
});

test("exact handoff_id matching preserves empty, NUL, BOM, whitespace, and supplementary characters", () => {
  withTempDb((db) => {
    ensureForkHandoffTable(db);
    const ids = ["", "\0", "\uFEFF", "   ", "\t\r\n ", "🚀_fork_\u{1F389}"];
    const insertStmt = db.prepare(
      "INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, expected_generation, discord_channel_id, discord_thread_id, quarantine_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      insertStmt.run(id, `src-id-${i}`, 1n, 2n, 3n, `reason-${i}`, 1.0);
    }
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const actual = forkHandoffByIdIn(db, id);
      assert.notEqual(actual, null);
      assert.equal(actual?.handoffId, id);
      assert.equal(actual?.sourceThreadId, `src-id-${i}`);
    }
    assert.equal(forkHandoffByIdIn(db, "  non-existent  "), null);
  });
});

test("malformed native text with CAST X'FF' AS TEXT causes integrity decode error", () => {
  withTempDb((db) => {
    ensureForkHandoffTable(db);
    db.prepare(
      "INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, expected_generation, discord_channel_id, discord_thread_id, quarantine_reason, last_fork_error, created_at) VALUES (?, ?, ?, ?, ?, ?, CAST(x'FF' AS TEXT), ?)",
    ).run("h-malformed", "src-malformed", 1n, 2n, 3n, "reason", 1.0);

    assert.throws(
      () => forkHandoffByIdIn(db, "h-malformed"),
      (err: unknown) =>
        err instanceof StoreIntegrityError &&
        /Invalid text encoding|Text decode mismatch/.test(err.message),
    );
  });
});

test("native BLOB in text column causes integrity error", () => {
  withTempDb((db) => {
    ensureForkHandoffTable(db);
    db.prepare(
      "INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, expected_generation, discord_channel_id, discord_thread_id, quarantine_reason, created_at) VALUES (?, ?, ?, ?, ?, x'DEADBEEF', ?)",
    ).run("h-blob", "src-blob", 1n, 2n, 3n, 1.0);

    assert.throws(
      () => forkHandoffByIdIn(db, "h-blob"),
      (err: unknown) =>
        err instanceof StoreIntegrityError &&
        /Expected string for column quarantine_reason/.test(err.message),
    );
  });
});

test("i64 integer columns reject REAL, TEXT, overflow across field matrix and completed corrupt throws", () => {
  withTempDb((db) => {
    ensureForkHandoffTable(db);

    db.prepare(
      "INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, expected_generation, discord_channel_id, discord_thread_id, quarantine_reason, created_at) VALUES (?, ?, 12.5, 1, 1, 'reason', 1.0)",
    ).run("h-real-exp", "src-real-exp");
    assert.throws(
      () => forkHandoffByIdIn(db, "h-real-exp"),
      (err: unknown) =>
        err instanceof StoreIntegrityError &&
        /Expected integer bigint for column expected_generation/.test(err.message),
    );

    db.prepare(
      "INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, expected_generation, discord_channel_id, discord_thread_id, quarantine_reason, created_at) VALUES (?, ?, 1, 'bad-chan', 1, 'reason', 1.0)",
    ).run("h-text-chan", "src-text-chan");
    assert.throws(
      () => forkHandoffByIdIn(db, "h-text-chan"),
      (err: unknown) =>
        err instanceof StoreIntegrityError &&
        /Expected integer bigint for column discord_channel_id/.test(err.message),
    );

    db.prepare(
      "INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, expected_generation, discord_channel_id, discord_thread_id, quarantine_reason, created_at) VALUES (?, ?, 1, 1, 'bad-thread', 'reason', 1.0)",
    ).run("h-text-thread", "src-text-thread");
    assert.throws(
      () => forkHandoffByIdIn(db, "h-text-thread"),
      (err: unknown) =>
        err instanceof StoreIntegrityError &&
        /Expected integer bigint for column discord_thread_id/.test(err.message),
    );

    db.prepare(
      "INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, expected_generation, discord_channel_id, discord_thread_id, quarantine_reason, observed_target_thread_id, target_thread_id, completed_generation, created_at, completed_at) VALUES (?, ?, 1, 1, 1, 'reason', 'tgt-comp-real', 'tgt-comp-real', 42.5, 1.0, 2.0)",
    ).run("h-comp-real", "src-comp-real");
    assert.throws(
      () => forkHandoffByIdIn(db, "h-comp-real"),
      (err: unknown) =>
        err instanceof StoreIntegrityError &&
        /Expected integer bigint for column completed_generation/.test(err.message),
    );
  });
});

test("persisted UTF-16le database decodes sentinel text accurately after reopen", () => {
  withTempDb((db, dbPath) => {
    db.exec("PRAGMA encoding = 'UTF-16le'; CREATE TABLE init (id INTEGER PRIMARY KEY);");
    db.close();
    let reopened: DatabaseSync | undefined;
    try {
      reopened = new DatabaseSync(dbPath);
      const pragma = reopened.prepare("PRAGMA encoding").get() as
        | { encoding?: string }
        | undefined;
      assert.equal(pragma?.encoding, "UTF-16le");
      ensureForkHandoffTable(reopened);
      reopened
        .prepare(
          "INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, expected_generation, discord_channel_id, discord_thread_id, quarantine_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("h-utf16", "src-utf16", 1n, 2n, 3n, "UTF16_한국어_🚀", 1.0);
      const actual = forkHandoffByIdIn(reopened, "h-utf16");
      assert.equal(actual?.quarantineReason, "UTF16_한국어_🚀");
      assert.equal(actual?.handoffId, "h-utf16");
    } finally {
      reopened?.close();
    }
  });
});
