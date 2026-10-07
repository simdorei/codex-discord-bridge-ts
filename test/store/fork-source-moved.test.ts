import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  ensureSourceNotMoved,
  ForkHandoffTargetMovedError,
} from "../../src/store/fork-handoff-admission.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";

function withDb<T>(
  fn: (db: DatabaseSync, dbPath: string) => T,
  initPragma?: string,
): T {
  const actualTmp = realpathSync(tmpdir());
  const originaldir = realpathSync(mkdtempSync(join(actualTmp, "fsm-test-")));
  const dir = originaldir;
  const dbPath = join(dir, "test.db");
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    if (initPragma !== undefined) {
      db.exec(initPragma);
    }
    return fn(db, dbPath);
  } finally {
    try {
      db?.close();
    } catch {
      // Handle may have already closed in test
    } finally {
      assert.strictEqual(realpathSync(dir), originaldir);
      assert.strictEqual(dirname(dir), actualTmp);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function insertCompletedHandoff(
  db: DatabaseSync,
  handoffId: string,
  sourceThreadId: string,
  targetThreadId: string,
): void {
  ensureSourceNotMoved(db, "__schema_init__");
  const stmt = db.prepare(`INSERT INTO codex_thread_fork_handoffs (
    handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
    discord_channel_id, discord_thread_id, quarantine_reason, last_fork_error,
    fork_failure_ambiguous, observed_target_thread_id, target_thread_id,
    completed_generation, created_at, completed_at
  ) VALUES (?, NULL, ?, 1, 100, 200, 'reason', '', 0, ?, ?, 1, 1000.0, 1000.0)`);
  stmt.run(handoffId, sourceThreadId, targetThreadId, targetThreadId);
}

describe("fork-source-moved", () => {
  it("malformed JS inputs reject before effects", () => {
    withDb((db) => {
      const invalidInputs: unknown[] = [
        null,
        undefined,
        123,
        true,
        {},
        [],
        "\uD800",
        "pre-\uD800",
        "\uD800A",
        "\uD800\uD800",
        "\uDC00",
        "pre-\uDC00",
        "\uDC00post",
      ];
      for (const input of invalidInputs) {
        assert.throws(
          () => ensureSourceNotMoved(db, input as string),
          {
            name: "TypeError",
            message: "Expected a well-formed string",
          },
        );
      }
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      assert.equal(tables.length, 0);
    });
  });

  it("fresh DB without handoffs creates fork schema and returns cleanly", () => {
    withDb((db) => {
      ensureSourceNotMoved(db, "thread-fresh");
      const table = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_thread_fork_handoffs'",
        )
        .get() as { name: string } | undefined;
      assert.ok(table !== undefined);

      const columns = (
        db
          .prepare(
            "SELECT name FROM pragma_table_info('codex_thread_fork_handoffs')",
          )
          .all() as Array<{ name: string }>
      ).map((c) => c.name);
      assert.ok(columns.includes("observed_target_thread_id"));
      assert.ok(columns.includes("last_fork_error"));
      assert.ok(columns.includes("fork_failure_ambiguous"));
      assert.ok(columns.includes("target_thread_id"));
      assert.ok(columns.includes("completed_at"));
    });
  });

  it("completed valid targets throw ForkHandoffTargetMovedError with exact properties", () => {
    withDb((db) => {
      const cases: Array<{ id: string; source: string; target: string }> = [
        { id: "h-empty", source: "src-empty", target: "" },
        { id: "h-nul", source: "src-\0-nul", target: "tgt-\0-nul" },
        { id: "h-bom", source: "\uFEFFsrc-bom", target: "\uFEFFtgt-bom" },
        { id: "h-supp", source: "src-🌟-pair", target: "tgt-🌟-pair" },
        { id: "h-ws", source: "  \t\r\n  ", target: "\t\r\n   " },
      ];
      for (const { id, source, target } of cases) {
        insertCompletedHandoff(db, id, source, target);
        assert.throws(
          () => ensureSourceNotMoved(db, source),
          (err: unknown) => {
            assert.ok(err instanceof ForkHandoffTargetMovedError);
            assert.ok(err instanceof Error);
            assert.equal(err.name, "ForkHandoffTargetMovedError");
            assert.equal(err.kind, "ForkHandoffTargetMoved");
            assert.equal(err.sourceThreadId, source);
            assert.equal(err.targetThreadId, target);
            assert.equal(
              err.message,
              `app-server fork handoff moved source thread ${source} to ${target}`,
            );
            return true;
          },
        );
      }
    });
  });

  it("unresolved completed_at null does not throw", () => {
    withDb((db) => {
      ensureSourceNotMoved(db, "__init__");
      const stmt = db.prepare(`INSERT INTO codex_thread_fork_handoffs (
        handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
        discord_channel_id, discord_thread_id, quarantine_reason, last_fork_error,
        fork_failure_ambiguous, observed_target_thread_id, target_thread_id,
        completed_generation, created_at, completed_at
      ) VALUES ('h-unres', NULL, 'src-unres', 1, 100, 200, 'q', '', 0, NULL, NULL, NULL, 1000.0, NULL)`);
      stmt.run();

      assert.doesNotThrow(() => ensureSourceNotMoved(db, "src-unres"));
    });
  });

  it("exact routing TABLE existence returns before DDL or query even if fork table is malformed and holds are populated", () => {
    withDb((db) => {
      db.exec(
        "CREATE TABLE codex_exact_thread_routing (enabled INTEGER NOT NULL CHECK(enabled = 1)); INSERT INTO codex_exact_thread_routing VALUES (1);",
      );
      db.exec(
        "CREATE TABLE codex_thread_fork_handoffs (malformed_junk INTEGER PRIMARY KEY);",
      );
      db.exec(
        "CREATE TABLE codex_dead_generation_holds (target_thread_id TEXT NOT NULL); INSERT INTO codex_dead_generation_holds VALUES ('src-hold');",
      );

      assert.doesNotThrow(() => ensureSourceNotMoved(db, "src-hold"));

      const columns = (
        db
          .prepare(
            "SELECT name FROM pragma_table_info('codex_thread_fork_handoffs')",
          )
          .all() as Array<{ name: string }>
      ).map((c) => c.name);
      assert.deepEqual(columns, ["malformed_junk"]);
    });
  });

  it("VIEW named codex_exact_thread_routing is inactive", () => {
    withDb((db) => {
      db.exec(
        "CREATE VIEW codex_exact_thread_routing AS SELECT 1 AS enabled;",
      );
      insertCompletedHandoff(db, "h-view", "src-view", "tgt-view");

      assert.throws(
        () => ensureSourceNotMoved(db, "src-view"),
        (err: unknown) => {
          assert.ok(err instanceof ForkHandoffTargetMovedError);
          assert.equal(err.sourceThreadId, "src-view");
          assert.equal(err.targetThreadId, "tgt-view");
          return true;
        },
      );
    });
  });

  it("native NULL, BLOB, and malformed TEXT in completed target throw StoreIntegrityError with CAST raw bytes and typeof hex proof", () => {
    withDb((db) => {
      ensureSourceNotMoved(db, "__init__");
      db.exec("PRAGMA ignore_check_constraints = ON;");

      db.prepare(
        `INSERT INTO codex_thread_fork_handoffs (
          handoff_id, source_thread_id, expected_generation, discord_channel_id,
          discord_thread_id, quarantine_reason, observed_target_thread_id,
          target_thread_id, completed_generation, created_at, completed_at
        ) VALUES ('h-blob', 'src-blob', 1, 1, 1, 'q', X'CAFE', X'CAFE', 1, 1.0, 1.0)`,
      ).run();

      const blobProof = db
        .prepare(
          "SELECT typeof(target_thread_id) AS t, hex(CAST(target_thread_id AS BLOB)) AS h FROM codex_thread_fork_handoffs WHERE source_thread_id = 'src-blob'",
        )
        .get() as { t: string; h: string } | undefined;
      assert.ok(blobProof !== undefined);
      assert.equal(blobProof.t, "blob");
      assert.equal(blobProof.h, "CAFE");
      assert.throws(
        () => ensureSourceNotMoved(db, "src-blob"),
        (err: unknown) =>
          err instanceof StoreIntegrityError &&
          err.message.includes("received object"),
      );

      db.prepare(
        `INSERT INTO codex_thread_fork_handoffs (
          handoff_id, source_thread_id, expected_generation, discord_channel_id,
          discord_thread_id, quarantine_reason, observed_target_thread_id,
          target_thread_id, completed_generation, created_at, completed_at
        ) VALUES ('h-malformed', 'src-malformed', 1, 1, 1, 'q', CAST(X'FF' AS TEXT), CAST(X'FF' AS TEXT), 1, 1.0, 1.0)`,
      ).run();

      const textProof = db
        .prepare(
          "SELECT typeof(target_thread_id) AS t, hex(CAST(target_thread_id AS BLOB)) AS h FROM codex_thread_fork_handoffs WHERE source_thread_id = 'src-malformed'",
        )
        .get() as { t: string; h: string } | undefined;
      assert.ok(textProof !== undefined);
      assert.equal(textProof.t, "text");
      assert.equal(textProof.h, "FF");
      assert.throws(
        () => ensureSourceNotMoved(db, "src-malformed"),
        (err: unknown) =>
          err instanceof StoreIntegrityError &&
          err.message.includes("Invalid text encoding"),
      );

      db.prepare(
        `INSERT INTO codex_thread_fork_handoffs (
          handoff_id, source_thread_id, expected_generation, discord_channel_id,
          discord_thread_id, quarantine_reason, observed_target_thread_id,
          target_thread_id, completed_generation, created_at, completed_at
        ) VALUES ('h-null', 'src-null', 1, 1, 1, 'q', NULL, NULL, 1, 1.0, 1.0)`,
      ).run();

      const nullProof = db
        .prepare(
          "SELECT typeof(target_thread_id) AS t FROM codex_thread_fork_handoffs WHERE source_thread_id = 'src-null'",
        )
        .get() as { t: string } | undefined;
      assert.ok(nullProof !== undefined);
      assert.equal(nullProof.t, "null");
      assert.throws(
        () => ensureSourceNotMoved(db, "src-null"),
        (err: unknown) =>
          err instanceof StoreIntegrityError &&
          err.message.includes("received null"),
      );
    });
  });

  it("selects first duplicate row when duplicate completed handoffs exist", () => {
    withDb((db) => {
      db.exec(`CREATE TABLE codex_thread_fork_handoffs (
        handoff_id TEXT PRIMARY KEY,
        ambiguous_job_id TEXT,
        source_thread_id TEXT NOT NULL,
        expected_generation INTEGER NOT NULL,
        discord_channel_id INTEGER NOT NULL,
        discord_thread_id INTEGER NOT NULL,
        quarantine_reason TEXT NOT NULL,
        last_fork_error TEXT NOT NULL DEFAULT '',
        fork_failure_ambiguous INTEGER NOT NULL DEFAULT 0,
        observed_target_thread_id TEXT,
        target_thread_id TEXT,
        completed_generation INTEGER,
        created_at REAL NOT NULL,
        completed_at REAL
      );`);

      db.prepare(
        `INSERT INTO codex_thread_fork_handoffs (
          handoff_id, source_thread_id, expected_generation, discord_channel_id,
          discord_thread_id, quarantine_reason, observed_target_thread_id,
          target_thread_id, completed_generation, created_at, completed_at
        ) VALUES (?, ?, 1, 1, 1, 'q', ?, ?, 1, 1000.0, 1000.0)`,
      ).run("h-1", "src-dup", "tgt-first", "tgt-first");

      db.prepare(
        `INSERT INTO codex_thread_fork_handoffs (
          handoff_id, source_thread_id, expected_generation, discord_channel_id,
          discord_thread_id, quarantine_reason, observed_target_thread_id,
          target_thread_id, completed_generation, created_at, completed_at
        ) VALUES (?, ?, 1, 1, 1, 'q', ?, ?, 1, 1000.0, 1000.0)`,
      ).run("h-2", "src-dup", "tgt-second", "tgt-second");

      assert.throws(
        () => ensureSourceNotMoved(db, "src-dup"),
        (err: unknown) => {
          assert.ok(err instanceof ForkHandoffTargetMovedError);
          assert.equal(err.sourceThreadId, "src-dup");
          assert.equal(err.targetThreadId, "tgt-first");
          return true;
        },
      );
    });
  });

  it("unrelated corrupt row is ignored when checking a valid or missing source", () => {
    withDb((db) => {
      ensureSourceNotMoved(db, "__init__");
      db.exec("PRAGMA ignore_check_constraints = ON;");

      db.prepare(
        `INSERT INTO codex_thread_fork_handoffs (
          handoff_id, source_thread_id, expected_generation, discord_channel_id,
          discord_thread_id, quarantine_reason, observed_target_thread_id,
          target_thread_id, completed_generation, created_at, completed_at
        ) VALUES ('h-corrupt', 'src-corrupt', 1, 1, 1, 'q', CAST(X'FF' AS TEXT), CAST(X'FF' AS TEXT), 1, 1.0, 1.0)`,
      ).run();

      insertCompletedHandoff(db, "h-valid", "src-valid", "tgt-valid");

      assert.throws(
        () => ensureSourceNotMoved(db, "src-valid"),
        (err: unknown) => {
          assert.ok(err instanceof ForkHandoffTargetMovedError);
          assert.equal(err.targetThreadId, "tgt-valid");
          return true;
        },
      );

      assert.doesNotThrow(() => ensureSourceNotMoved(db, "src-absent"));
    });
  });

  it("borrowed transaction DDL rollback restores legacy columns and index while connection remains alive", () => {
    withDb((db) => {
      db.exec(`CREATE TABLE codex_thread_fork_handoffs (
        handoff_id TEXT PRIMARY KEY,
        ambiguous_job_id TEXT UNIQUE,
        source_thread_id TEXT NOT NULL UNIQUE,
        expected_generation INTEGER NOT NULL,
        discord_channel_id INTEGER NOT NULL,
        discord_thread_id INTEGER NOT NULL,
        quarantine_reason TEXT NOT NULL,
        target_thread_id TEXT UNIQUE,
        completed_generation INTEGER,
        created_at REAL NOT NULL,
        completed_at REAL
      );
      CREATE INDEX codex_thread_fork_handoffs_observed_target ON codex_thread_fork_handoffs(source_thread_id);`);

      const initialCols = (
        db
          .prepare(
            "SELECT name FROM pragma_table_info('codex_thread_fork_handoffs')",
          )
          .all() as Array<{ name: string }>
      ).map((c) => c.name);
      assert.ok(!initialCols.includes("observed_target_thread_id"));
      assert.ok(!initialCols.includes("last_fork_error"));
      assert.ok(!initialCols.includes("fork_failure_ambiguous"));

      const initialIndex = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'codex_thread_fork_handoffs_observed_target'",
        )
        .get() as { name: string } | undefined;
      assert.ok(initialIndex !== undefined);

      db.exec("BEGIN;");
      ensureSourceNotMoved(db, "src-legacy");

      const insideCols = (
        db
          .prepare(
            "SELECT name FROM pragma_table_info('codex_thread_fork_handoffs')",
          )
          .all() as Array<{ name: string }>
      ).map((c) => c.name);
      assert.ok(insideCols.includes("observed_target_thread_id"));
      assert.ok(insideCols.includes("last_fork_error"));
      assert.ok(insideCols.includes("fork_failure_ambiguous"));

      const insideIndex = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'codex_thread_fork_handoffs_observed_target'",
        )
        .get() as { name: string } | undefined;
      assert.equal(insideIndex, undefined);

      db.exec("ROLLBACK;");

      const afterCols = (
        db
          .prepare(
            "SELECT name FROM pragma_table_info('codex_thread_fork_handoffs')",
          )
          .all() as Array<{ name: string }>
      ).map((c) => c.name);
      assert.ok(!afterCols.includes("observed_target_thread_id"));
      assert.ok(!afterCols.includes("last_fork_error"));
      assert.ok(!afterCols.includes("fork_failure_ambiguous"));

      const afterIndex = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'codex_thread_fork_handoffs_observed_target'",
        )
        .get() as { name: string } | undefined;
      assert.ok(afterIndex !== undefined);

      db.exec("CREATE TABLE handle_alive (id INTEGER PRIMARY KEY);");
      db.prepare("INSERT INTO handle_alive (id) VALUES (42);").run();
      const aliveRow = db
        .prepare("SELECT id FROM handle_alive WHERE id = 42")
        .get() as { id: number | bigint } | undefined;
      assert.ok(aliveRow !== undefined);
      assert.equal(Number(aliveRow.id), 42);
    });
  });

  it("real UTF-16le database persists sentinel across close and verifies encoding", () => {
    withDb((db, dbPath) => {
      const encRow = db.prepare("PRAGMA encoding").get() as
        | { encoding: string }
        | undefined;
      assert.ok(encRow !== undefined);
      assert.equal(encRow.encoding, "UTF-16le");

      const source = "src-utf16le-한글-🚀";
      const target = "tgt-utf16le-심쿵-🌟";
      insertCompletedHandoff(db, "h-utf16le", source, target);

      assert.throws(
        () => ensureSourceNotMoved(db, source),
        (err: unknown) => {
          assert.ok(err instanceof ForkHandoffTargetMovedError);
          assert.equal(err.sourceThreadId, source);
          assert.equal(err.targetThreadId, target);
          return true;
        },
      );

      const sentinelBefore = db
        .prepare(
          "SELECT target_thread_id FROM codex_thread_fork_handoffs WHERE source_thread_id = ?",
        )
        .get(source) as { target_thread_id: string } | undefined;
      assert.ok(sentinelBefore !== undefined);
      assert.equal(sentinelBefore.target_thread_id, target);

      db.close();

      const db2 = new DatabaseSync(dbPath);
      try {
        const encRow2 = db2.prepare("PRAGMA encoding").get() as
          | { encoding: string }
          | undefined;
        assert.ok(encRow2 !== undefined);
        assert.equal(encRow2.encoding, "UTF-16le");

        assert.throws(
          () => ensureSourceNotMoved(db2, source),
          (err: unknown) => {
            assert.ok(err instanceof ForkHandoffTargetMovedError);
            assert.equal(err.sourceThreadId, source);
            assert.equal(err.targetThreadId, target);
            return true;
          },
        );
      } finally {
        db2.close();
      }
    }, "PRAGMA encoding = 'UTF-16le';");
  });

  it("real UTF-16be database persists sentinel across close and verifies encoding", () => {
    withDb((db, dbPath) => {
      const encRow = db.prepare("PRAGMA encoding").get() as
        | { encoding: string }
        | undefined;
      assert.ok(encRow !== undefined);
      assert.equal(encRow.encoding, "UTF-16be");

      const source = "src-utf16be-한글-🚀";
      const target = "tgt-utf16be-사전-🌟";
      insertCompletedHandoff(db, "h-utf16be", source, target);

      assert.throws(
        () => ensureSourceNotMoved(db, source),
        (err: unknown) => {
          assert.ok(err instanceof ForkHandoffTargetMovedError);
          assert.equal(err.sourceThreadId, source);
          assert.equal(err.targetThreadId, target);
          return true;
        },
      );

      const sentinelBefore = db
        .prepare(
          "SELECT target_thread_id FROM codex_thread_fork_handoffs WHERE source_thread_id = ?",
        )
        .get(source) as { target_thread_id: string } | undefined;
      assert.ok(sentinelBefore !== undefined);
      assert.equal(sentinelBefore.target_thread_id, target);

      db.close();

      const db2 = new DatabaseSync(dbPath);
      try {
        const encRow2 = db2.prepare("PRAGMA encoding").get() as
          | { encoding: string }
          | undefined;
        assert.ok(encRow2 !== undefined);
        assert.equal(encRow2.encoding, "UTF-16be");

        assert.throws(
          () => ensureSourceNotMoved(db2, source),
          (err: unknown) => {
            assert.ok(err instanceof ForkHandoffTargetMovedError);
            assert.equal(err.sourceThreadId, source);
            assert.equal(err.targetThreadId, target);
            return true;
          },
        );
      } finally {
        db2.close();
      }
    }, "PRAGMA encoding = 'UTF-16be';");
  });
});
