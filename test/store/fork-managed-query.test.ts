import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { holdIn } from "../../src/store/execution-hold.ts";
import {
  ensureForkHandoffTableIn,
  ensureForkTableIn,
  isAppServerManagedTarget,
  managedForkTargetIn,
  managedTargetIn,
} from "../../src/store/fork-managed-query.ts";
import { openInitialized } from "../../src/store/owned-driver.ts";
import {
  containsManagedTargetIn,
  ensureManagedTargetTableIn,
} from "../../src/store/queue-managed-target.ts";

const realTmp = realpathSync(tmpdir());

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(realTmp, "fork-managed-query-test-"));
  const resolvedDir = realpathSync(dir);
  try {
    await fn(resolvedDir);
  } finally {
    if (existsSync(resolvedDir)) {
      const currentResolved = realpathSync(resolvedDir);
      const parentDir = dirname(currentResolved);
      const resolvedParent = existsSync(parentDir) ? realpathSync(parentDir) : "";
      if (!isAbsolute(currentResolved) || resolvedParent !== realTmp) {
        throw new Error(
          `Temp directory ownership mismatch: ${currentResolved} parent ${resolvedParent} !== ${realTmp}`,
        );
      }
      rmSync(currentResolved, { recursive: true, force: true });
    }
  }
}

interface InsertJobOptions {
  jobId: string;
  targetThreadId?: string | undefined;
  channelId?: bigint | undefined;
  ownerUserId?: bigint | null | undefined;
  discordMessageId?: bigint | null | undefined;
  appServerGeneration?: bigint | undefined;
  executionGeneration?: bigint | null | undefined;
  prompt?: string | undefined;
  queued?: number | undefined;
  ackSent?: number | undefined;
  state?: string | undefined;
  attemptCount?: bigint | undefined;
  turnId?: string | null | undefined;
  baselineTurnIds?: string | undefined;
  lastError?: string | undefined;
  createdAt?: number | undefined;
  updatedAt?: number | undefined;
  goalWaiting?: number | undefined;
  turnObservationGeneration?: bigint | null | undefined;
}

function insertJob(db: DatabaseSync, options: InsertJobOptions): void {
  const {
    jobId,
    targetThreadId = "target-thread-1",
    channelId = 100n,
    ownerUserId = 200n,
    discordMessageId = null,
    appServerGeneration = 1n,
    executionGeneration = null,
    prompt = "test prompt",
    queued = 1,
    ackSent = 0,
    state = "pending",
    attemptCount = 0n,
    turnId = null,
    baselineTurnIds = "[]",
    lastError = "",
    createdAt = 1000.0,
    updatedAt = 1000.0,
    goalWaiting = 0,
    turnObservationGeneration = null,
  } = options;

  db.prepare(
    `INSERT INTO codex_turn_queue (
      job_id, target_thread_id, channel_id, owner_user_id, discord_message_id,
      app_server_generation, execution_generation, prompt, queued, ack_sent,
      state, attempt_count, turn_id, baseline_turn_ids, last_error,
      created_at, updated_at, goal_waiting, turn_observation_generation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    targetThreadId,
    channelId,
    ownerUserId,
    discordMessageId,
    appServerGeneration,
    executionGeneration,
    prompt,
    queued,
    ackSent,
    state,
    attemptCount,
    turnId,
    baselineTurnIds,
    lastError,
    createdAt,
    updatedAt,
    goalWaiting,
    turnObservationGeneration,
  );
}

interface ForkHandoffSnapshotRow {
  handoff_id: string;
  ambiguous_job_id: string | null;
  source_thread_id: string;
  expected_generation: bigint;
  discord_channel_id: bigint;
  discord_thread_id: bigint;
  quarantine_reason: string;
  last_fork_error: string;
  fork_failure_ambiguous: bigint;
  observed_target_thread_id: string | null;
  target_thread_id: string | null;
  completed_generation: bigint | null;
  created_at: number;
  completed_at: number | null;
}

interface TurnQueueSnapshotRow {
  job_id: string;
  target_thread_id: string;
  channel_id: bigint;
  owner_user_id: bigint | null;
  discord_message_id: bigint | null;
  app_server_generation: bigint;
  execution_generation: bigint | null;
  prompt: string;
  queued: bigint;
  ack_sent: bigint;
  state: string;
  attempt_count: bigint;
  turn_id: string | null;
  baseline_turn_ids: string;
  last_error: string;
  created_at: number;
  updated_at: number;
  goal_waiting: bigint;
  turn_observation_generation: bigint | null;
}

interface ExecutionHoldSnapshotRow {
  job_id: string;
  target_thread_id: string;
  reason: string;
  evidence_json: string;
  created_at: bigint;
}

interface DeadGenHoldSnapshotRow {
  target_thread_id: string;
  runtime_id: string;
  generation: bigint;
  created_at: number;
}

interface ExactRoutingSnapshotRow {
  enabled: bigint;
}

interface TableSnapshots {
  forkHandoffs: ForkHandoffSnapshotRow[];
  turnQueue: TurnQueueSnapshotRow[];
  executionHolds: ExecutionHoldSnapshotRow[];
  deadGenHolds: DeadGenHoldSnapshotRow[];
  exactRouting: ExactRoutingSnapshotRow[];
}

function takeSnapshots(db: DatabaseSync): TableSnapshots {
  const forkStmt = db.prepare(
    `SELECT handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
            discord_channel_id, discord_thread_id, quarantine_reason,
            last_fork_error, fork_failure_ambiguous,
            observed_target_thread_id, target_thread_id, completed_generation,
            created_at, completed_at
     FROM codex_thread_fork_handoffs
     ORDER BY handoff_id`,
  );
  forkStmt.setReadBigInts(true);
  const forkHandoffs = forkStmt.all() as unknown as ForkHandoffSnapshotRow[];

  const queueStmt = db.prepare(
    `SELECT job_id, target_thread_id, channel_id, owner_user_id, discord_message_id,
            app_server_generation, execution_generation, prompt, queued, ack_sent,
            state, attempt_count, turn_id, baseline_turn_ids, last_error,
            created_at, updated_at, goal_waiting, turn_observation_generation
     FROM codex_turn_queue
     ORDER BY job_id`,
  );
  queueStmt.setReadBigInts(true);
  const turnQueue = queueStmt.all() as unknown as TurnQueueSnapshotRow[];

  const holdStmt = db.prepare(
    `SELECT job_id, target_thread_id, reason, evidence_json, created_at
     FROM cdr_execution_holds
     ORDER BY job_id`,
  );
  holdStmt.setReadBigInts(true);
  const executionHolds = holdStmt.all() as unknown as ExecutionHoldSnapshotRow[];

  const deadStmt = db.prepare(
    `SELECT target_thread_id, runtime_id, generation, created_at
     FROM codex_dead_generation_holds
     ORDER BY target_thread_id`,
  );
  deadStmt.setReadBigInts(true);
  const deadGenHolds = deadStmt.all() as unknown as DeadGenHoldSnapshotRow[];

  const routingStmt = db.prepare(
    `SELECT enabled
     FROM codex_exact_thread_routing
     ORDER BY enabled`,
  );
  routingStmt.setReadBigInts(true);
  const exactRouting = routingStmt.all() as unknown as ExactRoutingSnapshotRow[];

  return {
    forkHandoffs,
    turnQueue,
    executionHolds,
    deadGenHolds,
    exactRouting,
  };
}

describe("fork-managed-query", () => {
  it("fresh query returns false and persists both fork and direct managed tables", async () => {
    await withTempDir(async (dir) => {
      const dbPath = join(dir, "fresh.sqlite");
      assert.equal(existsSync(dbPath), false, "database file must not exist before wrapper invocation");

      const result = await isAppServerManagedTarget(dbPath, "target-fresh");
      assert.equal(result, false);
      assert.equal(existsSync(dbPath), true, "database file must exist after wrapper invocation");

      let verifyDb: DatabaseSync | null = null;
      try {
        verifyDb = new DatabaseSync(dbPath);
        const stmt = verifyDb.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('codex_thread_fork_handoffs', 'codex_app_server_managed_targets')",
        );
        const rows = stmt.all() as Array<{ name: string }>;
        const names = new Set(rows.map((r) => r.name));
        assert.equal(names.has("codex_thread_fork_handoffs"), true);
        assert.equal(names.has("codex_app_server_managed_targets"), true);

        const forkCountStmt = verifyDb.prepare(
          "SELECT count(*) as count FROM codex_thread_fork_handoffs",
        );
        forkCountStmt.setReadBigInts(true);
        const forkCount = forkCountStmt.get() as { count: bigint };
        assert.equal(forkCount.count, 0n);

        const directCountStmt = verifyDb.prepare(
          "SELECT count(*) as count FROM codex_app_server_managed_targets",
        );
        directCountStmt.setReadBigInts(true);
        const directCount = directCountStmt.get() as { count: bigint };
        assert.equal(directCount.count, 0n);
      } finally {
        if (verifyDb !== null) {
          verifyDb.close();
        }
      }
    });
  });

  it("completed fork handoff returns true and direct managed table is ABSENT due to short-circuit", async () => {
    await withTempDir(async (dir) => {
      const dbPath = join(dir, "fork-completed.sqlite");
      let setupDb: DatabaseSync | null = null;
      try {
        setupDb = await openInitialized(dbPath);
        ensureForkHandoffTableIn(setupDb);
        setupDb.prepare(
          `INSERT INTO codex_thread_fork_handoffs (
            handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
            discord_channel_id, discord_thread_id, quarantine_reason,
            observed_target_thread_id, target_thread_id, completed_generation,
            created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "handoff-c1",
          "ambig-1",
          "source-1",
          1n,
          100n,
          200n,
          "none",
          "completed-target-thread",
          "completed-target-thread",
          1n,
          1000.0,
          1005.0,
        );
      } finally {
        if (setupDb !== null) {
          setupDb.close();
        }
      }

      const result = await isAppServerManagedTarget(dbPath, "completed-target-thread");
      assert.equal(result, true);

      let verifyDb: DatabaseSync | null = null;
      try {
        verifyDb = new DatabaseSync(dbPath);
        const stmt = verifyDb.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_app_server_managed_targets'",
        );
        const rows = stmt.all();
        assert.equal(rows.length, 0, "codex_app_server_managed_targets must be ABSENT");
      } finally {
        if (verifyDb !== null) {
          verifyDb.close();
        }
      }
    });
  });

  it("observed-only and non-completed legacy target rows return false", async () => {
    await withTempDir(async (dir) => {
      const dbPath = join(dir, "observed-only.sqlite");
      let setupDb: DatabaseSync | null = null;
      try {
        setupDb = await openInitialized(dbPath);
        ensureForkHandoffTableIn(setupDb);
        setupDb.prepare(
          `INSERT INTO codex_thread_fork_handoffs (
            handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
            discord_channel_id, discord_thread_id, quarantine_reason,
            observed_target_thread_id, target_thread_id, completed_generation,
            created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)`,
        ).run(
          "handoff-obs-1",
          "ambig-obs-1",
          "source-obs-1",
          1n,
          101n,
          201n,
          "none",
          "observed-only-thread",
          1000.0,
        );
      } finally {
        if (setupDb !== null) {
          setupDb.close();
        }
      }

      const obsResult = await isAppServerManagedTarget(dbPath, "observed-only-thread");
      assert.equal(obsResult, false);

      const legacyPath = join(dir, "legacy-noncompleted.sqlite");
      let legacyDb: DatabaseSync | null = null;
      try {
        legacyDb = await openInitialized(legacyPath);
        legacyDb.exec(
          `CREATE TABLE codex_thread_fork_handoffs (
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
          );`,
        );
        legacyDb.prepare(
          `INSERT INTO codex_thread_fork_handoffs (
            handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
            discord_channel_id, discord_thread_id, quarantine_reason,
            target_thread_id, completed_generation, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ).run(
          "handoff-leg-1",
          "ambig-leg-1",
          "source-leg-1",
          1n,
          102n,
          202n,
          "none",
          "legacy-noncompleted-target",
          1n,
          1000.0,
        );
      } finally {
        if (legacyDb !== null) {
          legacyDb.close();
        }
      }

      const legResult = await isAppServerManagedTarget(legacyPath, "legacy-noncompleted-target");
      assert.equal(legResult, false);
    });
  });

  it("direct managed target returns true for zero and non-positive generation rows in contains", async () => {
    await withTempDir(async (dir) => {
      const dbPath = join(dir, "direct-managed.sqlite");
      let setupDb: DatabaseSync | null = null;
      try {
        setupDb = await openInitialized(dbPath);
        ensureManagedTargetTableIn(setupDb);
        const insertStmt = setupDb.prepare(
          `INSERT INTO codex_app_server_managed_targets
           (thread_id, app_server_generation, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        );
        insertStmt.run("zero-gen-target", 0n, 1000.0, 1000.0);
        insertStmt.run("negative-gen-target", -5n, 1000.0, 1000.0);
        insertStmt.run("positive-gen-target", 42n, 1000.0, 1000.0);

        assert.equal(containsManagedTargetIn(setupDb, "zero-gen-target"), true);
        assert.equal(containsManagedTargetIn(setupDb, "negative-gen-target"), true);
        assert.equal(containsManagedTargetIn(setupDb, "positive-gen-target"), true);
        assert.equal(containsManagedTargetIn(setupDb, "absent-target"), false);
      } finally {
        if (setupDb !== null) {
          setupDb.close();
        }
      }

      assert.equal(await isAppServerManagedTarget(dbPath, "zero-gen-target"), true);
      assert.equal(await isAppServerManagedTarget(dbPath, "negative-gen-target"), true);
      assert.equal(await isAppServerManagedTarget(dbPath, "positive-gen-target"), true);
      assert.equal(await isAppServerManagedTarget(dbPath, "absent-target"), false);
    });
  });

  it("preserves exact string identity for empty, NUL, BOM, and supplementary characters without trimming", async () => {
    await withTempDir(async (dir) => {
      const dbPath = join(dir, "identity.sqlite");
      let setupDb: DatabaseSync | null = null;
      try {
        setupDb = await openInitialized(dbPath);
        ensureForkHandoffTableIn(setupDb);

        const insertFork = setupDb.prepare(
          `INSERT INTO codex_thread_fork_handoffs (
            handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
            discord_channel_id, discord_thread_id, quarantine_reason,
            observed_target_thread_id, target_thread_id, completed_generation,
            created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        const forkEntries: Array<{ id: string; target: string }> = [
          { id: "h-empty", target: "" },
          { id: "h-nul", target: "nul\0byte" },
          { id: "h-bom", target: "\uFEFFbom-thread" },
          { id: "h-supp", target: "🧵-supp-emoji-🚀" },
          { id: "h-padded", target: " padded-target " },
          { id: "h-nbsp", target: "\u00A0nbsp-target" },
          { id: "h-ideo", target: "\u3000ideo-target" },
        ];

        for (let i = 0; i < forkEntries.length; i++) {
          const item = forkEntries[i];
          assert.ok(item !== undefined);
          insertFork.run(
            item.id,
            `ambig-${i}`,
            `source-${i}`,
            1n,
            BigInt(100 + i),
            BigInt(200 + i),
            "none",
            item.target,
            item.target,
            1n,
            1000.0,
            1010.0,
          );
        }
      } finally {
        if (setupDb !== null) {
          setupDb.close();
        }
      }

      assert.equal(await isAppServerManagedTarget(dbPath, ""), true);
      assert.equal(await isAppServerManagedTarget(dbPath, "nul\0byte"), true);
      assert.equal(await isAppServerManagedTarget(dbPath, "\uFEFFbom-thread"), true);
      assert.equal(await isAppServerManagedTarget(dbPath, "🧵-supp-emoji-🚀"), true);
      assert.equal(await isAppServerManagedTarget(dbPath, " padded-target "), true);
      assert.equal(await isAppServerManagedTarget(dbPath, "\u00A0nbsp-target"), true);
      assert.equal(await isAppServerManagedTarget(dbPath, "\u3000ideo-target"), true);

      assert.equal(await isAppServerManagedTarget(dbPath, " "), false);
      assert.equal(await isAppServerManagedTarget(dbPath, "nulbyte"), false);
      assert.equal(await isAppServerManagedTarget(dbPath, "bom-thread"), false);
      assert.equal(await isAppServerManagedTarget(dbPath, "padded-target"), false);
      assert.equal(await isAppServerManagedTarget(dbPath, " padded-target"), false);
      assert.equal(await isAppServerManagedTarget(dbPath, "padded-target "), false);
      assert.equal(await isAppServerManagedTarget(dbPath, "nbsp-target"), false);
      assert.equal(await isAppServerManagedTarget(dbPath, "ideo-target"), false);
    });
  });

  it("migrates legacy fork table with missing 3 columns and drops observed target index", async () => {
    await withTempDir(async (dir) => {
      const dbPath = join(dir, "legacy-migration.sqlite");
      let db: DatabaseSync | null = null;
      try {
        db = await openInitialized(dbPath);
        db.exec(
          `CREATE TABLE codex_thread_fork_handoffs (
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
          CREATE INDEX codex_thread_fork_handoffs_observed_target ON codex_thread_fork_handoffs(target_thread_id);`,
        );

        const preInfoStmt = db.prepare("PRAGMA table_info(codex_thread_fork_handoffs)");
        const preCols = (preInfoStmt.all() as Array<{ name: string }>).map((r) => r.name);
        assert.equal(preCols.includes("observed_target_thread_id"), false);
        assert.equal(preCols.includes("last_fork_error"), false);
        assert.equal(preCols.includes("fork_failure_ambiguous"), false);

        const preIdxStmt = db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'codex_thread_fork_handoffs_observed_target'",
        );
        assert.equal(preIdxStmt.all().length, 1);

        ensureForkHandoffTableIn(db);

        const postInfoStmt = db.prepare("PRAGMA table_info(codex_thread_fork_handoffs)");
        const postCols = (postInfoStmt.all() as Array<{ name: string }>).map((r) => r.name);
        assert.equal(postCols.includes("observed_target_thread_id"), true);
        assert.equal(postCols.includes("last_fork_error"), true);
        assert.equal(postCols.includes("fork_failure_ambiguous"), true);

        const postIdxStmt = db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'codex_thread_fork_handoffs_observed_target'",
        );
        assert.equal(postIdxStmt.all().length, 0);
      } finally {
        if (db !== null) {
          db.close();
        }
      }
    });
  });

  it("malformed direct table with fork false causes native error and rolls back fork schema migration and index drop", async () => {
    await withTempDir(async (dir) => {
      const dbPath = join(dir, "malformed-rollback.sqlite");
      let setupDb: DatabaseSync | null = null;
      try {
        setupDb = await openInitialized(dbPath);
        setupDb.exec(
          `CREATE TABLE codex_thread_fork_handoffs (
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
          CREATE INDEX codex_thread_fork_handoffs_observed_target ON codex_thread_fork_handoffs(target_thread_id);
          CREATE TABLE codex_app_server_managed_targets (corrupt_column INTEGER NOT NULL);`,
        );
      } finally {
        if (setupDb !== null) {
          setupDb.close();
        }
      }

      await assert.rejects(
        async () => {
          await isAppServerManagedTarget(dbPath, "not-in-fork");
        },
        (err: unknown) => {
          assert(err instanceof Error);
          assert.match(err.message, /no such column: thread_id/);
          return true;
        },
      );

      let verifyDb: DatabaseSync | null = null;
      try {
        verifyDb = new DatabaseSync(dbPath);
        const colsStmt = verifyDb.prepare("PRAGMA table_info(codex_thread_fork_handoffs)");
        const cols = (colsStmt.all() as Array<{ name: string }>).map((r) => r.name);
        assert.equal(cols.includes("observed_target_thread_id"), false);
        assert.equal(cols.includes("last_fork_error"), false);
        assert.equal(cols.includes("fork_failure_ambiguous"), false);

        const idxStmt = verifyDb.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'codex_thread_fork_handoffs_observed_target'",
        );
        assert.equal(idxStmt.all().length, 1, "index must remain present after rollback");
      } finally {
        if (verifyDb !== null) {
          verifyDb.close();
        }
      }
    });
  });

  it("malformed direct table with fork true returns true without error and leaves direct table untouched", async () => {
    await withTempDir(async (dir) => {
      const dbPath = join(dir, "malformed-shortcircuit.sqlite");
      let setupDb: DatabaseSync | null = null;
      try {
        setupDb = await openInitialized(dbPath);
        ensureForkHandoffTableIn(setupDb);
        setupDb.prepare(
          `INSERT INTO codex_thread_fork_handoffs (
            handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
            discord_channel_id, discord_thread_id, quarantine_reason,
            observed_target_thread_id, target_thread_id, completed_generation,
            created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "h-malformed-test",
          "ambig-m",
          "source-m",
          1n,
          100n,
          200n,
          "none",
          "target-in-fork",
          "target-in-fork",
          1n,
          1000.0,
          1005.0,
        );
        setupDb.exec("CREATE TABLE codex_app_server_managed_targets (corrupt_column INTEGER NOT NULL);");
      } finally {
        if (setupDb !== null) {
          setupDb.close();
        }
      }

      const result = await isAppServerManagedTarget(dbPath, "target-in-fork");
      assert.equal(result, true);

      let verifyDb: DatabaseSync | null = null;
      try {
        verifyDb = new DatabaseSync(dbPath);
        const colsStmt = verifyDb.prepare("PRAGMA table_info(codex_app_server_managed_targets)");
        const cols = (colsStmt.all() as Array<{ name: string }>).map((r) => r.name);
        assert.deepEqual(cols, ["corrupt_column"]);
      } finally {
        if (verifyDb !== null) {
          verifyDb.close();
        }
      }
    });
  });

  it("borrowed helpers do not close connection and allow transaction rollback while remaining usable", async () => {
    await withTempDir(async (dir) => {
      const dbPath = join(dir, "borrowed-helpers.sqlite");
      let db: DatabaseSync | null = null;
      try {
        db = await openInitialized(dbPath);

        ensureForkHandoffTableIn(db);
        ensureForkTableIn(db);
        ensureManagedTargetTableIn(db);

        assert.equal(managedTargetIn(db, "nonexistent"), false);
        assert.equal(managedForkTargetIn(db, "nonexistent"), false);
        assert.equal(containsManagedTargetIn(db, "nonexistent"), false);

        db.exec("BEGIN IMMEDIATE;");
        db.prepare(
          `INSERT INTO codex_thread_fork_handoffs (
            handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
            discord_channel_id, discord_thread_id, quarantine_reason,
            observed_target_thread_id, target_thread_id, completed_generation,
            created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "h-borrowed",
          "ambig-b",
          "source-b",
          1n,
          100n,
          200n,
          "none",
          "target-borrowed",
          "target-borrowed",
          1n,
          1000.0,
          1005.0,
        );

        assert.equal(managedTargetIn(db, "target-borrowed"), true);
        assert.equal(managedForkTargetIn(db, "target-borrowed"), true);

        db.exec("ROLLBACK;");

        assert.equal(managedTargetIn(db, "target-borrowed"), false);
        assert.equal(managedForkTargetIn(db, "target-borrowed"), false);

        const testStmt = db.prepare("SELECT 1 as alive");
        testStmt.setReadBigInts(true);
        const row = testStmt.get() as { alive: bigint };
        assert.equal(row.alive, 1n);
      } finally {
        if (db !== null) {
          db.close();
        }
      }
    });
  });

  it("dead, hold, quarantine, and exact routing flags do not guard query wrapper and remain unchanged", async () => {
    await withTempDir(async (dir) => {
      const dbPath = join(dir, "dead-hold-flags.sqlite");
      let beforeSnapshot: TableSnapshots | null = null;
      let setupDb: DatabaseSync | null = null;
      try {
        setupDb = await openInitialized(dbPath);
        ensureForkHandoffTableIn(setupDb);
        setupDb.prepare(
          `INSERT INTO codex_thread_fork_handoffs (
            handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
            discord_channel_id, discord_thread_id, quarantine_reason,
            last_fork_error, fork_failure_ambiguous,
            observed_target_thread_id, target_thread_id, completed_generation,
            created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "h-quarantine-1",
          "ambig-q",
          "source-q",
          1n,
          100n,
          200n,
          "quarantined_hold_retired_dead",
          "failed-previous-attempt",
          1n,
          "target-quarantined",
          "target-quarantined",
          1n,
          1000.0,
          1005.0,
        );

        insertJob(setupDb, {
          jobId: "job-quarantined-1",
          targetThreadId: "target-quarantined",
          channelId: 100n,
          ownerUserId: 200n,
          state: "quarantined",
          turnId: "cdr-quarantined:manual-review",
          lastError: "[cdr-rust:app-server-fork-quarantine:v1] manual-review",
          attemptCount: 1n,
          appServerGeneration: 1n,
          executionGeneration: 1n,
          queued: 0,
          ackSent: 1,
        });

        holdIn(
          setupDb,
          "job-quarantined-1",
          "target-quarantined",
          "quarantined_hold_retired_dead",
          JSON.stringify({ note: "quarantine-hold" }),
        );

        setupDb.prepare(
          `INSERT INTO codex_dead_generation_holds (target_thread_id, runtime_id, generation, created_at)
           VALUES (?, ?, ?, ?)`,
        ).run("target-quarantined", "runtime-1", 1n, 1000.0);

        setupDb.exec(
          `CREATE TABLE IF NOT EXISTS codex_exact_thread_routing (
             enabled INTEGER NOT NULL CHECK(enabled = 1)
           );
           DELETE FROM codex_exact_thread_routing;
           INSERT INTO codex_exact_thread_routing (enabled) VALUES (1);`,
        );

        beforeSnapshot = takeSnapshots(setupDb);
      } finally {
        if (setupDb !== null) {
          setupDb.close();
        }
      }

      assert.ok(beforeSnapshot !== null);

      const result = await isAppServerManagedTarget(dbPath, "target-quarantined");
      assert.equal(result, true, "flags must not prevent managed target recognition");

      let verifyDb: DatabaseSync | null = null;
      try {
        verifyDb = new DatabaseSync(dbPath);
        const afterSnapshot = takeSnapshots(verifyDb);
        assert.deepEqual(afterSnapshot, beforeSnapshot);

        const forkRow = afterSnapshot.forkHandoffs[0];
        assert.ok(forkRow !== undefined);
        assert.equal(forkRow.quarantine_reason, "quarantined_hold_retired_dead");
        assert.equal(forkRow.last_fork_error, "failed-previous-attempt");
        assert.equal(forkRow.fork_failure_ambiguous, 1n);

        const queueRow = afterSnapshot.turnQueue[0];
        assert.ok(queueRow !== undefined);
        assert.equal(queueRow.state, "quarantined");
        assert.equal(queueRow.turn_id, "cdr-quarantined:manual-review");
        assert.equal(queueRow.last_error, "[cdr-rust:app-server-fork-quarantine:v1] manual-review");

        const holdRow = afterSnapshot.executionHolds[0];
        assert.ok(holdRow !== undefined);
        assert.equal(holdRow.job_id, "job-quarantined-1");
        assert.equal(holdRow.reason, "quarantined_hold_retired_dead");

        const deadRow = afterSnapshot.deadGenHolds[0];
        assert.ok(deadRow !== undefined);
        assert.equal(deadRow.target_thread_id, "target-quarantined");
        assert.equal(deadRow.generation, 1n);

        const routingRow = afterSnapshot.exactRouting[0];
        assert.ok(routingRow !== undefined);
        assert.equal(routingRow.enabled, 1n);
      } finally {
        if (verifyDb !== null) {
          verifyDb.close();
        }
      }
    });
  });

  it("hostile non-string inputs and malformed surrogate paths reject without coercion or file creation", async () => {
    await withTempDir(async (dir) => {
      let toStringCalls = 0;
      let valueOfCalls = 0;
      const hostileObject = {
        toString() {
          toStringCalls++;
          throw new Error("hostile toString must not be called");
        },
        valueOf() {
          valueOfCalls++;
          throw new Error("hostile valueOf must not be called");
        },
      };

      const nonStringValues: unknown[] = [
        null,
        undefined,
        123,
        0,
        true,
        false,
        {},
        [],
        Symbol("hostile"),
        123n,
        hostileObject,
      ];

      for (const val of nonStringValues) {
        await assert.rejects(
          async () => {
            await isAppServerManagedTarget(val as unknown as string, "valid-thread");
          },
          (err: unknown) => {
            assert(err instanceof TypeError);
            assert.match(err.message, /path must be a string/);
            return true;
          },
        );
      }
      assert.equal(toStringCalls, 0, "path validation must not invoke toString");
      assert.equal(valueOfCalls, 0, "path validation must not invoke valueOf");

      const normalDbPath = join(dir, "normal-db.sqlite");
      assert.equal(existsSync(normalDbPath), false, "normalDbPath must be absent before testing");

      for (const val of nonStringValues) {
        await assert.rejects(
          async () => {
            await isAppServerManagedTarget(normalDbPath, val as unknown as string);
          },
          (err: unknown) => {
            assert(err instanceof TypeError);
            assert.match(err.message, /threadId must be a string/);
            return true;
          },
        );
      }
      assert.equal(toStringCalls, 0, "threadId validation must not invoke toString");
      assert.equal(valueOfCalls, 0, "threadId validation must not invoke valueOf");
      assert.equal(existsSync(normalDbPath), false, "normalDbPath must remain absent after testing");

      const malformedSurrogatePath1 = join(dir, "malformed-\uD800.sqlite");
      const malformedSurrogatePath2 = join(dir, "malformed-\uDFFF.sqlite");
      const malformedSurrogatePath3 = join(dir, "malformed-\uD800\uD800.sqlite");

      for (const badPath of [
        malformedSurrogatePath1,
        malformedSurrogatePath2,
        malformedSurrogatePath3,
      ]) {
        await assert.rejects(
          async () => {
            await isAppServerManagedTarget(badPath, "valid-thread");
          },
          (err: unknown) => {
            assert(err instanceof TypeError);
            assert.match(err.message, /path contains lone surrogates/);
            return true;
          },
        );
        assert.equal(existsSync(badPath), false, "malformed path must not exist on filesystem");
      }

      const badThreads = ["bad-\uD800", "bad-\uDFFF", "\uD800", "\uDC00", "\uD800\uD800"];
      for (const badThread of badThreads) {
        await assert.rejects(
          async () => {
            await isAppServerManagedTarget(normalDbPath, badThread);
          },
          (err: unknown) => {
            assert(err instanceof TypeError);
            assert.match(err.message, /threadId contains lone surrogates/);
            return true;
          },
        );
      }

      const files = readdirSync(dir);
      assert.equal(files.length, 0, "directory must contain 0 files after hostile inputs");

      assert.throws(
        () => ensureForkHandoffTableIn(null as unknown as DatabaseSync),
        (err: unknown) => {
          assert(err instanceof TypeError);
          assert.match(err.message, /db must be a DatabaseSync instance/);
          return true;
        },
      );

      assert.throws(
        () => managedTargetIn(null as unknown as DatabaseSync, "valid-thread"),
        (err: unknown) => {
          assert(err instanceof TypeError);
          assert.match(err.message, /db must be a DatabaseSync instance/);
          return true;
        },
      );
    });
  });

  it("monkey-patched String.prototype.isWellFormed cannot bypass captured manual validator", async () => {
    await withTempDir(async (dir) => {
      const stringProto = String.prototype as unknown as {
        isWellFormed?: (() => boolean) | undefined;
      };
      const originalIsWellFormed = stringProto.isWellFormed;
      try {
        stringProto.isWellFormed = () => true;

        const malformedPath = join(dir, "patched-\uD800.sqlite");
        await assert.rejects(
          async () => {
            await isAppServerManagedTarget(malformedPath, "thread-id");
          },
          (err: unknown) => {
            assert(err instanceof TypeError);
            assert.match(err.message, /path contains lone surrogates/);
            return true;
          },
        );
        assert.equal(existsSync(malformedPath), false);

        const testDbPath = join(dir, "patched-valid.sqlite");
        await assert.rejects(
          async () => {
            await isAppServerManagedTarget(testDbPath, "thread-\uD800");
          },
          (err: unknown) => {
            assert(err instanceof TypeError);
            assert.match(err.message, /threadId contains lone surrogates/);
            return true;
          },
        );
        await assert.rejects(
          async () => {
            await isAppServerManagedTarget(testDbPath, "thread-\uDFFF");
          },
          (err: unknown) => {
            assert(err instanceof TypeError);
            assert.match(err.message, /threadId contains lone surrogates/);
            return true;
          },
        );
        assert.equal(existsSync(testDbPath), false);
      } finally {
        stringProto.isWellFormed = originalIsWellFormed;
      }
    });
  });

  it("corrupt database file causes initialization to reject during wrapper query", async () => {
    await withTempDir(async (dir) => {
      const corruptDbPath = join(dir, "corrupt.sqlite");
      writeFileSync(corruptDbPath, Buffer.from([0x00, 0x01, 0x02, 0x03]));

      await assert.rejects(async () => {
        await isAppServerManagedTarget(corruptDbPath, "valid-thread");
      });
    });
  });
});
