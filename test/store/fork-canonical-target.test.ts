import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  canonicalCompletedTargetIn,
  ForkHandoffCycleError,
} from "../../src/store/fork-canonical-target.ts";
import { DeadGenerationTargetHeldError } from "../../src/store/fork-completed-target.ts";
import { ensureForkHandoffTable } from "../../src/store/fork-handoff-admission.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";

interface InsertHandoffOptions {
  handoffId: string;
  ambiguousJobId?: string | null | undefined;
  sourceThreadId: string;
  expectedGeneration?: bigint | undefined;
  discordChannelId?: bigint | undefined;
  discordThreadId?: bigint | undefined;
  quarantineReason?: string | undefined;
  lastForkError?: string | undefined;
  forkFailureAmbiguous?: number | undefined;
  observedTargetThreadId?: string | null | undefined;
  targetThreadId?: string | null | undefined;
  completedGeneration?: bigint | null | undefined;
  createdAt?: number | undefined;
  completedAt?: number | null | undefined;
}

function insertHandoff(db: DatabaseSync, options: InsertHandoffOptions): void {
  const {
    handoffId,
    ambiguousJobId = null,
    sourceThreadId,
    expectedGeneration = 1n,
    discordChannelId = 1001n,
    discordThreadId = 2002n,
    quarantineReason = "manual_fork",
    lastForkError = "",
    forkFailureAmbiguous = 0,
    observedTargetThreadId = null,
    targetThreadId = null,
    completedGeneration = null,
    createdAt = 1000.0,
    completedAt = null,
  } = options;

  db.prepare(
    `INSERT INTO codex_thread_fork_handoffs (
      handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
      discord_channel_id, discord_thread_id, quarantine_reason, last_fork_error,
      fork_failure_ambiguous, observed_target_thread_id, target_thread_id,
      completed_generation, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    handoffId,
    ambiguousJobId,
    sourceThreadId,
    expectedGeneration,
    discordChannelId,
    discordThreadId,
    quarantineReason,
    lastForkError,
    forkFailureAmbiguous,
    observedTargetThreadId,
    targetThreadId,
    completedGeneration,
    createdAt,
    completedAt,
  );
}

async function createOwnedDb(initSql?: string | undefined): Promise<{
  db: DatabaseSync;
  dbPath: string;
  tmpDir: string;
  realOsTmp: string;
  closeAndCleanup: () => Promise<void>;
}> {
  const realOsTmp = await fs.realpath(os.tmpdir());
  const tmpDir = await fs.realpath(
    await fs.mkdtemp(path.join(realOsTmp, "fork-canon-test-")),
  );
  const dbPath = path.join(tmpDir, "store.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_dead_generation_holds (
      target_thread_id TEXT PRIMARY KEY
    );
  `);
  if (initSql !== undefined) {
    db.exec(initSql);
  }
  let cleaned = false;
  const closeAndCleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      db.close();
    } catch {
      // safe ignore on double close
    }
    const realCurrent = await fs.realpath(tmpDir);
    assert.strictEqual(realCurrent, tmpDir);
    assert.strictEqual(path.dirname(realCurrent), realOsTmp);
    await fs.rm(tmpDir, { recursive: true, force: true });
  };
  return { db, dbPath, tmpDir, realOsTmp, closeAndCleanup };
}

async function createOwnedRawDb(): Promise<{
  db: DatabaseSync;
  dbPath: string;
  tmpDir: string;
  realOsTmp: string;
  closeAndCleanup: () => Promise<void>;
}> {
  const realOsTmp = await fs.realpath(os.tmpdir());
  const tmpDir = await fs.realpath(
    await fs.mkdtemp(path.join(realOsTmp, "fork-canon-raw-")),
  );
  const dbPath = path.join(tmpDir, "raw.sqlite");
  const db = new DatabaseSync(dbPath);
  let cleaned = false;
  const closeAndCleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      db.close();
    } catch {
      // safe ignore on double close
    }
    const realCurrent = await fs.realpath(tmpDir);
    assert.strictEqual(realCurrent, tmpDir);
    assert.strictEqual(path.dirname(realCurrent), realOsTmp);
    await fs.rm(tmpDir, { recursive: true, force: true });
  };
  return { db, dbPath, tmpDir, realOsTmp, closeAndCleanup };
}

function migrateDeadGeneration(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS codex_app_server_runtime (\n            singleton INTEGER PRIMARY KEY CHECK(singleton = 1), runtime_id TEXT NOT NULL);\n         CREATE TABLE IF NOT EXISTS codex_dead_generation_incidents (\n            runtime_id TEXT NOT NULL, generation INTEGER NOT NULL,\n            snapshot_json TEXT NOT NULL, queue_jobs_json TEXT NOT NULL,\n            created_at REAL NOT NULL, PRIMARY KEY(runtime_id, generation));\n         CREATE TABLE IF NOT EXISTS codex_dead_generation_holds (\n            target_thread_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL,\n            generation INTEGER NOT NULL, created_at REAL NOT NULL);",
  );
}

describe("canonicalCompletedTargetIn", () => {
  it("absent routing table and no handoff returns exact source and ensures fork schema", async () => {
    const fixture = await createOwnedRawDb();
    try {
      const { db } = fixture;
      db.exec(
        "CREATE TABLE codex_dead_generation_holds (target_thread_id TEXT PRIMARY KEY);",
      );
      const checkBefore = db
        .prepare(
          "SELECT count(*) AS cnt FROM sqlite_master WHERE type='table' AND name='codex_thread_fork_handoffs'",
        )
        .get() as { cnt: number };
      assert.strictEqual(checkBefore.cnt, 0);

      const result = canonicalCompletedTargetIn(db, "source-alone");
      assert.strictEqual(result, "source-alone");

      const checkAfter = db
        .prepare(
          "SELECT count(*) AS cnt FROM sqlite_master WHERE type='table' AND name='codex_thread_fork_handoffs'",
        )
        .get() as { cnt: number };
      assert.strictEqual(checkAfter.cnt, 1);

      const cols = db
        .prepare("SELECT name FROM pragma_table_info('codex_thread_fork_handoffs')")
        .all() as { name: string }[];
      const colNames = new Set(cols.map((c) => c.name));
      assert.ok(colNames.has("observed_target_thread_id"));
      assert.ok(colNames.has("last_fork_error"));
      assert.ok(colNames.has("fork_failure_ambiguous"));
      assert.ok(colNames.has("target_thread_id"));
      assert.ok(colNames.has("completed_at"));
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("follows completed chain A -> B -> C and returns terminal C", async () => {
    const fixture = await createOwnedDb();
    try {
      const { db } = fixture;
      ensureForkHandoffTable(db);
      insertHandoff(db, {
        handoffId: "h-ab",
        sourceThreadId: "thread-A",
        targetThreadId: "thread-B",
        observedTargetThreadId: "thread-B",
        completedGeneration: 1n,
        completedAt: 1000.0,
      });
      insertHandoff(db, {
        handoffId: "h-bc",
        sourceThreadId: "thread-B",
        targetThreadId: "thread-C",
        observedTargetThreadId: "thread-C",
        completedGeneration: 2n,
        completedAt: 2000.0,
      });
      const result = canonicalCompletedTargetIn(db, "thread-A");
      assert.strictEqual(result, "thread-C");
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("stops at current thread when handoff has completed_at null (unresolved)", async () => {
    const fixture = await createOwnedDb();
    try {
      const { db } = fixture;
      ensureForkHandoffTable(db);
      insertHandoff(db, {
        handoffId: "h-pending",
        sourceThreadId: "thread-unresolved",
        targetThreadId: null,
        observedTargetThreadId: null,
        completedGeneration: null,
        completedAt: null,
      });
      const result = canonicalCompletedTargetIn(db, "thread-unresolved");
      assert.strictEqual(result, "thread-unresolved");
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("stops at intermediate thread when next hop has completed_at null", async () => {
    const fixture = await createOwnedDb();
    try {
      const { db } = fixture;
      ensureForkHandoffTable(db);
      insertHandoff(db, {
        handoffId: "h-step1",
        sourceThreadId: "step-1",
        targetThreadId: "step-2",
        observedTargetThreadId: "step-2",
        completedGeneration: 1n,
        completedAt: 1000.0,
      });
      insertHandoff(db, {
        handoffId: "h-step2-unresolved",
        sourceThreadId: "step-2",
        targetThreadId: null,
        observedTargetThreadId: null,
        completedGeneration: null,
        completedAt: null,
      });
      const result = canonicalCompletedTargetIn(db, "step-1");
      assert.strictEqual(result, "step-2");
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("throws ForkHandoffCycleError on direct self cycle with exact properties and display", async () => {
    const fixture = await createOwnedDb();
    try {
      const { db } = fixture;
      ensureForkHandoffTable(db);
      insertHandoff(db, {
        handoffId: "h-self",
        sourceThreadId: "cycle-self",
        targetThreadId: "cycle-self",
        observedTargetThreadId: "cycle-self",
        completedGeneration: 1n,
        completedAt: 1000.0,
      });
      assert.throws(
        () => canonicalCompletedTargetIn(db, "cycle-self"),
        (err: unknown) => {
          assert.ok(err instanceof ForkHandoffCycleError);
          assert.strictEqual(err.kind, "ForkHandoffCycle");
          assert.strictEqual(err.name, "ForkHandoffCycleError");
          assert.strictEqual(err.sourceThreadId, "cycle-self");
          assert.strictEqual(
            err.message,
            "completed app-server fork handoff cycle from cycle-self",
          );
          return true;
        },
      );
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("throws ForkHandoffCycleError on multihop cycle preserving original source and display", async () => {
    const fixture = await createOwnedDb();
    try {
      const { db } = fixture;
      ensureForkHandoffTable(db);
      insertHandoff(db, {
        handoffId: "h-ab",
        sourceThreadId: "hop-A",
        targetThreadId: "hop-B",
        observedTargetThreadId: "hop-B",
        completedGeneration: 1n,
        completedAt: 1000.0,
      });
      insertHandoff(db, {
        handoffId: "h-bc",
        sourceThreadId: "hop-B",
        targetThreadId: "hop-C",
        observedTargetThreadId: "hop-C",
        completedGeneration: 2n,
        completedAt: 2000.0,
      });
      insertHandoff(db, {
        handoffId: "h-ca",
        sourceThreadId: "hop-C",
        targetThreadId: "hop-A",
        observedTargetThreadId: "hop-A",
        completedGeneration: 3n,
        completedAt: 3000.0,
      });
      assert.throws(
        () => canonicalCompletedTargetIn(db, "hop-A"),
        (err: unknown) => {
          assert.ok(err instanceof ForkHandoffCycleError);
          assert.strictEqual(err.kind, "ForkHandoffCycle");
          assert.strictEqual(err.name, "ForkHandoffCycleError");
          assert.strictEqual(err.sourceThreadId, "hop-A");
          assert.strictEqual(
            err.message,
            "completed app-server fork handoff cycle from hop-A",
          );
          return true;
        },
      );
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("throws ForkHandoffCycleError naming original entry source on tail cycle", async () => {
    const fixture = await createOwnedRawDb();
    try {
      const { db } = fixture;
      db.exec(`
        CREATE TABLE codex_dead_generation_holds (
          target_thread_id TEXT PRIMARY KEY
        );
        CREATE TABLE codex_thread_fork_handoffs (
          handoff_id TEXT PRIMARY KEY,
          ambiguous_job_id TEXT,
          source_thread_id TEXT NOT NULL,
          expected_generation INTEGER,
          discord_channel_id INTEGER,
          discord_thread_id INTEGER,
          quarantine_reason TEXT,
          last_fork_error TEXT,
          fork_failure_ambiguous INTEGER,
          observed_target_thread_id TEXT,
          target_thread_id TEXT,
          completed_generation INTEGER,
          created_at REAL,
          completed_at REAL
        );
      `);
      insertHandoff(db, {
        handoffId: "h-sx",
        sourceThreadId: "tail-S",
        targetThreadId: "tail-X",
        observedTargetThreadId: "tail-X",
        completedGeneration: 1n,
        completedAt: 1000.0,
      });
      insertHandoff(db, {
        handoffId: "h-xy",
        sourceThreadId: "tail-X",
        targetThreadId: "tail-Y",
        observedTargetThreadId: "tail-Y",
        completedGeneration: 2n,
        completedAt: 2000.0,
      });
      insertHandoff(db, {
        handoffId: "h-yx",
        sourceThreadId: "tail-Y",
        targetThreadId: "tail-X",
        observedTargetThreadId: "tail-X",
        completedGeneration: 3n,
        completedAt: 3000.0,
      });
      assert.throws(
        () => canonicalCompletedTargetIn(db, "tail-S"),
        (err: unknown) => {
          assert.ok(err instanceof ForkHandoffCycleError);
          assert.strictEqual(err.kind, "ForkHandoffCycle");
          assert.strictEqual(err.name, "ForkHandoffCycleError");
          assert.strictEqual(err.sourceThreadId, "tail-S");
          assert.strictEqual(
            err.message,
            "completed app-server fork handoff cycle from tail-S",
          );
          return true;
        },
      );
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("aborts at SOURCE target hold before query", async () => {
    const fixture = await createOwnedDb();
    try {
      const { db } = fixture;
      ensureForkHandoffTable(db);
      db.prepare(
        "INSERT INTO codex_dead_generation_holds (target_thread_id) VALUES (?)",
      ).run("held-source");
      insertHandoff(db, {
        handoffId: "h-src",
        sourceThreadId: "held-source",
        targetThreadId: "held-target",
        observedTargetThreadId: "held-target",
        completedGeneration: 1n,
        completedAt: 1000.0,
      });
      assert.throws(
        () => canonicalCompletedTargetIn(db, "held-source"),
        (err: unknown) => {
          assert.ok(err instanceof DeadGenerationTargetHeldError);
          assert.strictEqual(err.kind, "DeadGenerationTargetHeld");
          assert.strictEqual(err.name, "DeadGenerationTargetHeldError");
          assert.strictEqual(err.targetThreadId, "held-source");
          assert.strictEqual(
            err.message,
            "conversation held-source is on hold after app-server process loss; manual review is required",
          );
          return true;
        },
      );
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("aborts at intermediate target hold before preparing next hop query", async () => {
    const fixture = await createOwnedDb();
    try {
      const { db } = fixture;
      ensureForkHandoffTable(db);
      db.prepare(
        "INSERT INTO codex_dead_generation_holds (target_thread_id) VALUES (?)",
      ).run("node-B");
      insertHandoff(db, {
        handoffId: "h-ab",
        sourceThreadId: "node-A",
        targetThreadId: "node-B",
        observedTargetThreadId: "node-B",
        completedGeneration: 1n,
        completedAt: 1000.0,
      });
      insertHandoff(db, {
        handoffId: "h-bc",
        sourceThreadId: "node-B",
        targetThreadId: "node-C",
        observedTargetThreadId: "node-C",
        completedGeneration: 2n,
        completedAt: 2000.0,
      });
      assert.throws(
        () => canonicalCompletedTargetIn(db, "node-A"),
        (err: unknown) => {
          assert.ok(err instanceof DeadGenerationTargetHeldError);
          assert.strictEqual(err.kind, "DeadGenerationTargetHeld");
          assert.strictEqual(err.name, "DeadGenerationTargetHeldError");
          assert.strictEqual(err.targetThreadId, "node-B");
          assert.strictEqual(
            err.message,
            "conversation node-B is on hold after app-server process loss; manual review is required",
          );
          return true;
        },
      );
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("aborts at terminal target hold before return even without subsequent handoff", async () => {
    const fixture = await createOwnedDb();
    try {
      const { db } = fixture;
      ensureForkHandoffTable(db);
      db.prepare(
        "INSERT INTO codex_dead_generation_holds (target_thread_id) VALUES (?)",
      ).run("terminal-B");
      insertHandoff(db, {
        handoffId: "h-ab",
        sourceThreadId: "terminal-A",
        targetThreadId: "terminal-B",
        observedTargetThreadId: "terminal-B",
        completedGeneration: 1n,
        completedAt: 1000.0,
      });
      assert.throws(
        () => canonicalCompletedTargetIn(db, "terminal-A"),
        (err: unknown) => {
          assert.ok(err instanceof DeadGenerationTargetHeldError);
          assert.strictEqual(err.kind, "DeadGenerationTargetHeld");
          assert.strictEqual(err.name, "DeadGenerationTargetHeldError");
          assert.strictEqual(err.targetThreadId, "terminal-B");
          assert.strictEqual(
            err.message,
            "conversation terminal-B is on hold after app-server process loss; manual review is required",
          );
          return true;
        },
      );
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("ignores runtime incidents and unheld dead generation tables when target hold absent", async () => {
    const fixture = await createOwnedRawDb();
    try {
      const { db } = fixture;
      migrateDeadGeneration(db);
      db.prepare(
        "INSERT INTO codex_app_server_runtime (singleton, runtime_id) VALUES (?, ?)",
      ).run(1, "runtime-test-1");
      db.prepare(
        "INSERT INTO codex_dead_generation_incidents (runtime_id, generation, snapshot_json, queue_jobs_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("runtime-test-1", 999, '{"threads":[]}', "[]", 1000.0);
      ensureForkHandoffTable(db);
      insertHandoff(db, {
        handoffId: "h-run-a",
        sourceThreadId: "run-A",
        targetThreadId: "run-B",
        observedTargetThreadId: "run-B",
        completedGeneration: 999n,
        completedAt: 1000.0,
      });
      const res = canonicalCompletedTargetIn(db, "run-A");
      assert.strictEqual(res, "run-B");
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("shortcircuits to exact source when exact routing table exists even if empty or malformed columns and fork table malformed", async () => {
    const fixture = await createOwnedRawDb();
    try {
      const { db } = fixture;
      db.exec(`
        CREATE TABLE codex_dead_generation_holds (target_thread_id TEXT PRIMARY KEY);
        CREATE TABLE codex_exact_thread_routing (bogus_col TEXT, malformed_col INTEGER);
        CREATE TABLE codex_thread_fork_handoffs (completely_broken_schema INTEGER);
      `);
      const res = canonicalCompletedTargetIn(db, "exact-source-ok");
      assert.strictEqual(res, "exact-source-ok");
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("still enforces source hold when exact routing table exists even if fork table is malformed", async () => {
    const fixture = await createOwnedRawDb();
    try {
      const { db } = fixture;
      db.exec(`
        CREATE TABLE codex_dead_generation_holds (target_thread_id TEXT PRIMARY KEY);
        INSERT INTO codex_dead_generation_holds (target_thread_id) VALUES ('held-exact-source');
        CREATE TABLE codex_exact_thread_routing (dummy INTEGER);
        CREATE TABLE codex_thread_fork_handoffs (malformed TEXT);
      `);
      assert.throws(
        () => canonicalCompletedTargetIn(db, "held-exact-source"),
        (err: unknown) => {
          assert.ok(err instanceof DeadGenerationTargetHeldError);
          assert.strictEqual(err.kind, "DeadGenerationTargetHeld");
          assert.strictEqual(err.name, "DeadGenerationTargetHeldError");
          assert.strictEqual(err.targetThreadId, "held-exact-source");
          return true;
        },
      );
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("does not treat VIEW with codex_exact_thread_routing name as table and follows legacy fork chain without writes", async () => {
    const fixture = await createOwnedDb();
    try {
      const { db } = fixture;
      db.exec(
        "CREATE VIEW codex_exact_thread_routing AS SELECT 1 AS enabled;",
      );
      ensureForkHandoffTable(db);
      insertHandoff(db, {
        handoffId: "h-view-1",
        sourceThreadId: "view-source",
        targetThreadId: "view-target",
        observedTargetThreadId: "view-target",
        completedGeneration: 1n,
        completedAt: 1000.0,
      });
      const countBefore = (
        db
          .prepare(
            "SELECT count(*) AS cnt FROM codex_thread_fork_handoffs",
          )
          .get() as { cnt: number }
      ).cnt;
      const res = canonicalCompletedTargetIn(db, "view-source");
      assert.strictEqual(res, "view-target");
      const countAfter = (
        db
          .prepare(
            "SELECT count(*) AS cnt FROM codex_thread_fork_handoffs",
          )
          .get() as { cnt: number }
      ).cnt;
      assert.strictEqual(countBefore, countAfter);
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("ordering regression: hold check occurs before target query preparation on legacy table missing target_thread_id", async () => {
    const fixture = await createOwnedRawDb();
    try {
      const { db } = fixture;
      db.exec(`
        CREATE TABLE codex_dead_generation_holds (
          target_thread_id TEXT PRIMARY KEY
        );
        INSERT INTO codex_dead_generation_holds (target_thread_id) VALUES ('held-legacy-source');
        CREATE TABLE codex_thread_fork_handoffs (
          handoff_id TEXT PRIMARY KEY,
          source_thread_id TEXT NOT NULL,
          completed_at REAL
        );
      `);
      assert.throws(
        () => canonicalCompletedTargetIn(db, "held-legacy-source"),
        (err: unknown) => {
          assert.ok(err instanceof DeadGenerationTargetHeldError);
          assert.strictEqual(err.kind, "DeadGenerationTargetHeld");
          assert.strictEqual(err.targetThreadId, "held-legacy-source");
          return true;
        },
      );
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("runs inside borrowed caller transaction; helper ensures schema and caller ROLLBACK undoes column effects while connection remains usable", async () => {
    const fixture = await createOwnedRawDb();
    try {
      const { db } = fixture;
      db.exec(`
        CREATE TABLE codex_dead_generation_holds (target_thread_id TEXT PRIMARY KEY);
        CREATE TABLE codex_thread_fork_handoffs (
          handoff_id TEXT PRIMARY KEY,
          source_thread_id TEXT NOT NULL UNIQUE,
          target_thread_id TEXT UNIQUE,
          completed_at REAL
        );
      `);
      db.exec("BEGIN IMMEDIATE;");

      const res = canonicalCompletedTargetIn(db, "tx-source");
      assert.strictEqual(res, "tx-source");

      let cols = (
        db
          .prepare(
            "SELECT name FROM pragma_table_info('codex_thread_fork_handoffs')",
          )
          .all() as { name: string }[]
      ).map((c) => c.name);
      assert.ok(cols.includes("last_fork_error"));
      assert.ok(cols.includes("observed_target_thread_id"));
      assert.ok(cols.includes("fork_failure_ambiguous"));

      db.exec("ROLLBACK;");

      cols = (
        db
          .prepare(
            "SELECT name FROM pragma_table_info('codex_thread_fork_handoffs')",
          )
          .all() as { name: string }[]
      ).map((c) => c.name);
      assert.ok(!cols.includes("last_fork_error"));
      assert.ok(!cols.includes("observed_target_thread_id"));
      assert.ok(!cols.includes("fork_failure_ambiguous"));

      const usableCheck = db.prepare("SELECT 777 AS val").get() as {
        val: number;
      };
      assert.strictEqual(usableCheck.val, 777);
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("preserves caller transaction on error allowing caller ROLLBACK and keeping connection usable", async () => {
    const fixture = await createOwnedRawDb();
    try {
      const { db } = fixture;
      db.exec(`
        CREATE TABLE codex_dead_generation_holds (target_thread_id TEXT PRIMARY KEY);
        INSERT INTO codex_dead_generation_holds (target_thread_id) VALUES ('held-in-tx');
        CREATE TABLE codex_thread_fork_handoffs (
          handoff_id TEXT PRIMARY KEY,
          source_thread_id TEXT NOT NULL UNIQUE,
          target_thread_id TEXT UNIQUE,
          completed_at REAL
        );
      `);
      db.exec("BEGIN IMMEDIATE;");

      assert.throws(
        () => canonicalCompletedTargetIn(db, "held-in-tx"),
        (err: unknown) => err instanceof DeadGenerationTargetHeldError,
      );

      db.exec("ROLLBACK;");

      const usableCheck = db.prepare("SELECT 888 AS val").get() as {
        val: number;
      };
      assert.strictEqual(usableCheck.val, 888);
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("throws StoreIntegrityError when selected target_thread_id is SQL NULL on completed handoff", async () => {
    const fixture = await createOwnedRawDb();
    try {
      const { db } = fixture;
      db.exec(`
        CREATE TABLE codex_dead_generation_holds (target_thread_id TEXT PRIMARY KEY);
        CREATE TABLE codex_thread_fork_handoffs (
          handoff_id TEXT PRIMARY KEY,
          source_thread_id TEXT NOT NULL,
          target_thread_id TEXT,
          completed_at REAL
        );
        INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, target_thread_id, completed_at)
        VALUES ('h-null', 'src-null-target', NULL, 1000.0);
      `);
      assert.throws(
        () => canonicalCompletedTargetIn(db, "src-null-target"),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match(
            err.message,
            /Expected string for column target_thread_id, received null/,
          );
          return true;
        },
      );
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("throws StoreIntegrityError when selected target_thread_id is BLOB storage class type failure", async () => {
    const fixture = await createOwnedRawDb();
    try {
      const { db } = fixture;
      db.exec(`
        CREATE TABLE codex_dead_generation_holds (target_thread_id TEXT PRIMARY KEY);
        CREATE TABLE codex_thread_fork_handoffs (
          handoff_id TEXT PRIMARY KEY,
          source_thread_id TEXT NOT NULL,
          target_thread_id BLOB,
          completed_at REAL
        );
        INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, target_thread_id, completed_at)
        VALUES ('h-bad-blob', 'src-bad-blob', X'FFFF', 1000.0);
      `);
      assert.throws(
        () => canonicalCompletedTargetIn(db, "src-bad-blob"),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          return true;
        },
      );
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("throws StoreIntegrityError on malformed TEXT CAST(X'FF' AS TEXT) decoder regression with SQL typeof TEXT proof", async () => {
    const fixture = await createOwnedRawDb();
    try {
      const { db } = fixture;
      db.exec(`
        CREATE TABLE codex_dead_generation_holds (target_thread_id TEXT PRIMARY KEY);
        CREATE TABLE codex_thread_fork_handoffs (
          handoff_id TEXT PRIMARY KEY,
          source_thread_id TEXT NOT NULL,
          target_thread_id TEXT,
          completed_at REAL
        );
        INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, target_thread_id, completed_at)
        VALUES ('h-bad-text', 'src-bad-text', CAST(X'FF' AS TEXT), 1000.0);
      `);
      const typeCheck = db
        .prepare(
          "SELECT typeof(target_thread_id) AS col_type FROM codex_thread_fork_handoffs WHERE source_thread_id = 'src-bad-text'",
        )
        .get() as { col_type: string };
      assert.strictEqual(typeCheck.col_type, "text");

      assert.throws(
        () => canonicalCompletedTargetIn(db, "src-bad-text"),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          return true;
        },
      );
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("ignores unrelated corrupt rows in table when queried source has clean data", async () => {
    const fixture = await createOwnedRawDb();
    try {
      const { db } = fixture;
      db.exec(`
        CREATE TABLE codex_dead_generation_holds (target_thread_id TEXT PRIMARY KEY);
        CREATE TABLE codex_thread_fork_handoffs (
          handoff_id TEXT PRIMARY KEY,
          source_thread_id TEXT NOT NULL,
          target_thread_id TEXT,
          completed_at REAL
        );
        INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, target_thread_id, completed_at)
        VALUES ('h-corrupt-1', 'other-corrupt-null', NULL, 1000.0);
        INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, target_thread_id, completed_at)
        VALUES ('h-clean', 'clean-source', 'clean-target', 1000.0);
      `);
      const res = canonicalCompletedTargetIn(db, "clean-source");
      assert.strictEqual(res, "clean-target");
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("handles empty string, NUL byte, BOM, supplementary characters, and whitespace preserving exact identities", async () => {
    const fixture = await createOwnedDb();
    try {
      const { db } = fixture;
      ensureForkHandoffTable(db);
      const emptyStr = "";
      const nulStr = "\u0000";
      const bomStr = "\uFEFF";
      const suppStr = "\uD83D\uDE00";
      const wsStr = "   ";
      const tabNlStr = "\t\r\n";

      insertHandoff(db, {
        handoffId: "h-e-n",
        sourceThreadId: emptyStr,
        targetThreadId: nulStr,
        observedTargetThreadId: nulStr,
        completedGeneration: 1n,
        completedAt: 1000.0,
      });
      insertHandoff(db, {
        handoffId: "h-n-b",
        sourceThreadId: nulStr,
        targetThreadId: bomStr,
        observedTargetThreadId: bomStr,
        completedGeneration: 2n,
        completedAt: 2000.0,
      });
      insertHandoff(db, {
        handoffId: "h-b-s",
        sourceThreadId: bomStr,
        targetThreadId: suppStr,
        observedTargetThreadId: suppStr,
        completedGeneration: 3n,
        completedAt: 3000.0,
      });
      insertHandoff(db, {
        handoffId: "h-s-w",
        sourceThreadId: suppStr,
        targetThreadId: wsStr,
        observedTargetThreadId: wsStr,
        completedGeneration: 4n,
        completedAt: 4000.0,
      });
      insertHandoff(db, {
        handoffId: "h-w-t",
        sourceThreadId: wsStr,
        targetThreadId: tabNlStr,
        observedTargetThreadId: tabNlStr,
        completedGeneration: 5n,
        completedAt: 5000.0,
      });

      const res = canonicalCompletedTargetIn(db, emptyStr);
      assert.strictEqual(res, tabNlStr);

      insertHandoff(db, {
        handoffId: "h-id1",
        sourceThreadId: "id",
        targetThreadId: "id-exact",
        observedTargetThreadId: "id-exact",
        completedGeneration: 10n,
        completedAt: 1000.0,
      });
      insertHandoff(db, {
        handoffId: "h-id2",
        sourceThreadId: "id ",
        targetThreadId: "id-space-after",
        observedTargetThreadId: "id-space-after",
        completedGeneration: 11n,
        completedAt: 1000.0,
      });
      insertHandoff(db, {
        handoffId: "h-id3",
        sourceThreadId: " id",
        targetThreadId: "id-space-before",
        observedTargetThreadId: "id-space-before",
        completedGeneration: 12n,
        completedAt: 1000.0,
      });
      insertHandoff(db, {
        handoffId: "h-id4",
        sourceThreadId: "id\u0000",
        targetThreadId: "id-nul",
        observedTargetThreadId: "id-nul",
        completedGeneration: 13n,
        completedAt: 1000.0,
      });

      assert.strictEqual(canonicalCompletedTargetIn(db, "id"), "id-exact");
      assert.strictEqual(canonicalCompletedTargetIn(db, "id "), "id-space-after");
      assert.strictEqual(canonicalCompletedTargetIn(db, " id"), "id-space-before");
      assert.strictEqual(canonicalCompletedTargetIn(db, "id\u0000"), "id-nul");
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("returns first native query row when duplicate source rows exist in legacy table without duplicate guard", async () => {
    const fixture = await createOwnedRawDb();
    try {
      const { db } = fixture;
      db.exec(`
        CREATE TABLE codex_dead_generation_holds (target_thread_id TEXT PRIMARY KEY);
        CREATE TABLE codex_thread_fork_handoffs (
          handoff_id TEXT PRIMARY KEY,
          source_thread_id TEXT NOT NULL,
          target_thread_id TEXT,
          completed_at REAL
        );
        INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, target_thread_id, completed_at)
        VALUES ('dup-1', 'same-source', 'first-target', 1000.0);
        INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, target_thread_id, completed_at)
        VALUES ('dup-2', 'same-source', 'second-target', 2000.0);
      `);
      const res = canonicalCompletedTargetIn(db, "same-source");
      assert.strictEqual(res, "first-target");
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("resolves finite long chain (40 hops) without artificial hop count cap", async () => {
    const fixture = await createOwnedDb();
    try {
      const { db } = fixture;
      ensureForkHandoffTable(db);
      const totalHops = 40;
      for (let i = 0; i < totalHops; i++) {
        const src = `chain-node-${i.toString().padStart(3, "0")}`;
        const tgt = `chain-node-${(i + 1).toString().padStart(3, "0")}`;
        insertHandoff(db, {
          handoffId: `h-chain-${i}`,
          sourceThreadId: src,
          targetThreadId: tgt,
          observedTargetThreadId: tgt,
          completedGeneration: BigInt(i + 1),
          completedAt: 1000.0 + i,
        });
      }
      const res = canonicalCompletedTargetIn(db, "chain-node-000");
      assert.strictEqual(res, "chain-node-040");
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("persists and decodes correctly in UTF-16le database verifying encoding before close and after reopen", async () => {
    const fixture = await createOwnedRawDb();
    let reopenedDb: DatabaseSync | undefined;
    try {
      const { db, dbPath } = fixture;
      db.exec("PRAGMA encoding = 'UTF-16le';");
      db.exec(`
        CREATE TABLE sentinel (id INTEGER PRIMARY KEY, msg TEXT);
        INSERT INTO sentinel VALUES (1, 'sentinel_utf16le');
        CREATE TABLE codex_dead_generation_holds (target_thread_id TEXT PRIMARY KEY);
      `);
      ensureForkHandoffTable(db);
      insertHandoff(db, {
        handoffId: "h-u16le",
        sourceThreadId: "src-utf16le",
        targetThreadId: "tgt-utf16le",
        observedTargetThreadId: "tgt-utf16le",
        completedGeneration: 1n,
        completedAt: 1000.0,
      });

      const encBefore = (
        db.prepare("PRAGMA encoding").get() as { encoding: string }
      ).encoding;
      assert.strictEqual(encBefore, "UTF-16le");

      db.close();

      reopenedDb = new DatabaseSync(dbPath);
      const encAfter = (
        reopenedDb.prepare("PRAGMA encoding").get() as { encoding: string }
      ).encoding;
      assert.strictEqual(encAfter, "UTF-16le");

      const res = canonicalCompletedTargetIn(reopenedDb, "src-utf16le");
      assert.strictEqual(res, "tgt-utf16le");
    } finally {
      if (reopenedDb) {
        try {
          reopenedDb.close();
        } catch {
          // ignore
        }
      }
      await fixture.closeAndCleanup();
    }
  });

  it("persists and decodes correctly in UTF-16be database verifying encoding before close and after reopen", async () => {
    const fixture = await createOwnedRawDb();
    let reopenedDb: DatabaseSync | undefined;
    try {
      const { db, dbPath } = fixture;
      db.exec("PRAGMA encoding = 'UTF-16be';");
      db.exec(`
        CREATE TABLE sentinel (id INTEGER PRIMARY KEY, msg TEXT);
        INSERT INTO sentinel VALUES (1, 'sentinel_utf16be');
        CREATE TABLE codex_dead_generation_holds (target_thread_id TEXT PRIMARY KEY);
      `);
      ensureForkHandoffTable(db);
      insertHandoff(db, {
        handoffId: "h-u16be",
        sourceThreadId: "src-utf16be",
        targetThreadId: "tgt-utf16be",
        observedTargetThreadId: "tgt-utf16be",
        completedGeneration: 1n,
        completedAt: 1000.0,
      });

      const encBefore = (
        db.prepare("PRAGMA encoding").get() as { encoding: string }
      ).encoding;
      assert.strictEqual(encBefore, "UTF-16be");

      db.close();

      reopenedDb = new DatabaseSync(dbPath);
      const encAfter = (
        reopenedDb.prepare("PRAGMA encoding").get() as { encoding: string }
      ).encoding;
      assert.strictEqual(encAfter, "UTF-16be");

      const res = canonicalCompletedTargetIn(reopenedDb, "src-utf16be");
      assert.strictEqual(res, "tgt-utf16be");
    } finally {
      if (reopenedDb) {
        try {
          reopenedDb.close();
        } catch {
          // ignore
        }
      }
      await fixture.closeAndCleanup();
    }
  });

  it("rejects non-string and lone-surrogate inputs before any borrowed schema effects", async () => {
    const fixture = await createOwnedRawDb();
    try {
      const { db } = fixture;
      const invalidInputs: unknown[] = [
        null,
        undefined,
        12345,
        12345n,
        true,
        {},
        [],
        "\uD800",
        "\uDFFF",
        "bad\uD800string",
        "bad\uDC00string",
        "\uD83D",
        "\uD800\u0020",
      ];

      for (const input of invalidInputs) {
        assert.throws(
          () => canonicalCompletedTargetIn(db, input as string),
          (err: unknown) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /Expected a well-formed string/);
            return true;
          },
        );
      }

      const tableCount = (
        db
          .prepare(
            "SELECT count(*) AS cnt FROM sqlite_master WHERE type='table'",
          )
          .get() as { cnt: number }
      ).cnt;
      assert.strictEqual(tableCount, 0);

      db.exec(
        "CREATE TABLE codex_dead_generation_holds (target_thread_id TEXT PRIMARY KEY);",
      );
      const fakePath = "C:\\Windows\\System32\\nonexistent.sqlite";
      const res = canonicalCompletedTargetIn(db, fakePath);
      assert.strictEqual(res, fakePath);
    } finally {
      await fixture.closeAndCleanup();
    }
  });

  it("proves helper never calls db.close by verifying subsequent caller statements succeed on same handle", async () => {
    const fixture = await createOwnedDb();
    try {
      const { db } = fixture;
      ensureForkHandoffTable(db);
      const res = canonicalCompletedTargetIn(db, "unclosed-test");
      assert.strictEqual(res, "unclosed-test");

      db.exec(
        "CREATE TABLE caller_usability_proof (id INTEGER PRIMARY KEY, note TEXT);",
      );
      db.prepare("INSERT INTO caller_usability_proof VALUES (?, ?)").run(
        1,
        "alive",
      );
      const row = db
        .prepare("SELECT note FROM caller_usability_proof WHERE id = 1")
        .get() as { note: string };
      assert.strictEqual(row.note, "alive");
    } finally {
      await fixture.closeAndCleanup();
    }
  });
});
