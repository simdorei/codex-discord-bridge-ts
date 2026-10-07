import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";

import {
  exactThreadRoutingEnabledIn,
  retireCopyOnlyHandoffs,
} from "../../src/store/fork-retirement.ts";
import { openInitialized } from "../../src/store/owned-driver.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";

const realTmpDir = realpathSync(tmpdir());

function createTestDir(prefix: string = "fork-retire-test-"): string {
  const rawDir = mkdtempSync(join(realTmpDir, prefix));
  return realpathSync(rawDir);
}

function cleanupTestDir(dir: string): void {
  const resolved = resolve(dir);
  if (!existsSync(resolved)) {
    return;
  }
  const real = realpathSync(resolved);
  assert(real === resolved);
  const parent = dirname(real);
  if (parent === realTmpDir && real.startsWith(realTmpDir) && real !== realTmpDir) {
    rmSync(real, { recursive: true, force: true });
  } else {
    throw new Error(
      `Security assertion failed: refusing to delete non-temp directory: ${real}`,
    );
  }
}

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

function insertQueueJob(
  db: DatabaseSync,
  jobId: string,
  targetThreadId: string,
  state: string,
): void {
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
    100n,
    200n,
    null,
    1n,
    null,
    "test prompt",
    1,
    0,
    state,
    0n,
    null,
    "[]",
    "",
    1000.0,
    1000.0,
    0,
    null,
  );
}

function insertDeadGenerationHold(
  db: DatabaseSync,
  targetThreadId: string,
  runtimeId: string = "runtime-1",
  generation: bigint = 1n,
  createdAt: number = 1000.0,
): void {
  db.prepare(
    `INSERT INTO codex_dead_generation_holds (
      target_thread_id, runtime_id, generation, created_at
    ) VALUES (?, ?, ?, ?)`,
  ).run(targetThreadId, runtimeId, generation, createdAt);
}

function insertDeadGenerationIncident(
  db: DatabaseSync,
  runtimeId: string,
  generation: bigint,
): void {
  db.prepare(
    `INSERT INTO codex_dead_generation_incidents (
      runtime_id, generation, snapshot_json, queue_jobs_json, created_at
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run(runtimeId, generation, "{}", "[]", 1000.0);
}

function insertExecutionHold(
  db: DatabaseSync,
  jobId: string,
  targetThreadId: string,
  reason: string,
): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS cdr_execution_holds (
      job_id TEXT PRIMARY KEY,
      target_thread_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at REAL NOT NULL
    );`,
  );
  db.prepare(
    `INSERT INTO cdr_execution_holds (
      job_id, target_thread_id, reason, evidence_json, created_at
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run(jobId, targetThreadId, reason, "{}", 1000.0);
}

describe("retireCopyOnlyHandoffs: path validation and hostile inputs", () => {
  test("rejects hostile non-string inputs without coercion and leaves zero file effects", async () => {
    const dir = createTestDir("fork-hostile-");
    try {
      const hostileInputs: unknown[] = [
        null,
        undefined,
        123,
        123n,
        true,
        false,
        {},
        [],
        (): void => {},
        Symbol("path"),
      ];

      for (const input of hostileInputs) {
        await assert.rejects(
          async () => {
            await retireCopyOnlyHandoffs(input as unknown as string);
          },
          {
            name: "TypeError",
            message: "Database path must be a string",
          },
        );
      }

      assert.equal(readdirSync(dir).length, 0);
    } finally {
      cleanupTestDir(dir);
    }
  });

  test("rejects malformed UTF-16 surrogate paths and leaves zero file effects", async () => {
    const dir = createTestDir("fork-surrogate-");
    try {
      const malformedEndHigh = join(dir, "malformed-\uD800.sqlite");
      await assert.rejects(
        async () => {
          await retireCopyOnlyHandoffs(malformedEndHigh);
        },
        {
          name: "TypeError",
          message: "Database path contains ill-formed UTF-16: unpaired high surrogate",
        },
      );

      const malformedMiddleHigh = join(dir, "malformed-\uD800-trail.sqlite");
      await assert.rejects(
        async () => {
          await retireCopyOnlyHandoffs(malformedMiddleHigh);
        },
        {
          name: "TypeError",
          message: "Database path contains ill-formed UTF-16: unpaired high surrogate",
        },
      );

      const malformedLow = join(dir, "malformed-\uDC00.sqlite");
      await assert.rejects(
        async () => {
          await retireCopyOnlyHandoffs(malformedLow);
        },
        {
          name: "TypeError",
          message: "Database path contains ill-formed UTF-16: unpaired low surrogate",
        },
      );

      assert.equal(readdirSync(dir).length, 0);
    } finally {
      cleanupTestDir(dir);
    }
  });
});

describe("exactThreadRoutingEnabledIn", () => {
  test("returns false when routing table does not exist in schema", async () => {
    const dir = createTestDir("fork-routing-nonexist-");
    const dbPath = join(dir, "store.sqlite");
    try {
      let db: DatabaseSync | undefined;
      try {
        db = await openInitialized(dbPath);
        assert.equal(exactThreadRoutingEnabledIn(db), false);
      } finally {
        db?.close();
      }
    } finally {
      cleanupTestDir(dir);
    }
  });

  test("returns true based strictly on table existence even if table is completely empty", async () => {
    const dir = createTestDir("fork-routing-empty-");
    const dbPath = join(dir, "store.sqlite");
    try {
      let db: DatabaseSync | undefined;
      try {
        db = await openInitialized(dbPath);
        db.exec(
          "CREATE TABLE codex_exact_thread_routing (enabled INTEGER NOT NULL CHECK(enabled=1));",
        );
        assert.equal(exactThreadRoutingEnabledIn(db), true);
      } finally {
        db?.close();
      }
    } finally {
      cleanupTestDir(dir);
    }
  });

  test("respects borrowed caller transaction ownership and rollback without side effects", async () => {
    const dir = createTestDir("fork-routing-tx-");
    const dbPath = join(dir, "store.sqlite");
    try {
      let db: DatabaseSync | undefined;
      try {
        db = await openInitialized(dbPath);
        assert.equal(exactThreadRoutingEnabledIn(db), false);

        db.exec("BEGIN IMMEDIATE;");
        db.exec(
          "CREATE TABLE codex_exact_thread_routing (enabled INTEGER NOT NULL CHECK(enabled=1));",
        );
        assert.equal(exactThreadRoutingEnabledIn(db), true);

        db.exec("ROLLBACK;");
        assert.equal(exactThreadRoutingEnabledIn(db), false);
      } finally {
        db?.close();
      }
    } finally {
      cleanupTestDir(dir);
    }
  });
});

describe("retireCopyOnlyHandoffs: fresh and repeated zero cases", () => {
  test("fresh zero creates routing and fork table but no archive table; repeated zero preserves state", async () => {
    const dir = createTestDir("fork-fresh0-");
    const dbPath = join(dir, "store.sqlite");
    try {
      let initDb: DatabaseSync | undefined;
      try {
        initDb = await openInitialized(dbPath);
      } finally {
        initDb?.close();
      }

      const count1 = await retireCopyOnlyHandoffs(dbPath);
      assert.equal(count1, 0n);

      let verifyDb1: DatabaseSync | undefined;
      try {
        verifyDb1 = new DatabaseSync(dbPath);
        assert.equal(exactThreadRoutingEnabledIn(verifyDb1), true);

        const routingRow = verifyDb1
          .prepare("SELECT enabled FROM codex_exact_thread_routing")
          .get() as { enabled?: unknown } | undefined;
        assert(routingRow !== undefined);
        assert.equal(routingRow.enabled, 1);

        const forkTableExists = verifyDb1
          .prepare(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_thread_fork_handoffs')",
          )
          .get() as Record<string, unknown> | undefined;
        assert(forkTableExists !== undefined);
        assert.equal(Object.values(forkTableExists)[0], 1);

        const archiveTableExists = verifyDb1
          .prepare(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_retired_fork_handoffs')",
          )
          .get() as Record<string, unknown> | undefined;
        assert(archiveTableExists !== undefined);
        assert.equal(Object.values(archiveTableExists)[0], 0);
      } finally {
        verifyDb1?.close();
      }

      const count2 = await retireCopyOnlyHandoffs(dbPath);
      assert.equal(count2, 0n);

      let verifyDb2: DatabaseSync | undefined;
      try {
        verifyDb2 = new DatabaseSync(dbPath);
        const routingCount = verifyDb2
          .prepare("SELECT COUNT(*) AS total FROM codex_exact_thread_routing")
          .get() as { total?: unknown } | undefined;
        assert(routingCount !== undefined);
        assert.equal(routingCount.total, 1);

        const archiveTableExists2 = verifyDb2
          .prepare(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_retired_fork_handoffs')",
          )
          .get() as Record<string, unknown> | undefined;
        assert(archiveTableExists2 !== undefined);
        assert.equal(Object.values(archiveTableExists2)[0], 0);
      } finally {
        verifyDb2?.close();
      }
    } finally {
      cleanupTestDir(dir);
    }
  });
});

describe("retireCopyOnlyHandoffs: native eligibility matrix", () => {
  test("excludes ambiguous_job_id nonnull, excludes active queue states on all endpoints, permits pending and holds matrix", async () => {
    const dir = createTestDir("fork-eligibility-");
    const dbPath = join(dir, "store.sqlite");
    try {
      let seedDb: DatabaseSync | undefined;
      try {
        seedDb = await openInitialized(dbPath);
        seedDb.exec(
          "CREATE TABLE IF NOT EXISTS codex_thread_fork_handoffs (\n" +
          "  handoff_id TEXT PRIMARY KEY,\n" +
          "  ambiguous_job_id TEXT UNIQUE,\n" +
          "  source_thread_id TEXT NOT NULL UNIQUE,\n" +
          "  expected_generation INTEGER NOT NULL,\n" +
          "  discord_channel_id INTEGER NOT NULL,\n" +
          "  discord_thread_id INTEGER NOT NULL,\n" +
          "  quarantine_reason TEXT NOT NULL,\n" +
          "  last_fork_error TEXT NOT NULL DEFAULT '',\n" +
          "  fork_failure_ambiguous INTEGER NOT NULL DEFAULT 0,\n" +
          "  observed_target_thread_id TEXT,\n" +
          "  target_thread_id TEXT UNIQUE,\n" +
          "  completed_generation INTEGER,\n" +
          "  created_at REAL NOT NULL,\n" +
          "  completed_at REAL,\n" +
          "  CHECK ((target_thread_id IS NULL AND completed_generation IS NULL AND completed_at IS NULL)\n" +
          "      OR (target_thread_id IS NOT NULL AND completed_generation IS NOT NULL\n" +
          "          AND completed_at IS NOT NULL)),\n" +
          "  CHECK (target_thread_id IS NULL OR target_thread_id = observed_target_thread_id)\n" +
          ");",
        );

        insertHandoff(seedDb, {
          handoffId: "h-eligible-clean",
          sourceThreadId: "src-clean",
          observedTargetThreadId: "tgt-clean",
          targetThreadId: "tgt-clean",
          completedGeneration: 1n,
          completedAt: 1000.0,
        });

        insertHandoff(seedDb, {
          handoffId: "h-ambig-job",
          ambiguousJobId: "job-ambig-123",
          sourceThreadId: "src-ambig",
        });

        insertHandoff(seedDb, { handoffId: "h-q-src-start", sourceThreadId: "src-q-start" });
        insertQueueJob(seedDb, "job-q-src-start", "src-q-start", "starting");

        insertHandoff(seedDb, { handoffId: "h-q-src-run", sourceThreadId: "src-q-run" });
        insertQueueJob(seedDb, "job-q-src-run", "src-q-run", "running");

        insertHandoff(seedDb, { handoffId: "h-q-src-quar", sourceThreadId: "src-q-quar" });
        insertQueueJob(seedDb, "job-q-src-quar", "src-q-quar", "quarantined");

        insertHandoff(seedDb, {
          handoffId: "h-q-obs-start",
          sourceThreadId: "src-q-obs-start",
          observedTargetThreadId: "obs-q-start",
        });
        insertQueueJob(seedDb, "job-q-obs-start", "obs-q-start", "starting");

        insertHandoff(seedDb, {
          handoffId: "h-q-obs-run",
          sourceThreadId: "src-q-obs-run",
          observedTargetThreadId: "obs-q-run",
        });
        insertQueueJob(seedDb, "job-q-obs-run", "obs-q-run", "running");

        insertHandoff(seedDb, {
          handoffId: "h-q-obs-quar",
          sourceThreadId: "src-q-obs-quar",
          observedTargetThreadId: "obs-q-quar",
        });
        insertQueueJob(seedDb, "job-q-obs-quar", "obs-q-quar", "quarantined");

        insertHandoff(seedDb, {
          handoffId: "h-q-tgt-start",
          sourceThreadId: "src-q-tgt-start",
          observedTargetThreadId: "tgt-q-start",
          targetThreadId: "tgt-q-start",
          completedGeneration: 1n,
          completedAt: 1000.0,
        });
        insertQueueJob(seedDb, "job-q-tgt-start", "tgt-q-start", "starting");

        insertHandoff(seedDb, {
          handoffId: "h-q-tgt-run",
          sourceThreadId: "src-q-tgt-run",
          observedTargetThreadId: "tgt-q-run",
          targetThreadId: "tgt-q-run",
          completedGeneration: 1n,
          completedAt: 1000.0,
        });
        insertQueueJob(seedDb, "job-q-tgt-run", "tgt-q-run", "running");

        insertHandoff(seedDb, {
          handoffId: "h-q-tgt-quar",
          sourceThreadId: "src-q-tgt-quar",
          observedTargetThreadId: "tgt-q-quar",
          targetThreadId: "tgt-q-quar",
          completedGeneration: 1n,
          completedAt: 1000.0,
        });
        insertQueueJob(seedDb, "job-q-tgt-quar", "tgt-q-quar", "quarantined");

        insertHandoff(seedDb, { handoffId: "h-q-src-pend", sourceThreadId: "src-q-pend" });
        insertQueueJob(seedDb, "job-q-src-pend", "src-q-pend", "pending");

        insertHandoff(seedDb, {
          handoffId: "h-q-obs-pend",
          sourceThreadId: "src-q-obs-pend",
          observedTargetThreadId: "obs-q-pend",
        });
        insertQueueJob(seedDb, "job-q-obs-pend", "obs-q-pend", "pending");

        insertHandoff(seedDb, {
          handoffId: "h-q-tgt-pend",
          sourceThreadId: "src-q-tgt-pend",
          observedTargetThreadId: "tgt-q-pend",
          targetThreadId: "tgt-q-pend",
          completedGeneration: 1n,
          completedAt: 1000.0,
        });
        insertQueueJob(seedDb, "job-q-tgt-pend", "tgt-q-pend", "pending");

        insertHandoff(seedDb, { handoffId: "h-q-src-comp", sourceThreadId: "src-q-comp" });
        insertQueueJob(seedDb, "job-q-src-comp", "src-q-comp", "completed");

        insertHandoff(seedDb, { handoffId: "h-q-src-fail", sourceThreadId: "src-q-fail" });
        insertQueueJob(seedDb, "job-q-src-fail", "src-q-fail", "failed");

        insertHandoff(seedDb, { handoffId: "h-dgh-src", sourceThreadId: "src-dgh" });
        insertDeadGenerationHold(seedDb, "src-dgh", "runtime-alpha", 99n);

        insertHandoff(seedDb, {
          handoffId: "h-dgh-obs",
          sourceThreadId: "src-dgh-obs",
          observedTargetThreadId: "obs-dgh",
        });
        insertDeadGenerationHold(seedDb, "obs-dgh", "runtime-beta", 100n);

        insertHandoff(seedDb, {
          handoffId: "h-dgh-tgt",
          sourceThreadId: "src-dgh-tgt",
          observedTargetThreadId: "tgt-dgh",
          targetThreadId: "tgt-dgh",
          completedGeneration: 1n,
          completedAt: 1000.0,
        });
        insertDeadGenerationHold(seedDb, "tgt-dgh", "runtime-gamma", 101n);

        insertHandoff(seedDb, { handoffId: "h-unrelated-hold", sourceThreadId: "src-unrel-hold" });
        insertDeadGenerationHold(seedDb, "unrelated-thread-endpoint", "runtime-other", 1n);

        insertHandoff(seedDb, { handoffId: "h-incident-only", sourceThreadId: "src-inc-only" });
        insertDeadGenerationIncident(seedDb, "runtime-incident-only", 1n);

        insertHandoff(seedDb, { handoffId: "h-exec-hold", sourceThreadId: "src-exec-hold" });
        insertExecutionHold(seedDb, "job-exec-1", "src-exec-hold", "execution hold reason");
      } finally {
        seedDb?.close();
      }

      let snapDb: DatabaseSync | undefined;
      let queueBefore: unknown[];
      let holdsBefore: unknown[];
      try {
        snapDb = new DatabaseSync(dbPath);
        queueBefore = snapDb.prepare("SELECT * FROM codex_turn_queue ORDER BY job_id").all();
        holdsBefore = snapDb.prepare("SELECT * FROM codex_dead_generation_holds ORDER BY target_thread_id").all();
      } finally {
        snapDb?.close();
      }

      const retiredCount = await retireCopyOnlyHandoffs(dbPath);
      assert.equal(retiredCount, 9n);

      let verifyDb: DatabaseSync | undefined;
      try {
        verifyDb = new DatabaseSync(dbPath);
        const queueAfter = verifyDb.prepare("SELECT * FROM codex_turn_queue ORDER BY job_id").all();
        const holdsAfter = verifyDb.prepare("SELECT * FROM codex_dead_generation_holds ORDER BY target_thread_id").all();
        assert.deepEqual(queueAfter, queueBefore);
        assert.deepEqual(holdsAfter, holdsBefore);

        const remainingHandoffs = verifyDb
          .prepare("SELECT handoff_id FROM codex_thread_fork_handoffs ORDER BY handoff_id")
          .all() as Array<{ handoff_id?: unknown }>;
        const remainingIds = new Set(remainingHandoffs.map((r) => r.handoff_id));

        const expectedRemaining = [
          "h-ambig-job",
          "h-q-src-start",
          "h-q-src-run",
          "h-q-src-quar",
          "h-q-obs-start",
          "h-q-obs-run",
          "h-q-obs-quar",
          "h-q-tgt-start",
          "h-q-tgt-run",
          "h-q-tgt-quar",
          "h-dgh-src",
          "h-dgh-obs",
          "h-dgh-tgt",
        ];
        assert.equal(remainingIds.size, expectedRemaining.length);
        for (const id of expectedRemaining) {
          assert.equal(remainingIds.has(id), true);
        }

        const retiredHandoffs = verifyDb
          .prepare("SELECT handoff_id FROM codex_retired_fork_handoffs ORDER BY handoff_id")
          .all() as Array<{ handoff_id?: unknown }>;
        const retiredIds = new Set(retiredHandoffs.map((r) => r.handoff_id));

        const expectedRetired = [
          "h-eligible-clean",
          "h-q-src-pend",
          "h-q-obs-pend",
          "h-q-tgt-pend",
          "h-q-src-comp",
          "h-q-src-fail",
          "h-unrelated-hold",
          "h-incident-only",
          "h-exec-hold",
        ];
        assert.equal(retiredIds.size, expectedRetired.length);
        for (const id of expectedRetired) {
          assert.equal(retiredIds.has(id), true);
        }
      } finally {
        verifyDb?.close();
      }
    } finally {
      cleanupTestDir(dir);
    }
  });
});

describe("retireCopyOnlyHandoffs: column preservation, signed i64 extrema, and special string IDs", () => {
  test("archives every column without loss, preserves signed i64 extrema, empty/NUL/BOM/supplementary IDs", async () => {
    const dir = createTestDir("fork-columns-");
    const dbPath = join(dir, "store.sqlite");
    try {
      let seedDb: DatabaseSync | undefined;
      try {
        seedDb = await openInitialized(dbPath);
        seedDb.exec(
          "CREATE TABLE IF NOT EXISTS codex_thread_fork_handoffs (\n" +
          "  handoff_id TEXT PRIMARY KEY,\n" +
          "  ambiguous_job_id TEXT UNIQUE,\n" +
          "  source_thread_id TEXT NOT NULL UNIQUE,\n" +
          "  expected_generation INTEGER NOT NULL,\n" +
          "  discord_channel_id INTEGER NOT NULL,\n" +
          "  discord_thread_id INTEGER NOT NULL,\n" +
          "  quarantine_reason TEXT NOT NULL,\n" +
          "  last_fork_error TEXT NOT NULL DEFAULT '',\n" +
          "  fork_failure_ambiguous INTEGER NOT NULL DEFAULT 0,\n" +
          "  observed_target_thread_id TEXT,\n" +
          "  target_thread_id TEXT UNIQUE,\n" +
          "  completed_generation INTEGER,\n" +
          "  created_at REAL NOT NULL,\n" +
          "  completed_at REAL,\n" +
          "  CHECK ((target_thread_id IS NULL AND completed_generation IS NULL AND completed_at IS NULL)\n" +
          "      OR (target_thread_id IS NOT NULL AND completed_generation IS NOT NULL\n" +
          "          AND completed_at IS NOT NULL)),\n" +
          "  CHECK (target_thread_id IS NULL OR target_thread_id = observed_target_thread_id)\n" +
          ");",
        );

        insertHandoff(seedDb, {
          handoffId: "h-extrema",
          ambiguousJobId: null,
          sourceThreadId: "src-extrema",
          expectedGeneration: 9223372036854775807n,
          discordChannelId: 9223372036854775807n,
          discordThreadId: -9223372036854775808n,
          quarantineReason: "reason-extrema",
          lastForkError: "exact error message",
          forkFailureAmbiguous: 1,
          observedTargetThreadId: "tgt-extrema",
          targetThreadId: "tgt-extrema",
          completedGeneration: -9223372036854775808n,
          createdAt: 1234567.89,
          completedAt: 9876543.21,
        });

        insertHandoff(seedDb, {
          handoffId: "",
          sourceThreadId: "src-empty-id",
          expectedGeneration: 0n,
          discordChannelId: 111n,
          discordThreadId: 222n,
          quarantineReason: "empty_reason",
          lastForkError: "",
          forkFailureAmbiguous: 0,
        });

        insertHandoff(seedDb, {
          handoffId: "h-with-\0-nul",
          sourceThreadId: "src-nul-id",
          expectedGeneration: 10n,
          discordChannelId: 333n,
          discordThreadId: 444n,
          quarantineReason: "nul\0reason",
          lastForkError: "nul\0err",
          forkFailureAmbiguous: 0,
        });

        insertHandoff(seedDb, {
          handoffId: "\uFEFFbom-prefixed-handoff",
          sourceThreadId: "src-bom-id",
          expectedGeneration: 20n,
          discordChannelId: 555n,
          discordThreadId: 666n,
          quarantineReason: "\uFEFFquarantine-bom",
          lastForkError: "",
          forkFailureAmbiguous: 0,
        });

        insertHandoff(seedDb, {
          handoffId: "h-astral-𐐷-🚀-test",
          sourceThreadId: "src-astral-𐐷-id",
          expectedGeneration: 30n,
          discordChannelId: 777n,
          discordThreadId: 888n,
          quarantineReason: "astral_reason",
          lastForkError: "",
          forkFailureAmbiguous: 0,
          observedTargetThreadId: "tgt-astral-𐐷",
          targetThreadId: "tgt-astral-𐐷",
          completedGeneration: 40n,
          createdAt: 2000.0,
          completedAt: 2001.0,
        });
      } finally {
        seedDb?.close();
      }

      const retiredCount = await retireCopyOnlyHandoffs(dbPath);
      assert.equal(retiredCount, 5n);

      let verifyDb: DatabaseSync | undefined;
      try {
        verifyDb = new DatabaseSync(dbPath);
        const queryStmt = verifyDb.prepare(
          "SELECT * FROM codex_retired_fork_handoffs WHERE handoff_id = ?",
        );
        queryStmt.setReadBigInts(true);

        const rowExtrema = queryStmt.get("h-extrema") as Record<string, unknown> | undefined;
        assert(rowExtrema !== undefined);
        assert.equal(rowExtrema.handoff_id, "h-extrema");
        assert.equal(rowExtrema.ambiguous_job_id, null);
        assert.equal(rowExtrema.source_thread_id, "src-extrema");
        assert.equal(rowExtrema.expected_generation, 9223372036854775807n);
        assert.equal(rowExtrema.discord_channel_id, 9223372036854775807n);
        assert.equal(rowExtrema.discord_thread_id, -9223372036854775808n);
        assert.equal(rowExtrema.quarantine_reason, "reason-extrema");
        assert.equal(rowExtrema.last_fork_error, "exact error message");
        assert.equal(rowExtrema.fork_failure_ambiguous, 1n);
        assert.equal(rowExtrema.observed_target_thread_id, "tgt-extrema");
        assert.equal(rowExtrema.target_thread_id, "tgt-extrema");
        assert.equal(rowExtrema.completed_generation, -9223372036854775808n);
        assert.equal(rowExtrema.created_at, 1234567.89);
        assert.equal(rowExtrema.completed_at, 9876543.21);

        const rowEmpty = queryStmt.get("") as Record<string, unknown> | undefined;
        assert(rowEmpty !== undefined);
        assert.equal(rowEmpty.handoff_id, "");
        assert.equal(rowEmpty.source_thread_id, "src-empty-id");
        assert.equal(rowEmpty.target_thread_id, null);
        assert.equal(rowEmpty.completed_generation, null);

        const rowNul = queryStmt.get("h-with-\0-nul") as Record<string, unknown> | undefined;
        assert(rowNul !== undefined);
        assert.equal(rowNul.handoff_id, "h-with-\0-nul");
        assert.equal(rowNul.quarantine_reason, "nul\0reason");
        assert.equal(rowNul.last_fork_error, "nul\0err");

        const rowBom = queryStmt.get("\uFEFFbom-prefixed-handoff") as Record<string, unknown> | undefined;
        assert(rowBom !== undefined);
        assert.equal(rowBom.handoff_id, "\uFEFFbom-prefixed-handoff");
        assert.equal(rowBom.quarantine_reason, "\uFEFFquarantine-bom");

        const rowAstral = queryStmt.get("h-astral-𐐷-🚀-test") as Record<string, unknown> | undefined;
        assert(rowAstral !== undefined);
        assert.equal(rowAstral.handoff_id, "h-astral-𐐷-🚀-test");
        assert.equal(rowAstral.source_thread_id, "src-astral-𐐷-id");
        assert.equal(rowAstral.observed_target_thread_id, "tgt-astral-𐐷");
        assert.equal(rowAstral.target_thread_id, "tgt-astral-𐐷");
        assert.equal(rowAstral.completed_generation, 40n);

        const remainingLiveCount = verifyDb
          .prepare("SELECT COUNT(*) AS total FROM codex_thread_fork_handoffs")
          .get() as { total?: unknown } | undefined;
        assert(remainingLiveCount !== undefined);
        assert.equal(remainingLiveCount.total, 0);
      } finally {
        verifyDb?.close();
      }
    } finally {
      cleanupTestDir(dir);
    }
  });
});

describe("retireCopyOnlyHandoffs: legacy schema migrations", () => {
  test("adds missing 3 columns to legacy fork table and drops observed target index", async () => {
    const dir = createTestDir("fork-legacy-");
    const dbPath = join(dir, "store.sqlite");
    try {
      let seedDb: DatabaseSync | undefined;
      try {
        seedDb = await openInitialized(dbPath);
        seedDb.exec(
          "CREATE TABLE codex_thread_fork_handoffs (\n" +
          "  handoff_id TEXT PRIMARY KEY,\n" +
          "  ambiguous_job_id TEXT UNIQUE,\n" +
          "  source_thread_id TEXT NOT NULL UNIQUE,\n" +
          "  expected_generation INTEGER NOT NULL,\n" +
          "  discord_channel_id INTEGER NOT NULL,\n" +
          "  discord_thread_id INTEGER NOT NULL,\n" +
          "  quarantine_reason TEXT NOT NULL,\n" +
          "  target_thread_id TEXT UNIQUE,\n" +
          "  completed_generation INTEGER,\n" +
          "  created_at REAL NOT NULL,\n" +
          "  completed_at REAL\n" +
          ");\n" +
          "CREATE INDEX codex_thread_fork_handoffs_observed_target ON codex_thread_fork_handoffs(source_thread_id);",
        );

        seedDb.prepare(
          `INSERT INTO codex_thread_fork_handoffs (
            handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
            discord_channel_id, discord_thread_id, quarantine_reason,
            target_thread_id, completed_generation, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "legacy-h1",
          null,
          "legacy-src-1",
          1n,
          101n,
          202n,
          "legacy-quarantine",
          null,
          null,
          500.0,
          null,
        );
      } finally {
        seedDb?.close();
      }

      const retiredCount = await retireCopyOnlyHandoffs(dbPath);
      assert.equal(retiredCount, 1n);

      let verifyDb: DatabaseSync | undefined;
      try {
        verifyDb = new DatabaseSync(dbPath);

        const cols = verifyDb
          .prepare("PRAGMA table_info(codex_thread_fork_handoffs)")
          .all() as Array<{ name?: unknown }>;
        const colNames = new Set(cols.map((c) => c.name));
        assert.equal(colNames.has("observed_target_thread_id"), true);
        assert.equal(colNames.has("last_fork_error"), true);
        assert.equal(colNames.has("fork_failure_ambiguous"), true);

        const indexExists = verifyDb
          .prepare(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='codex_thread_fork_handoffs_observed_target')",
          )
          .get() as Record<string, unknown> | undefined;
        assert(indexExists !== undefined);
        assert.equal(Object.values(indexExists)[0], 0);

        const retiredRow = verifyDb
          .prepare("SELECT * FROM codex_retired_fork_handoffs WHERE handoff_id = 'legacy-h1'")
          .get() as Record<string, unknown> | undefined;
        assert(retiredRow !== undefined);
        assert.equal(retiredRow.handoff_id, "legacy-h1");
        assert.equal(retiredRow.last_fork_error, "");
        assert.equal(retiredRow.fork_failure_ambiguous, 0);
        assert.equal(retiredRow.observed_target_thread_id, null);
      } finally {
        verifyDb?.close();
      }
    } finally {
      cleanupTestDir(dir);
    }
  });
});

describe("retireCopyOnlyHandoffs: transaction rollback and triggers", () => {
  test("native duplicate archive ID rolls back all rows, routing creation, schema alters, and index drops", async () => {
    const dir = createTestDir("fork-dup-rollback-");
    const dbPath = join(dir, "store.sqlite");
    try {
      let seedDb: DatabaseSync | undefined;
      try {
        seedDb = await openInitialized(dbPath);
        seedDb.exec(
          "CREATE TABLE codex_thread_fork_handoffs (\n" +
          "  handoff_id TEXT PRIMARY KEY,\n" +
          "  ambiguous_job_id TEXT UNIQUE,\n" +
          "  source_thread_id TEXT NOT NULL UNIQUE,\n" +
          "  expected_generation INTEGER NOT NULL,\n" +
          "  discord_channel_id INTEGER NOT NULL,\n" +
          "  discord_thread_id INTEGER NOT NULL,\n" +
          "  quarantine_reason TEXT NOT NULL,\n" +
          "  target_thread_id TEXT UNIQUE,\n" +
          "  completed_generation INTEGER,\n" +
          "  created_at REAL NOT NULL,\n" +
          "  completed_at REAL\n" +
          ");\n" +
          "CREATE INDEX codex_thread_fork_handoffs_observed_target ON codex_thread_fork_handoffs(source_thread_id);",
        );

        seedDb.prepare(
          `INSERT INTO codex_thread_fork_handoffs (
            handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
            discord_channel_id, discord_thread_id, quarantine_reason,
            target_thread_id, completed_generation, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run("clash-id", null, "live-src-1", 1n, 10n, 20n, "q", null, null, 100.0, null);

        seedDb.exec(
          "CREATE TABLE codex_retired_fork_handoffs AS SELECT * FROM codex_thread_fork_handoffs WHERE 0;\n" +
          "ALTER TABLE codex_retired_fork_handoffs ADD COLUMN observed_target_thread_id TEXT;\n" +
          "ALTER TABLE codex_retired_fork_handoffs ADD COLUMN last_fork_error TEXT NOT NULL DEFAULT '';\n" +
          "ALTER TABLE codex_retired_fork_handoffs ADD COLUMN fork_failure_ambiguous INTEGER NOT NULL DEFAULT 0;\n" +
          "CREATE UNIQUE INDEX codex_retired_fork_id ON codex_retired_fork_handoffs(handoff_id);",
        );
        seedDb.prepare(
          `INSERT INTO codex_retired_fork_handoffs (
            handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
            discord_channel_id, discord_thread_id, quarantine_reason,
            target_thread_id, completed_generation, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run("clash-id", null, "archive-src-clash", 1n, 10n, 20n, "q", null, null, 50.0, null);
      } finally {
        seedDb?.close();
      }

      await assert.rejects(
        async () => {
          await retireCopyOnlyHandoffs(dbPath);
        },
        (err: unknown) => {
          assert(err instanceof Error);
          assert.match(err.message, /UNIQUE constraint failed/i);
          return true;
        },
      );

      let verifyDb: DatabaseSync | undefined;
      try {
        verifyDb = new DatabaseSync(dbPath);
        assert.equal(exactThreadRoutingEnabledIn(verifyDb), false);

        const liveRows = verifyDb
          .prepare("SELECT handoff_id FROM codex_thread_fork_handoffs")
          .all() as Array<{ handoff_id?: unknown }>;
        assert.equal(liveRows.length, 1);
        assert.equal(liveRows[0]?.handoff_id, "clash-id");

        const liveColumns = (
          verifyDb.prepare("PRAGMA table_info(codex_thread_fork_handoffs)").all() as Array<{
            name: string;
          }>
        ).map((col) => col.name);
        assert.equal(liveColumns.includes("observed_target_thread_id"), false);
        assert.equal(liveColumns.includes("last_fork_error"), false);
        assert.equal(liveColumns.includes("fork_failure_ambiguous"), false);

        const indexStillExists = verifyDb
          .prepare(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='codex_thread_fork_handoffs_observed_target')",
          )
          .get() as Record<string, unknown> | undefined;
        assert(indexStillExists !== undefined);
        assert.equal(Object.values(indexStillExists)[0], 1);
      } finally {
        verifyDb?.close();
      }
    } finally {
      cleanupTestDir(dir);
    }
  });

  test("ABORT trigger on DELETE rolls back transaction and routing table creation", async () => {
    const dir = createTestDir("fork-abort-trigger-");
    const dbPath = join(dir, "store.sqlite");
    try {
      let seedDb: DatabaseSync | undefined;
      try {
        seedDb = await openInitialized(dbPath);
        seedDb.exec(
          "CREATE TABLE IF NOT EXISTS codex_thread_fork_handoffs (\n" +
          "  handoff_id TEXT PRIMARY KEY,\n" +
          "  ambiguous_job_id TEXT UNIQUE,\n" +
          "  source_thread_id TEXT NOT NULL UNIQUE,\n" +
          "  expected_generation INTEGER NOT NULL,\n" +
          "  discord_channel_id INTEGER NOT NULL,\n" +
          "  discord_thread_id INTEGER NOT NULL,\n" +
          "  quarantine_reason TEXT NOT NULL,\n" +
          "  last_fork_error TEXT NOT NULL DEFAULT '',\n" +
          "  fork_failure_ambiguous INTEGER NOT NULL DEFAULT 0,\n" +
          "  observed_target_thread_id TEXT,\n" +
          "  target_thread_id TEXT UNIQUE,\n" +
          "  completed_generation INTEGER,\n" +
          "  created_at REAL NOT NULL,\n" +
          "  completed_at REAL\n" +
          ");\n" +
          "CREATE TRIGGER trg_del_abort BEFORE DELETE ON codex_thread_fork_handoffs BEGIN SELECT RAISE(ABORT, 'intentional delete abort'); END;",
        );

        insertHandoff(seedDb, { handoffId: "h-abort-del", sourceThreadId: "src-abort-del" });
      } finally {
        seedDb?.close();
      }

      await assert.rejects(
        async () => {
          await retireCopyOnlyHandoffs(dbPath);
        },
        (err: unknown) => {
          assert(err instanceof Error);
          assert.match(err.message, /intentional delete abort/);
          return true;
        },
      );

      let verifyDb: DatabaseSync | undefined;
      try {
        verifyDb = new DatabaseSync(dbPath);
        assert.equal(exactThreadRoutingEnabledIn(verifyDb), false);

        const liveCount = verifyDb
          .prepare("SELECT COUNT(*) AS total FROM codex_thread_fork_handoffs")
          .get() as { total?: unknown } | undefined;
        assert(liveCount !== undefined);
        assert.equal(liveCount.total, 1);
      } finally {
        verifyDb?.close();
      }
    } finally {
      cleanupTestDir(dir);
    }
  });

  test("IGNORE insert trigger returns selected count with exact suppressed effects and no invented changes guard", async () => {
    const dir = createTestDir("fork-ignore-trigger-");
    const dbPath = join(dir, "store.sqlite");
    try {
      let seedDb: DatabaseSync | undefined;
      try {
        seedDb = await openInitialized(dbPath);
        seedDb.exec(
          "CREATE TABLE IF NOT EXISTS codex_thread_fork_handoffs (\n" +
          "  handoff_id TEXT PRIMARY KEY,\n" +
          "  ambiguous_job_id TEXT UNIQUE,\n" +
          "  source_thread_id TEXT NOT NULL UNIQUE,\n" +
          "  expected_generation INTEGER NOT NULL,\n" +
          "  discord_channel_id INTEGER NOT NULL,\n" +
          "  discord_thread_id INTEGER NOT NULL,\n" +
          "  quarantine_reason TEXT NOT NULL,\n" +
          "  last_fork_error TEXT NOT NULL DEFAULT '',\n" +
          "  fork_failure_ambiguous INTEGER NOT NULL DEFAULT 0,\n" +
          "  observed_target_thread_id TEXT,\n" +
          "  target_thread_id TEXT UNIQUE,\n" +
          "  completed_generation INTEGER,\n" +
          "  created_at REAL NOT NULL,\n" +
          "  completed_at REAL\n" +
          ");",
        );

        insertHandoff(seedDb, { handoffId: "h-ignore-1", sourceThreadId: "src-ignore-1" });
        insertHandoff(seedDb, { handoffId: "h-ignore-2", sourceThreadId: "src-ignore-2" });

        seedDb.exec(
          "CREATE TABLE IF NOT EXISTS codex_retired_fork_handoffs AS SELECT * FROM codex_thread_fork_handoffs WHERE 0;\n" +
          "CREATE UNIQUE INDEX IF NOT EXISTS codex_retired_fork_id ON codex_retired_fork_handoffs(handoff_id);\n" +
          "CREATE TRIGGER trg_ins_ignore BEFORE INSERT ON codex_retired_fork_handoffs BEGIN SELECT RAISE(IGNORE); END;",
        );
      } finally {
        seedDb?.close();
      }

      const returnedCount = await retireCopyOnlyHandoffs(dbPath);
      assert.equal(returnedCount, 2n);

      let verifyDb: DatabaseSync | undefined;
      try {
        verifyDb = new DatabaseSync(dbPath);

        const archiveCount = verifyDb
          .prepare("SELECT COUNT(*) AS total FROM codex_retired_fork_handoffs")
          .get() as { total?: unknown } | undefined;
        assert(archiveCount !== undefined);
        assert.equal(archiveCount.total, 0);

        const liveCount = verifyDb
          .prepare("SELECT COUNT(*) AS total FROM codex_thread_fork_handoffs")
          .get() as { total?: unknown } | undefined;
        assert(liveCount !== undefined);
        assert.equal(liveCount.total, 0);
      } finally {
        verifyDb?.close();
      }
    } finally {
      cleanupTestDir(dir);
    }
  });
});

describe("retireCopyOnlyHandoffs: close-error regression", () => {
  test("swallows close error after commit and does not leak or rollback", async () => {
    const dir = createTestDir("fork-retire-close-err-");
    const dbPath = join(dir, "store.sqlite");
    const closeSentinel = new Error("sentinel close error");
    try {
      assert.equal(await retireCopyOnlyHandoffs(dbPath), 0n);

      let seedDb: DatabaseSync | undefined;
      try {
        seedDb = await openInitialized(dbPath);
        insertHandoff(seedDb, {
          handoffId: "handoff-close-err-1",
          sourceThreadId: "src-close-err-1",
        });
      } finally {
        seedDb?.close();
      }

      let retiredCount: bigint;
      const originalClose = DatabaseSync.prototype.close;
      try {
        DatabaseSync.prototype.close = function (this: DatabaseSync): void {
          originalClose.call(this);
          throw closeSentinel;
        };
        retiredCount = await retireCopyOnlyHandoffs(dbPath);
      } finally {
        DatabaseSync.prototype.close = originalClose;
      }
      assert.equal(retiredCount, 1n);

      let verifyDb: DatabaseSync | undefined;
      try {
        verifyDb = new DatabaseSync(dbPath);
        const archived = verifyDb
          .prepare("SELECT handoff_id FROM codex_retired_fork_handoffs WHERE handoff_id = ?")
          .get("handoff-close-err-1");
        assert(archived !== undefined);

        const live = verifyDb
          .prepare("SELECT handoff_id FROM codex_thread_fork_handoffs WHERE handoff_id = ?")
          .get("handoff-close-err-1");
        assert.equal(live, undefined);
      } finally {
        verifyDb?.close();
      }
    } finally {
      cleanupTestDir(dir);
    }
  });
});

describe("retireCopyOnlyHandoffs: encoding, corruption, and roundtrips", () => {
  test("fails before archive writes when selected handoff_id is non-TEXT (INTEGER)", async () => {
    const dir = createTestDir("fork-corrupt-int-");
    const dbPath = join(dir, "store.sqlite");
    try {
      let seedDb: DatabaseSync | undefined;
      try {
        seedDb = await openInitialized(dbPath);
        seedDb.exec(
          "CREATE TABLE IF NOT EXISTS codex_thread_fork_handoffs (\n" +
          "  handoff_id PRIMARY KEY,\n" +
          "  ambiguous_job_id TEXT UNIQUE,\n" +
          "  source_thread_id TEXT NOT NULL UNIQUE,\n" +
          "  expected_generation INTEGER NOT NULL,\n" +
          "  discord_channel_id INTEGER NOT NULL,\n" +
          "  discord_thread_id INTEGER NOT NULL,\n" +
          "  quarantine_reason TEXT NOT NULL,\n" +
          "  last_fork_error TEXT NOT NULL DEFAULT '',\n" +
          "  fork_failure_ambiguous INTEGER NOT NULL DEFAULT 0,\n" +
          "  observed_target_thread_id TEXT,\n" +
          "  target_thread_id TEXT UNIQUE,\n" +
          "  completed_generation INTEGER,\n" +
          "  created_at REAL NOT NULL,\n" +
          "  completed_at REAL\n" +
          ");",
        );

        seedDb.prepare(
          "INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, expected_generation, discord_channel_id, discord_thread_id, quarantine_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(12345n, "src-nontext-int", 1n, 100n, 200n, "test", 1000.0);

        const typeRow = seedDb
          .prepare("SELECT typeof(handoff_id) AS id_type FROM codex_thread_fork_handoffs")
          .get() as { id_type?: unknown } | undefined;
        assert.equal(typeRow?.id_type, "integer");
      } finally {
        seedDb?.close();
      }

      await assert.rejects(
        async () => {
          await retireCopyOnlyHandoffs(dbPath);
        },
        (err: unknown) => {
          assert(err instanceof StoreIntegrityError);
          assert.match(err.message, /Expected string for column handoff_id/);
          return true;
        },
      );

      let verifyDb: DatabaseSync | undefined;
      try {
        verifyDb = new DatabaseSync(dbPath);
        const archiveExists = verifyDb
          .prepare(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_retired_fork_handoffs')",
          )
          .get() as Record<string, unknown> | undefined;
        assert(archiveExists !== undefined);
        assert.equal(Object.values(archiveExists)[0], 0);
        assert.equal(exactThreadRoutingEnabledIn(verifyDb), false);
      } finally {
        verifyDb?.close();
      }
    } finally {
      cleanupTestDir(dir);
    }
  });

  test("fails before archive writes when selected handoff_id contains invalid UTF-8 bytes", async () => {
    const dir = createTestDir("fork-corrupt-utf8-");
    const dbPath = join(dir, "store.sqlite");
    try {
      let seedDb: DatabaseSync | undefined;
      try {
        seedDb = await openInitialized(dbPath);
        seedDb.exec(
          "CREATE TABLE IF NOT EXISTS codex_thread_fork_handoffs (\n" +
          "  handoff_id TEXT PRIMARY KEY,\n" +
          "  ambiguous_job_id TEXT UNIQUE,\n" +
          "  source_thread_id TEXT NOT NULL UNIQUE,\n" +
          "  expected_generation INTEGER NOT NULL,\n" +
          "  discord_channel_id INTEGER NOT NULL,\n" +
          "  discord_thread_id INTEGER NOT NULL,\n" +
          "  quarantine_reason TEXT NOT NULL,\n" +
          "  last_fork_error TEXT NOT NULL DEFAULT '',\n" +
          "  fork_failure_ambiguous INTEGER NOT NULL DEFAULT 0,\n" +
          "  observed_target_thread_id TEXT,\n" +
          "  target_thread_id TEXT UNIQUE,\n" +
          "  completed_generation INTEGER,\n" +
          "  created_at REAL NOT NULL,\n" +
          "  completed_at REAL\n" +
          ");",
        );

        seedDb.exec(
          "INSERT INTO codex_thread_fork_handoffs (handoff_id, source_thread_id, expected_generation, discord_channel_id, discord_thread_id, quarantine_reason, created_at) VALUES (CAST(X'FFFEFD' AS TEXT), 'src-invalid-utf8', 1, 100, 200, 'test', 1000.0);",
        );
      } finally {
        seedDb?.close();
      }

      await assert.rejects(
        async () => {
          await retireCopyOnlyHandoffs(dbPath);
        },
        (err: unknown) => {
          assert(err instanceof StoreIntegrityError);
          return true;
        },
      );

      let verifyDb: DatabaseSync | undefined;
      try {
        verifyDb = new DatabaseSync(dbPath);
        const archiveExists = verifyDb
          .prepare(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_retired_fork_handoffs')",
          )
          .get() as Record<string, unknown> | undefined;
        assert(archiveExists !== undefined);
        assert.equal(Object.values(archiveExists)[0], 0);
        assert.equal(exactThreadRoutingEnabledIn(verifyDb), false);
      } finally {
        verifyDb?.close();
      }
    } finally {
      cleanupTestDir(dir);
    }
  });

  test("legitimate identities roundtrip through UTF-16LE without corruption", async () => {
    const dir = createTestDir("fork-utf16le-");
    const dbPath = join(dir, "store-utf16le.sqlite");
    try {
      const raw = new DatabaseSync(dbPath);
      raw.exec("PRAGMA encoding = 'UTF-16le';");
      raw.exec("CREATE TABLE encoding_sentinel(id INTEGER PRIMARY KEY);");
      raw.close();

      let seedDb: DatabaseSync | undefined;
      try {
        seedDb = await openInitialized(dbPath);
        const seedEnc = seedDb.prepare("PRAGMA encoding;").get() as Record<string, unknown> | undefined;
        assert.equal(seedEnc !== undefined ? Object.values(seedEnc)[0] : undefined, "UTF-16le");
        seedDb.exec(
          "CREATE TABLE IF NOT EXISTS codex_thread_fork_handoffs (\n" +
          "  handoff_id TEXT PRIMARY KEY,\n" +
          "  ambiguous_job_id TEXT UNIQUE,\n" +
          "  source_thread_id TEXT NOT NULL UNIQUE,\n" +
          "  expected_generation INTEGER NOT NULL,\n" +
          "  discord_channel_id INTEGER NOT NULL,\n" +
          "  discord_thread_id INTEGER NOT NULL,\n" +
          "  quarantine_reason TEXT NOT NULL,\n" +
          "  last_fork_error TEXT NOT NULL DEFAULT '',\n" +
          "  fork_failure_ambiguous INTEGER NOT NULL DEFAULT 0,\n" +
          "  observed_target_thread_id TEXT,\n" +
          "  target_thread_id TEXT UNIQUE,\n" +
          "  completed_generation INTEGER,\n" +
          "  created_at REAL NOT NULL,\n" +
          "  completed_at REAL\n" +
          ");",
        );

        insertHandoff(seedDb, {
          handoffId: "ascii-utf16-id",
          sourceThreadId: "src-utf16-1",
        });
        insertHandoff(seedDb, {
          handoffId: "심쿵-유니코드-전달",
          sourceThreadId: "src-utf16-2",
        });
        insertHandoff(seedDb, {
          handoffId: "astral-𐐷-rocket-🚀",
          sourceThreadId: "src-utf16-3",
        });
      } finally {
        seedDb?.close();
      }

      const retiredCount = await retireCopyOnlyHandoffs(dbPath);
      assert.equal(retiredCount, 3n);

      let verifyDb: DatabaseSync | undefined;
      try {
        verifyDb = new DatabaseSync(dbPath);
        const rows = verifyDb
          .prepare("SELECT handoff_id FROM codex_retired_fork_handoffs ORDER BY handoff_id")
          .all() as Array<{ handoff_id?: unknown }>;
        const ids = new Set(rows.map((r) => r.handoff_id));
        assert.equal(ids.has("ascii-utf16-id"), true);
        assert.equal(ids.has("심쿵-유니코드-전달"), true);
        assert.equal(ids.has("astral-𐐷-rocket-🚀"), true);
        const postEnc = verifyDb.prepare("PRAGMA encoding;").get() as Record<string, unknown> | undefined;
        assert.equal(postEnc !== undefined ? Object.values(postEnc)[0] : undefined, "UTF-16le");
      } finally {
        verifyDb?.close();
      }
    } finally {
      cleanupTestDir(dir);
    }
  });

  test("legitimate identities roundtrip through UTF-16BE if supported by SQLite engine", async () => {
    const dir = createTestDir("fork-utf16be-");
    const dbPath = join(dir, "store-utf16be.sqlite");
    try {
      const raw = new DatabaseSync(dbPath);
      raw.exec("PRAGMA encoding = 'UTF-16be';");
      const encRow = raw.prepare("PRAGMA encoding;").get() as Record<string, unknown> | undefined;
      const encoding = encRow !== undefined ? Object.values(encRow)[0] : undefined;
      assert.equal(encoding, "UTF-16be");
      raw.exec("CREATE TABLE encoding_sentinel(id INTEGER PRIMARY KEY);");
      raw.close();

      if (encoding === "UTF-16be") {
        let seedDb: DatabaseSync | undefined;
        try {
          seedDb = await openInitialized(dbPath);
          const seedEnc = seedDb.prepare("PRAGMA encoding;").get() as Record<string, unknown> | undefined;
          assert.equal(seedEnc !== undefined ? Object.values(seedEnc)[0] : undefined, "UTF-16be");
          seedDb.exec(
            "CREATE TABLE IF NOT EXISTS codex_thread_fork_handoffs (\n" +
            "  handoff_id TEXT PRIMARY KEY,\n" +
            "  ambiguous_job_id TEXT UNIQUE,\n" +
            "  source_thread_id TEXT NOT NULL UNIQUE,\n" +
            "  expected_generation INTEGER NOT NULL,\n" +
            "  discord_channel_id INTEGER NOT NULL,\n" +
            "  discord_thread_id INTEGER NOT NULL,\n" +
            "  quarantine_reason TEXT NOT NULL,\n" +
            "  last_fork_error TEXT NOT NULL DEFAULT '',\n" +
            "  fork_failure_ambiguous INTEGER NOT NULL DEFAULT 0,\n" +
            "  observed_target_thread_id TEXT,\n" +
            "  target_thread_id TEXT UNIQUE,\n" +
            "  completed_generation INTEGER,\n" +
            "  created_at REAL NOT NULL,\n" +
            "  completed_at REAL\n" +
            ");",
          );

          insertHandoff(seedDb, {
            handoffId: "ascii-be-id",
            sourceThreadId: "src-be-1",
          });
          insertHandoff(seedDb, {
            handoffId: "astral-𐐷-be",
            sourceThreadId: "src-be-2",
          });
        } finally {
          seedDb?.close();
        }

        const retiredCount = await retireCopyOnlyHandoffs(dbPath);
        assert.equal(retiredCount, 2n);

        let verifyDb: DatabaseSync | undefined;
        try {
          verifyDb = new DatabaseSync(dbPath);
          const postEnc = verifyDb.prepare("PRAGMA encoding;").get() as Record<string, unknown> | undefined;
          assert.equal(postEnc !== undefined ? Object.values(postEnc)[0] : undefined, "UTF-16be");
          const rows = verifyDb
            .prepare("SELECT handoff_id FROM codex_retired_fork_handoffs")
            .all() as Array<{ handoff_id?: unknown }>;
          const ids = new Set(rows.map((r) => r.handoff_id));
          assert.equal(ids.has("ascii-be-id"), true);
          assert.equal(ids.has("astral-𐐷-be"), true);
        } finally {
          verifyDb?.close();
        }
      }
    } finally {
      cleanupTestDir(dir);
    }
  });
});
