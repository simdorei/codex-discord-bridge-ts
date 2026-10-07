import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  DeadGenerationTargetHeldError,
  completedAppServerForkTargetForSource,
} from "../../src/store/fork-completed-target.ts";
import { ensureForkHandoffTable } from "../../src/store/fork-handoff-admission.ts";
import { openInitialized } from "../../src/store/owned-driver.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";

interface TempDbScope {
  readonly dbPath: string;
  readonly tempDir: string;
}

function getColumnNames(db: DatabaseSync, tableName: string): string[] {
  const colStmt = db.prepare(
    `SELECT name FROM pragma_table_info('${tableName}')`,
  );
  const rows = colStmt.all();
  return rows.map((row) => {
    if (
      typeof row === "object" &&
      row !== null &&
      "name" in row &&
      typeof (row as { readonly name: unknown }).name === "string"
    ) {
      return (row as { readonly name: string }).name;
    }
    throw new Error(`Expected pragma row with string name in ${tableName}`);
  });
}

function getPragmaEncoding(db: DatabaseSync): string {
  const pragmaStmt = db.prepare("PRAGMA encoding");
  const row = pragmaStmt.get();
  if (
    typeof row === "object" &&
    row !== null &&
    "encoding" in row &&
    typeof (row as { readonly encoding: unknown }).encoding === "string"
  ) {
    return (row as { readonly encoding: string }).encoding;
  }
  throw new Error("Expected pragma encoding row");
}

function getMasterRowName(row: unknown): string | undefined {
  if (
    typeof row === "object" &&
    row !== null &&
    "name" in row &&
    typeof (row as { readonly name: unknown }).name === "string"
  ) {
    return (row as { readonly name: string }).name;
  }
  return undefined;
}

function withTempDb(
  fn: (scope: TempDbScope) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const realTmp = realpathSync(tmpdir());
    const rawTempDir = mkdtempSync(join(realTmp, "fork-completed-test-"));
    const tempDir = realpathSync(rawTempDir);
    const dbPath = join(tempDir, "store.sqlite");
    try {
      await fn({ dbPath, tempDir });
    } finally {
      if (existsSync(tempDir)) {
        const currentRealPath = realpathSync(tempDir);
        const currentParent = realpathSync(dirname(currentRealPath));
        if (
          currentRealPath !== tempDir ||
          currentParent !== realTmp ||
          dirname(currentRealPath) !== realTmp
        ) {
          throw new Error(
            `Refusing to clean directory outside owned temp: ${currentRealPath}`,
          );
        }
        rmSync(currentRealPath, { recursive: true, force: true });
      }
    }
  };
}

describe("completedAppServerForkTargetForSource", () => {
  it(
    "fresh / no matching / unresolved returns null with fork schema ensure committed",
    withTempDb(async ({ dbPath }) => {
      assert.equal(existsSync(dbPath), false);

      // Fresh DB with no matching handoffs directly invoking wrapper on nonexistent DB
      const freshResult = await completedAppServerForkTargetForSource(
        dbPath,
        "fresh-source-thread",
      );
      assert.equal(freshResult, null);
      assert.equal(existsSync(dbPath), true);

      // Verify fork table creation was committed
      const checkDb = new DatabaseSync(dbPath);
      try {
        const tableStmt = checkDb.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_thread_fork_handoffs'",
        );
        tableStmt.setReadBigInts(true);
        const tableRow = tableStmt.get();
        assert.equal(getMasterRowName(tableRow), "codex_thread_fork_handoffs");

        // Insert unresolved handoff where completed_at is NULL
        const insertStmt = checkDb.prepare(`INSERT INTO codex_thread_fork_handoffs (
          handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
          discord_channel_id, discord_thread_id, quarantine_reason,
          last_fork_error, fork_failure_ambiguous, observed_target_thread_id,
          target_thread_id, completed_generation, created_at, completed_at
        ) VALUES (
          'handoff-unresolved', NULL, 'source-unresolved', 1, 100, 200, 'quarantine',
          '', 0, NULL, NULL, NULL, 1000.0, NULL
        )`);
        insertStmt.run();
      } finally {
        checkDb.close();
      }

      // Unresolved handoff returns null
      const unresolvedResult = await completedAppServerForkTargetForSource(
        dbPath,
        "source-unresolved",
      );
      assert.equal(unresolvedResult, null);

      // Unrelated source lookup returns null while table has records
      const absentResult = await completedAppServerForkTargetForSource(
        dbPath,
        "source-absent",
      );
      assert.equal(absentResult, null);
    }),
  );

  it(
    "completed exact source returns ONE target single hop never traverses chain even routing enabled table",
    withTempDb(async ({ dbPath }) => {
      const db = await openInitialized(dbPath);
      try {
        ensureForkHandoffTable(db);
        // Setup chain: A -> B and B -> C
        const insertHandoff = db.prepare(`INSERT INTO codex_thread_fork_handoffs (
          handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
          discord_channel_id, discord_thread_id, quarantine_reason,
          last_fork_error, fork_failure_ambiguous, observed_target_thread_id,
          target_thread_id, completed_generation, created_at, completed_at
        ) VALUES (?, NULL, ?, 1, 100, 200, 'none', '', 0, ?, ?, 1, 1000.0, 1000.0)`);
        insertHandoff.run("h-1", "thread-A", "thread-B", "thread-B");
        insertHandoff.run("h-2", "thread-B", "thread-C", "thread-C");

        // Create exact routing table to ensure routing table presence does not traverse chain
        db.exec(
          "CREATE TABLE codex_exact_thread_routing (enabled INTEGER NOT NULL CHECK(enabled = 1));",
        );
        db.prepare(
          "INSERT INTO codex_exact_thread_routing (enabled) VALUES (1);",
        ).run();
      } finally {
        db.close();
      }

      // Querying thread-A must return thread-B directly (single hop, never traverses chain to C)
      const target = await completedAppServerForkTargetForSource(
        dbPath,
        "thread-A",
      );
      assert.equal(target, "thread-B");
    }),
  );

  it(
    "source held blocks FIRST before fork ensure / table creation, any runtime gen hold blocks exact source",
    withTempDb(async ({ dbPath }) => {
      const db = await openInitialized(dbPath);
      try {
        // Table codex_thread_fork_handoffs must NOT exist yet
        const tableStmt = db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_thread_fork_handoffs'",
        );
        tableStmt.setReadBigInts(true);
        assert.equal(tableStmt.get(), undefined);

        // Place a dead generation hold on exact source thread ID with runtime generation
        const holdStmt = db.prepare(
          "INSERT INTO codex_dead_generation_holds (target_thread_id, runtime_id, generation, created_at) VALUES (?, ?, ?, ?)",
        );
        holdStmt.run("held-source-thread", "rt-alpha", 42n, 1234.5);
      } finally {
        db.close();
      }

      // Calling completedAppServerForkTargetForSource must fail with DeadGenerationTargetHeldError
      await assert.rejects(
        async () =>
          completedAppServerForkTargetForSource(dbPath, "held-source-thread"),
        (err: unknown) => {
          assert.ok(err instanceof DeadGenerationTargetHeldError);
          assert.ok(err instanceof Error);
          assert.equal(err.kind, "DeadGenerationTargetHeld");
          assert.equal(err.name, "DeadGenerationTargetHeldError");
          assert.equal(err.targetThreadId, "held-source-thread");
          assert.equal(
            err.message,
            "conversation held-source-thread is on hold after app-server process loss; manual review is required",
          );
          return true;
        },
      );

      // Verify table was NEVER created: guard checked FIRST before ensureForkHandoffTable
      const verifyDb = new DatabaseSync(dbPath);
      try {
        const tableStmt = verifyDb.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_thread_fork_handoffs'",
        );
        tableStmt.setReadBigInts(true);
        assert.equal(tableStmt.get(), undefined);
      } finally {
        verifyDb.close();
      }
    }),
  );

  it(
    "source hold refuses even if fork table is malformed and routing table is present",
    withTempDb(async ({ dbPath }) => {
      const db = await openInitialized(dbPath);
      try {
        // Create malformed codex_thread_fork_handoffs table lacking required primary key
        db.exec(
          "CREATE TABLE codex_thread_fork_handoffs (corrupt_col INT NOT NULL);",
        );
        // Create exact routing table
        db.exec(
          "CREATE TABLE codex_exact_thread_routing (enabled INTEGER NOT NULL CHECK(enabled = 1));",
        );
        db.prepare(
          "INSERT INTO codex_exact_thread_routing (enabled) VALUES (1);",
        ).run();
        // Place hold on source
        db.prepare(
          "INSERT INTO codex_dead_generation_holds (target_thread_id, runtime_id, generation, created_at) VALUES ('held-src', 'rt-1', 1, 100.0);",
        ).run();
      } finally {
        db.close();
      }

      // Refuses with DeadGenerationTargetHeldError before table ensure touches malformed table
      await assert.rejects(
        async () => completedAppServerForkTargetForSource(dbPath, "held-src"),
        (err: unknown) => {
          assert.ok(err instanceof DeadGenerationTargetHeldError);
          assert.equal(err.targetThreadId, "held-src");
          return true;
        },
      );
    }),
  );

  it(
    "target-only held / runtime incident only / execution hold do NOT block source lookup",
    withTempDb(async ({ dbPath }) => {
      const db = await openInitialized(dbPath);
      try {
        ensureForkHandoffTable(db);
        const insertHandoff = db.prepare(`INSERT INTO codex_thread_fork_handoffs (
          handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
          discord_channel_id, discord_thread_id, quarantine_reason,
          last_fork_error, fork_failure_ambiguous, observed_target_thread_id,
          target_thread_id, completed_generation, created_at, completed_at
        ) VALUES ('h-safe', NULL, 'source-safe', 1, 100, 200, 'none', '', 0, 'held-destination', 'held-destination', 1, 1000.0, 1000.0)`);
        insertHandoff.run();

        // 1. Destination target is held, but source is not held
        db.prepare(
          "INSERT INTO codex_dead_generation_holds (target_thread_id, runtime_id, generation, created_at) VALUES ('held-destination', 'rt-1', 1, 100.0);",
        ).run();

        // 2. Sealed runtime incident is recorded
        db.prepare(
          "INSERT OR REPLACE INTO codex_app_server_runtime (singleton, runtime_id) VALUES (1, 'rt-singleton');",
        ).run();
        db.prepare(
          "INSERT INTO codex_dead_generation_incidents (runtime_id, generation, snapshot_json, queue_jobs_json, created_at) VALUES ('rt-singleton', 1, '{}', '[]', 1000.0);",
        ).run();

        // 3. Execution hold in cdr_execution_holds
        db.exec(
          "CREATE TABLE IF NOT EXISTS cdr_execution_holds (job_id TEXT PRIMARY KEY, target_thread_id TEXT NOT NULL, reason TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at INTEGER NOT NULL);",
        );
        db.prepare(
          "INSERT INTO cdr_execution_holds VALUES ('job-1', 'source-safe', 'worker crashed', '{}', 1000);",
        ).run();
      } finally {
        db.close();
      }

      // Target-only hold, sealed runtime incident, and execution hold do NOT gate source lookup
      const result = await completedAppServerForkTargetForSource(
        dbPath,
        "source-safe",
      );
      assert.equal(result, "held-destination");
    }),
  );

  it(
    "exact empty, NUL, BOM, supp source and target identity / no-trim neighbors",
    withTempDb(async ({ dbPath }) => {
      const db = await openInitialized(dbPath);
      try {
        ensureForkHandoffTable(db);
        const insertStmt = db.prepare(`INSERT INTO codex_thread_fork_handoffs (
          handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
          discord_channel_id, discord_thread_id, quarantine_reason,
          last_fork_error, fork_failure_ambiguous, observed_target_thread_id,
          target_thread_id, completed_generation, created_at, completed_at
        ) VALUES (?, NULL, ?, 1, 100, 200, 'none', '', 0, ?, ?, 1, 1000.0, 1000.0)`);

        // Empty string identity
        insertStmt.run("h-empty", "", "", "");

        // NUL bytes, BOM, supplementary astral planes
        const complexSource = "src\0\uFEFF🚀🌟";
        const complexTarget = "tgt\0\uFEFF🎯🔥";
        insertStmt.run("h-complex", complexSource, complexTarget, complexTarget);

        // Untrimmed whitespace neighbors
        insertStmt.run("h-padded", " padded ", " padded-tgt ", " padded-tgt ");
        insertStmt.run("h-trimmed", "padded", "unpadded-tgt", "unpadded-tgt");
      } finally {
        db.close();
      }

      // Empty string preserved
      assert.equal(
        await completedAppServerForkTargetForSource(dbPath, ""),
        "",
      );

      // Complex Unicode preserved exactly
      assert.equal(
        await completedAppServerForkTargetForSource(
          dbPath,
          "src\0\uFEFF🚀🌟",
        ),
        "tgt\0\uFEFF🎯🔥",
      );

      // Whitespace neighbors are strictly distinct without trimming
      assert.equal(
        await completedAppServerForkTargetForSource(dbPath, " padded "),
        " padded-tgt ",
      );
      assert.equal(
        await completedAppServerForkTargetForSource(dbPath, "padded"),
        "unpadded-tgt",
      );
      assert.equal(
        await completedAppServerForkTargetForSource(dbPath, "padded "),
        null,
      );
      assert.equal(
        await completedAppServerForkTargetForSource(dbPath, " padded"),
        null,
      );
    }),
  );

  it(
    "legacy 3-column ensure + index drop committed on valid result",
    withTempDb(async ({ dbPath }) => {
      const db = await openInitialized(dbPath);
      try {
        // Create legacy 3-column omitted schema
        db.exec(`CREATE TABLE codex_thread_fork_handoffs (
          handoff_id TEXT PRIMARY KEY,
          ambiguous_job_id TEXT UNIQUE,
          source_thread_id TEXT NOT NULL UNIQUE,
          expected_generation INTEGER NOT NULL,
          discord_channel_id INTEGER NOT NULL,
          discord_thread_id INTEGER NOT NULL,
          quarantine_reason TEXT NOT NULL,
          completed_generation INTEGER,
          created_at REAL NOT NULL,
          completed_at REAL,
          target_thread_id TEXT UNIQUE
        )`);
        // Create legacy index that should be dropped by ensureForkHandoffTable
        db.exec(
          "CREATE INDEX codex_thread_fork_handoffs_observed_target ON codex_thread_fork_handoffs (source_thread_id)",
        );

        const insertStmt = db.prepare(`INSERT INTO codex_thread_fork_handoffs (
          handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
          discord_channel_id, discord_thread_id, quarantine_reason,
          completed_generation, created_at, completed_at, target_thread_id
        ) VALUES ('h-leg', NULL, 'leg-src', 1, 100, 200, 'none', 1, 1000.0, 1000.0, 'leg-target')`);
        insertStmt.run();
      } finally {
        db.close();
      }

      const result = await completedAppServerForkTargetForSource(
        dbPath,
        "leg-src",
      );
      assert.equal(result, "leg-target");

      // Verify committed schema modifications
      const verifyDb = new DatabaseSync(dbPath);
      try {
        const cols = getColumnNames(verifyDb, "codex_thread_fork_handoffs");
        assert.ok(cols.includes("observed_target_thread_id"));
        assert.ok(cols.includes("last_fork_error"));
        assert.ok(cols.includes("fork_failure_ambiguous"));

        const idxStmt = verifyDb.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'codex_thread_fork_handoffs_observed_target'",
        );
        idxStmt.setReadBigInts(true);
        const idxRow = idxStmt.get();
        assert.equal(getMasterRowName(idxRow), undefined);
      } finally {
        verifyDb.close();
      }
    }),
  );

  it(
    "corrupt selected target TEXT invalid UTF8 triggers strict Integrity error and rolls back schema alterations",
    withTempDb(async ({ dbPath }) => {
      const db = await openInitialized(dbPath);
      try {
        // Setup legacy table missing 3 columns with index
        db.exec(`CREATE TABLE codex_thread_fork_handoffs (
          handoff_id TEXT PRIMARY KEY,
          source_thread_id TEXT NOT NULL UNIQUE,
          target_thread_id TEXT,
          completed_at REAL
        )`);
        db.exec(
          "CREATE INDEX codex_thread_fork_handoffs_observed_target ON codex_thread_fork_handoffs (source_thread_id)",
        );
        // Insert invalid UTF-8 bytes (0xFF) into target_thread_id
        db.exec(
          "INSERT INTO codex_thread_fork_handoffs VALUES ('h-bad', 'src-corrupt', CAST(X'FF' AS TEXT), 1000.0)",
        );
      } finally {
        db.close();
      }

      await assert.rejects(
        async () => completedAppServerForkTargetForSource(dbPath, "src-corrupt"),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match(err.message, /target_thread_id/);
          return true;
        },
      );

      // Schema alterations and index drop must have rolled back
      const verifyDb = new DatabaseSync(dbPath);
      try {
        const cols = getColumnNames(verifyDb, "codex_thread_fork_handoffs");
        assert.equal(cols.includes("observed_target_thread_id"), false);
        assert.equal(cols.includes("last_fork_error"), false);
        assert.equal(cols.includes("fork_failure_ambiguous"), false);

        // Verify row values preserved
        const rowStmt = verifyDb.prepare(
          "SELECT handoff_id, source_thread_id, completed_at FROM codex_thread_fork_handoffs WHERE source_thread_id = 'src-corrupt'",
        );
        const row = rowStmt.get();
        assert.ok(typeof row === "object" && row !== null);
        assert.equal((row as { readonly handoff_id?: unknown }).handoff_id, "h-bad");
        assert.equal(
          (row as { readonly source_thread_id?: unknown }).source_thread_id,
          "src-corrupt",
        );

        const idxStmt = verifyDb.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'codex_thread_fork_handoffs_observed_target'",
        );
        idxStmt.setReadBigInts(true);
        const idxRow = idxStmt.get();
        assert.equal(
          getMasterRowName(idxRow),
          "codex_thread_fork_handoffs_observed_target",
        );
      } finally {
        verifyDb.close();
      }
    }),
  );

  it(
    "native NULL target on completed row causes StoreIntegrityError and rolls back schema alterations and preserves row values",
    withTempDb(async ({ dbPath }) => {
      const db = await openInitialized(dbPath);
      try {
        db.exec(`CREATE TABLE codex_thread_fork_handoffs (
          handoff_id TEXT PRIMARY KEY,
          source_thread_id TEXT NOT NULL UNIQUE,
          target_thread_id TEXT,
          completed_at REAL
        )`);
        db.exec(
          "CREATE INDEX codex_thread_fork_handoffs_observed_target ON codex_thread_fork_handoffs (source_thread_id)",
        );
        db.exec(
          "INSERT INTO codex_thread_fork_handoffs VALUES ('h-null', 'src-null', NULL, 1000.0)",
        );
      } finally {
        db.close();
      }

      await assert.rejects(
        async () => completedAppServerForkTargetForSource(dbPath, "src-null"),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          return true;
        },
      );

      // Verify PRAGMA 3 cols ABSENT, row values preserved, and index preserved
      const verifyDb = new DatabaseSync(dbPath);
      try {
        const cols = getColumnNames(verifyDb, "codex_thread_fork_handoffs");
        assert.equal(cols.includes("observed_target_thread_id"), false);
        assert.equal(cols.includes("last_fork_error"), false);
        assert.equal(cols.includes("fork_failure_ambiguous"), false);

        const rowStmt = verifyDb.prepare(
          "SELECT handoff_id, source_thread_id, target_thread_id, completed_at FROM codex_thread_fork_handoffs WHERE source_thread_id = 'src-null'",
        );
        const row = rowStmt.get();
        assert.ok(typeof row === "object" && row !== null);
        assert.equal((row as { readonly handoff_id?: unknown }).handoff_id, "h-null");
        assert.equal(
          (row as { readonly source_thread_id?: unknown }).source_thread_id,
          "src-null",
        );
        assert.equal(
          (row as { readonly target_thread_id?: unknown }).target_thread_id,
          null,
        );

        const idxStmt = verifyDb.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'codex_thread_fork_handoffs_observed_target'",
        );
        idxStmt.setReadBigInts(true);
        const idxRow = idxStmt.get();
        assert.equal(
          getMasterRowName(idxRow),
          "codex_thread_fork_handoffs_observed_target",
        );
      } finally {
        verifyDb.close();
      }
    }),
  );

  it(
    "corrupt target as raw BLOB causes StoreIntegrityError and rolls back schema alterations and preserves row values",
    withTempDb(async ({ dbPath }) => {
      const db = await openInitialized(dbPath);
      try {
        db.exec(`CREATE TABLE codex_thread_fork_handoffs (
          handoff_id TEXT PRIMARY KEY,
          source_thread_id TEXT NOT NULL UNIQUE,
          target_thread_id BLOB,
          completed_at REAL
        )`);
        db.exec(
          "CREATE INDEX codex_thread_fork_handoffs_observed_target ON codex_thread_fork_handoffs (source_thread_id)",
        );
        db.exec(
          "INSERT INTO codex_thread_fork_handoffs VALUES ('h-blob', 'src-blob', X'01020304', 1000.0)",
        );
      } finally {
        db.close();
      }

      await assert.rejects(
        async () => completedAppServerForkTargetForSource(dbPath, "src-blob"),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          return true;
        },
      );

      // Verify PRAGMA 3 cols ABSENT, row values preserved, and index preserved
      const verifyDb = new DatabaseSync(dbPath);
      try {
        const cols = getColumnNames(verifyDb, "codex_thread_fork_handoffs");
        assert.equal(cols.includes("observed_target_thread_id"), false);
        assert.equal(cols.includes("last_fork_error"), false);
        assert.equal(cols.includes("fork_failure_ambiguous"), false);

        const rowStmt = verifyDb.prepare(
          "SELECT handoff_id, source_thread_id, completed_at FROM codex_thread_fork_handoffs WHERE source_thread_id = 'src-blob'",
        );
        const row = rowStmt.get();
        assert.ok(typeof row === "object" && row !== null);
        assert.equal((row as { readonly handoff_id?: unknown }).handoff_id, "h-blob");
        assert.equal(
          (row as { readonly source_thread_id?: unknown }).source_thread_id,
          "src-blob",
        );

        const idxStmt = verifyDb.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'codex_thread_fork_handoffs_observed_target'",
        );
        idxStmt.setReadBigInts(true);
        const idxRow = idxStmt.get();
        assert.equal(
          getMasterRowName(idxRow),
          "codex_thread_fork_handoffs_observed_target",
        );
      } finally {
        verifyDb.close();
      }
    }),
  );

  it(
    "unrelated corrupt row is not decoded and valid row lookup succeeds",
    withTempDb(async ({ dbPath }) => {
      const db = await openInitialized(dbPath);
      try {
        db.exec(`CREATE TABLE codex_thread_fork_handoffs (
          handoff_id TEXT PRIMARY KEY,
          source_thread_id TEXT NOT NULL UNIQUE,
          target_thread_id TEXT,
          completed_at REAL
        )`);
        // Unrelated corrupt row
        db.exec(
          "INSERT INTO codex_thread_fork_handoffs VALUES ('h-bad', 'src-bad', CAST(X'FF' AS TEXT), 1000.0)",
        );
        // Valid row
        db.exec(
          "INSERT INTO codex_thread_fork_handoffs VALUES ('h-good', 'src-good', 'target-valid', 1000.0)",
        );
      } finally {
        db.close();
      }

      const result = await completedAppServerForkTargetForSource(
        dbPath,
        "src-good",
      );
      assert.equal(result, "target-valid");
    }),
  );

  it(
    "duplicate source rows in legacy schema without UNIQUE returns first native query row without dup guard",
    withTempDb(async ({ dbPath }) => {
      const db = await openInitialized(dbPath);
      try {
        db.exec(`CREATE TABLE codex_thread_fork_handoffs (
          handoff_id TEXT PRIMARY KEY,
          source_thread_id TEXT NOT NULL,
          target_thread_id TEXT,
          completed_at REAL
        )`);
        db.exec(
          "INSERT INTO codex_thread_fork_handoffs VALUES ('h-1', 'src-dup', 'target-first', 1000.0)",
        );
        db.exec(
          "INSERT INTO codex_thread_fork_handoffs VALUES ('h-2', 'src-dup', 'target-second', 2000.0)",
        );
      } finally {
        db.close();
      }

      const result = await completedAppServerForkTargetForSource(
        dbPath,
        "src-dup",
      );
      assert.equal(result, "target-first");
    }),
  );

  it(
    "hostile type and property coercion counters remain 0 on validation error",
    withTempDb(async ({ dbPath }) => {
      assert.equal(existsSync(dbPath), false);

      let pathCoercions = 0;
      const hostilePath = {
        [Symbol.toPrimitive]() {
          pathCoercions++;
          return dbPath;
        },
        toString() {
          pathCoercions++;
          return dbPath;
        },
        valueOf() {
          pathCoercions++;
          return dbPath;
        },
      };

      let sourceCoercions = 0;
      const hostileSource = {
        [Symbol.toPrimitive]() {
          sourceCoercions++;
          return "valid-src";
        },
        toString() {
          sourceCoercions++;
          return "valid-src";
        },
        valueOf() {
          sourceCoercions++;
          return "valid-src";
        },
      };

      await assert.rejects(
        async () =>
          completedAppServerForkTargetForSource(
            hostilePath as unknown as string,
            "valid-src",
          ),
        TypeError,
      );
      assert.equal(pathCoercions, 0);

      await assert.rejects(
        async () =>
          completedAppServerForkTargetForSource(
            dbPath,
            hostileSource as unknown as string,
          ),
        TypeError,
      );
      assert.equal(sourceCoercions, 0);

      // Additional non-string primitive tests
      for (const invalid of [
        null,
        undefined,
        123,
        true,
        Symbol(),
        [],
        {},
      ]) {
        await assert.rejects(
          async () =>
            completedAppServerForkTargetForSource(
              invalid as unknown as string,
              "src",
            ),
          TypeError,
        );
        await assert.rejects(
          async () =>
            completedAppServerForkTargetForSource(
              dbPath,
              invalid as unknown as string,
            ),
          TypeError,
        );
      }

      assert.equal(existsSync(dbPath), false);
    }),
  );

  it(
    "lone surrogate paths and source throw TypeError and malformed DB paths remain ABSENT",
    withTempDb(async ({ dbPath, tempDir }) => {
      assert.equal(existsSync(dbPath), false);
      const malformedDbPath = join(tempDir, "store-\uD800.sqlite");

      await assert.rejects(
        async () =>
          completedAppServerForkTargetForSource(malformedDbPath, "valid-source"),
        TypeError,
      );
      assert.equal(existsSync(malformedDbPath), false);
      assert.equal(existsSync(dbPath), false);

      for (const badSource of [
        "\uD800",
        "\uDFFF",
        "prefix-\uD800",
        "\uDFFF-suffix",
        "in-\uD800-middle",
      ]) {
        await assert.rejects(
          async () =>
            completedAppServerForkTargetForSource(dbPath, badSource),
          TypeError,
        );
      }

      assert.equal(existsSync(malformedDbPath), false);
      assert.equal(existsSync(dbPath), false);
    }),
  );

  it(
    "manual string iteration rejects lone surrogates even when isWellFormed is stubbed to true",
    withTempDb(async ({ dbPath }) => {
      const stringProto = String.prototype as unknown as {
        isWellFormed?: (() => boolean) | undefined;
      };
      const original = stringProto.isWellFormed;
      try {
        stringProto.isWellFormed = () => true;
        await assert.rejects(
          async () =>
            completedAppServerForkTargetForSource(dbPath, "bad-\uD800"),
          TypeError,
        );
      } finally {
        stringProto.isWellFormed = original;
      }
    }),
  );

  it(
    "honest persisted encoding UTF-16le sentinel before closing + verify PRAGMA actual before and after",
    withTempDb(async ({ tempDir }) => {
      const utf16lePath = join(tempDir, "utf16le-store.sqlite");
      const setupDb = new DatabaseSync(utf16lePath);
      try {
        setupDb.exec("PRAGMA encoding = 'UTF-16le';");
        setupDb.exec("CREATE TABLE encoding_sentinel (id INTEGER PRIMARY KEY);");
        assert.equal(getPragmaEncoding(setupDb), "UTF-16le");
      } finally {
        setupDb.close();
      }

      const initDb = await openInitialized(utf16lePath);
      try {
        assert.equal(getPragmaEncoding(initDb), "UTF-16le");
        ensureForkHandoffTable(initDb);
        const insertStmt = initDb.prepare(`INSERT INTO codex_thread_fork_handoffs (
          handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
          discord_channel_id, discord_thread_id, quarantine_reason,
          last_fork_error, fork_failure_ambiguous, observed_target_thread_id,
          target_thread_id, completed_generation, created_at, completed_at
        ) VALUES ('h-16le', NULL, 'src-16le', 1, 100, 200, 'none', '', 0, 'tgt-16le-🎯-αβγ', 'tgt-16le-🎯-αβγ', 1, 1000.0, 1000.0)`);
        insertStmt.run();
      } finally {
        initDb.close();
      }

      const target = await completedAppServerForkTargetForSource(
        utf16lePath,
        "src-16le",
      );
      assert.equal(target, "tgt-16le-🎯-αβγ");

      const verifyDb = new DatabaseSync(utf16lePath);
      try {
        assert.equal(getPragmaEncoding(verifyDb), "UTF-16le");
      } finally {
        verifyDb.close();
      }
    }),
  );

  it(
    "honest persisted encoding UTF-16be sentinel before closing + verify PRAGMA actual before and after",
    withTempDb(async ({ tempDir }) => {
      const utf16bePath = join(tempDir, "utf16be-store.sqlite");
      const setupDb = new DatabaseSync(utf16bePath);
      try {
        setupDb.exec("PRAGMA encoding = 'UTF-16be';");
        setupDb.exec("CREATE TABLE encoding_sentinel (id INTEGER PRIMARY KEY);");
        assert.equal(getPragmaEncoding(setupDb), "UTF-16be");
      } finally {
        setupDb.close();
      }

      const initDb = await openInitialized(utf16bePath);
      try {
        assert.equal(getPragmaEncoding(initDb), "UTF-16be");
        ensureForkHandoffTable(initDb);
        const insertStmt = initDb.prepare(`INSERT INTO codex_thread_fork_handoffs (
          handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
          discord_channel_id, discord_thread_id, quarantine_reason,
          last_fork_error, fork_failure_ambiguous, observed_target_thread_id,
          target_thread_id, completed_generation, created_at, completed_at
        ) VALUES ('h-16be', NULL, 'src-16be', 1, 100, 200, 'none', '', 0, 'tgt-16be-🚀-δεζ', 'tgt-16be-🚀-δεζ', 1, 1000.0, 1000.0)`);
        insertStmt.run();
      } finally {
        initDb.close();
      }

      const target = await completedAppServerForkTargetForSource(
        utf16bePath,
        "src-16be",
      );
      assert.equal(target, "tgt-16be-🚀-δεζ");

      const verifyDb = new DatabaseSync(utf16bePath);
      try {
        assert.equal(getPragmaEncoding(verifyDb), "UTF-16be");
      } finally {
        verifyDb.close();
      }
    }),
  );

  it(
    "real malformed holds native fixture: after openInitialized build codex_dead_generation_holds with wrong column fails prepare before fork ensure",
    withTempDb(async ({ dbPath }) => {
      const db = await openInitialized(dbPath);
      try {
        // Drop standard table and replace with table having wrong column
        db.exec("DROP TABLE IF EXISTS codex_dead_generation_holds;");
        db.exec(
          "CREATE TABLE codex_dead_generation_holds (corrupt_column TEXT);",
        );
      } finally {
        db.close();
      }

      await assert.rejects(
        async () => completedAppServerForkTargetForSource(dbPath, "src-query-err"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /no such column: target_thread_id/);
          return true;
        },
      );

      // Verify codex_thread_fork_handoffs table was NEVER created (assert fork table ABSENT)
      // and actual bad table preserved
      const verifyDb = new DatabaseSync(dbPath);
      try {
        const forkTableStmt = verifyDb.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_thread_fork_handoffs'",
        );
        forkTableStmt.setReadBigInts(true);
        assert.equal(forkTableStmt.get(), undefined);

        const cols = getColumnNames(verifyDb, "codex_dead_generation_holds");
        assert.deepEqual(cols, ["corrupt_column"]);
      } finally {
        verifyDb.close();
      }
    }),
  );

  it(
    "writer lock busy then release in same process allows wrapper retry without external process",
    withTempDb(async ({ dbPath }) => {
      const db = await openInitialized(dbPath);
      try {
        ensureForkHandoffTable(db);
        db.prepare(`INSERT INTO codex_thread_fork_handoffs (
          handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
          discord_channel_id, discord_thread_id, quarantine_reason,
          last_fork_error, fork_failure_ambiguous, observed_target_thread_id,
          target_thread_id, completed_generation, created_at, completed_at
        ) VALUES ('h-busy', NULL, 'src-busy', 1, 100, 200, 'none', '', 0, 'tgt-busy', 'tgt-busy', 1, 1000.0, 1000.0)`).run();
      } finally {
        db.close();
      }

      const owner = new DatabaseSync(dbPath);
      owner.exec("BEGIN IMMEDIATE;");
      try {
        await assert.rejects(
          async () => completedAppServerForkTargetForSource(dbPath, "src-busy"),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /busy|locked/i);
            return true;
          },
        );
      } finally {
        try {
          owner.exec("ROLLBACK;");
        } finally {
          owner.close();
        }
      }

      const target = await completedAppServerForkTargetForSource(
        dbPath,
        "src-busy",
      );
      assert.equal(target, "tgt-busy");
    }),
  );
});
