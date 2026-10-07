import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  adoptGeneration,
  adoptTargetGeneration,
  type QueueGenerationAdoption,
} from "../../src/store/queue-generation.ts";
import { openInitialized } from "../../src/store/owned-driver.ts";
import {
  allJobs,
  selectJob,
  StoreIntegrityError,
  InvalidQueueStateError,
  QUARANTINED_TURN_PREFIX,
  QUARANTINED_ERROR_PREFIX,
  type StoredQueueJob,
} from "../../src/store/queue-read.ts";
import { I64_MAX, I64_MIN } from "../../src/protocol/ids.ts";

type SqlParam = string | number | bigint | Uint8Array | null;

interface FixtureRow {
  job_id: SqlParam;
  target_thread_id: SqlParam;
  channel_id: SqlParam;
  owner_user_id: SqlParam;
  discord_message_id: SqlParam;
  app_server_generation: SqlParam;
  execution_generation: SqlParam;
  prompt: SqlParam;
  queued: SqlParam;
  ack_sent: SqlParam;
  state: SqlParam;
  attempt_count: SqlParam;
  turn_id: SqlParam;
  baseline_turn_ids: SqlParam;
  last_error: SqlParam;
  created_at: SqlParam;
  updated_at: SqlParam;
  goal_waiting: SqlParam;
  turn_observation_generation: SqlParam;
}

const INSERT_SQL = `
  INSERT INTO codex_turn_queue (
    job_id, target_thread_id, channel_id, owner_user_id,
    discord_message_id, app_server_generation, execution_generation,
    prompt, queued, ack_sent, state, attempt_count,
    turn_id, baseline_turn_ids, last_error, created_at,
    updated_at, goal_waiting, turn_observation_generation
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function insertJob(db: DatabaseSync, overrides: Partial<FixtureRow> = {}): void {
  const row: FixtureRow = {
    job_id: "job-default-1",
    target_thread_id: "thread-default-1",
    channel_id: 1000n,
    owner_user_id: 2000n,
    discord_message_id: null,
    app_server_generation: 1n,
    execution_generation: 2n,
    prompt: "default prompt",
    queued: 1n,
    ack_sent: 0n,
    state: "pending",
    attempt_count: 0n,
    turn_id: null,
    baseline_turn_ids: "[]",
    last_error: "",
    created_at: 1712000000.5,
    updated_at: 1712000001.5,
    goal_waiting: 0n,
    turn_observation_generation: null,
    ...overrides,
  };
  db.prepare(INSERT_SQL).run(
    row.job_id,
    row.target_thread_id,
    row.channel_id,
    row.owner_user_id,
    row.discord_message_id,
    row.app_server_generation,
    row.execution_generation,
    row.prompt,
    row.queued,
    row.ack_sent,
    row.state,
    row.attempt_count,
    row.turn_id,
    row.baseline_turn_ids,
    row.last_error,
    row.created_at,
    row.updated_at,
    row.goal_waiting,
    row.turn_observation_generation,
  );
}

let activeDirs: string[] = [];
let activeDbs: DatabaseSync[] = [];

async function createTestDb(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cdr-gen-test-"));
  activeDirs.push(dir);
  const dbPath = path.join(dir, "queue.sqlite");
  const db = await openInitialized(dbPath);
  db.close();
  return dbPath;
}

function trackDb(db: DatabaseSync): DatabaseSync {
  activeDbs.push(db);
  return db;
}

afterEach(async () => {
  for (const db of activeDbs) {
    try {
      db.close();
    } catch {
      // ignore already closed
    }
  }
  activeDbs = [];

  for (const dir of activeDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  activeDirs = [];
});

describe("queue-generation test suite", () => {
  describe("Suite 1: Argument validation & type checking (no file created)", () => {
    it("rejects invalid path type or ill-formed surrogate string without creating file", async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "cdr-gen-val-"));
      activeDirs.push(dir);
      const nonExistentPath = path.join(dir, "no-create.sqlite");

      await assert.rejects(
        adoptGeneration(123 as unknown as string, 1n),
        TypeError,
      );
      await assert.rejects(
        adoptGeneration(null as unknown as string, 1n),
        TypeError,
      );
      await assert.rejects(
        adoptGeneration(undefined as unknown as string, 1n),
        TypeError,
      );
      await assert.rejects(
        adoptGeneration("bad\uD800path", 1n),
        TypeError,
      );

      await assert.rejects(
        adoptTargetGeneration(123 as unknown as string, "target", 1n),
        TypeError,
      );
      await assert.rejects(
        adoptTargetGeneration("bad\uD800path", "target", 1n),
        TypeError,
      );

      assert.strictEqual(existsSync(nonExistentPath), false);
    });

    it("rejects invalid generation type without creating file", async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "cdr-gen-val-"));
      activeDirs.push(dir);
      const nonExistentPath = path.join(dir, "no-create-gen.sqlite");

      await assert.rejects(
        adoptGeneration(nonExistentPath, 123 as unknown as bigint),
        { name: "TypeError", message: "Invalid generation: expected bigint" },
      );
      await assert.rejects(
        adoptGeneration(nonExistentPath, "1" as unknown as bigint),
        { name: "TypeError", message: "Invalid generation: expected bigint" },
      );
      await assert.rejects(
        adoptGeneration(nonExistentPath, null as unknown as bigint),
        { name: "TypeError", message: "Invalid generation: expected bigint" },
      );
      await assert.rejects(
        adoptGeneration(nonExistentPath, undefined as unknown as bigint),
        { name: "TypeError", message: "Invalid generation: expected bigint" },
      );
      await assert.rejects(
        adoptGeneration(nonExistentPath, {} as unknown as bigint),
        { name: "TypeError", message: "Invalid generation: expected bigint" },
      );

      assert.strictEqual(existsSync(nonExistentPath), false);
    });

    it("rejects generation outside signed i64 range without creating file", async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "cdr-gen-val-"));
      activeDirs.push(dir);
      const nonExistentPath = path.join(dir, "no-create-range.sqlite");

      await assert.rejects(
        adoptGeneration(nonExistentPath, I64_MAX + 1n),
        RangeError,
      );
      await assert.rejects(
        adoptGeneration(nonExistentPath, I64_MIN - 1n),
        RangeError,
      );
      await assert.rejects(
        adoptTargetGeneration(nonExistentPath, "t1", I64_MAX + 1n),
        RangeError,
      );
      await assert.rejects(
        adoptTargetGeneration(nonExistentPath, "t1", I64_MIN - 1n),
        RangeError,
      );

      assert.strictEqual(existsSync(nonExistentPath), false);
    });

    it("rejects invalid target type or ill-formed surrogate target", async () => {
      const dbPath = await createTestDb();

      await assert.rejects(
        adoptTargetGeneration(dbPath, 123 as unknown as string, 1n),
        { name: "TypeError", message: "Invalid target: expected well-formed string" },
      );
      await assert.rejects(
        adoptTargetGeneration(dbPath, null as unknown as string, 1n),
        { name: "TypeError", message: "Invalid target: expected well-formed string" },
      );
      await assert.rejects(
        adoptTargetGeneration(dbPath, undefined as unknown as string, 1n),
        { name: "TypeError", message: "Invalid target: expected well-formed string" },
      );
      await assert.rejects(
        adoptTargetGeneration(dbPath, "target\uD800bad", 1n),
        { name: "TypeError", message: "Invalid target: expected well-formed string" },
      );
      await assert.rejects(
        adoptTargetGeneration(dbPath, "target\uDC00bad", 1n),
        { name: "TypeError", message: "Invalid target: expected well-formed string" },
      );
    });
  });

  describe("Suite 2: Fresh schema & missing target handling", () => {
    it("returns empty jobs and 0n adopted count on fresh empty database", async () => {
      const dbPath = await createTestDb();

      const genRes: QueueGenerationAdoption = await adoptGeneration(dbPath, 42n);
      assert.strictEqual(typeof genRes.adoptedCount, "bigint");
      assert.strictEqual(genRes.adoptedCount, 0n);
      assert.deepStrictEqual(genRes.jobs, []);

      const targetRes: QueueGenerationAdoption = await adoptTargetGeneration(
        dbPath,
        "thread-missing",
        42n,
      );
      assert.strictEqual(typeof targetRes.adoptedCount, "bigint");
      assert.strictEqual(targetRes.adoptedCount, 0n);
      assert.deepStrictEqual(targetRes.jobs, []);
    });

    it("returns empty jobs and 0n adopted count for missing target when other targets exist", async () => {
      const dbPath = await createTestDb();
      const setupDb = trackDb(await openInitialized(dbPath));
      insertJob(setupDb, {
        job_id: "job-existing-1",
        target_thread_id: "thread-existing",
        state: "pending",
        app_server_generation: 1n,
      });
      setupDb.close();

      const res = await adoptTargetGeneration(dbPath, "thread-missing", 99n);
      assert.strictEqual(res.adoptedCount, 0n);
      assert.deepStrictEqual(res.jobs, []);

      const checkDb = trackDb(await openInitialized(dbPath));
      const existing = selectJob(checkDb, "job-existing-1");
      assert.strictEqual(existing.appServerGeneration, 1n);
      checkDb.close();
    });
  });

  describe("Suite 3: Global multi-row adoption with all state variants", () => {
    it("updates only pending non-held jobs with different generation, decodes all states, and preserves all other columns", async () => {
      const dbPath = await createTestDb();
      const setupDb = trackDb(await openInitialized(dbPath));

      // 1. Pending job eligible for adoption
      insertJob(setupDb, {
        job_id: "job-p1",
        target_thread_id: "thread-eligible-1",
        channel_id: 1111n,
        owner_user_id: 2222n,
        discord_message_id: 3333n,
        app_server_generation: 10n,
        execution_generation: 5n,
        turn_observation_generation: 7n,
        prompt: "eligible prompt 1",
        queued: 1n,
        ack_sent: 0n,
        state: "pending",
        attempt_count: 3n,
        turn_id: null,
        baseline_turn_ids: JSON.stringify(["turn-base-1"]),
        last_error: "",
        created_at: 1000.0,
        updated_at: 1001.0,
        goal_waiting: 0n,
      });

      // 2. Pending job already matching requested generation (app_server_generation == 99n)
      insertJob(setupDb, {
        job_id: "job-p2",
        target_thread_id: "thread-matching-gen",
        app_server_generation: 99n,
        state: "pending",
        created_at: 1002.0,
        updated_at: 1003.0,
      });

      // 3. Pending job on thread with dead generation hold
      insertJob(setupDb, {
        job_id: "job-p-held",
        target_thread_id: "thread-held",
        app_server_generation: 10n,
        state: "pending",
        created_at: 1004.0,
        updated_at: 1005.0,
      });
      setupDb
        .prepare(
          "INSERT INTO codex_dead_generation_holds (target_thread_id, runtime_id, generation, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("thread-held", "runtime-test", 10n, 1000.0);

      // 4. Running job
      insertJob(setupDb, {
        job_id: "job-running",
        target_thread_id: "thread-running",
        app_server_generation: 10n,
        state: "running",
        turn_id: "turn-running-1",
        created_at: 1006.0,
        updated_at: 1007.0,
      });

      // 5. Starting job
      insertJob(setupDb, {
        job_id: "job-starting",
        target_thread_id: "thread-starting",
        app_server_generation: 10n,
        state: "starting",
        created_at: 1008.0,
        updated_at: 1009.0,
      });

      // 6. Quarantined job (running + quarantined turn prefix + quarantined error prefix)
      insertJob(setupDb, {
        job_id: "job-quarantined",
        target_thread_id: "thread-quarantined",
        app_server_generation: 10n,
        state: "running",
        turn_id: `${QUARANTINED_TURN_PREFIX}fork-id-1`,
        last_error: `${QUARANTINED_ERROR_PREFIX}fork crashed`,
        created_at: 1010.0,
        updated_at: 1011.0,
      });

      // 7. Second pending job eligible for adoption
      insertJob(setupDb, {
        job_id: "job-p3",
        target_thread_id: "thread-eligible-2",
        app_server_generation: 20n,
        state: "pending",
        created_at: 1012.0,
        updated_at: 1013.0,
      });

      setupDb.close();

      const res = await adoptGeneration(dbPath, 99n);

      assert.strictEqual(typeof res.adoptedCount, "bigint");
      assert.strictEqual(res.adoptedCount, 2n);
      assert.strictEqual(res.jobs.length, 7);

      const jobMap = new Map<string, StoredQueueJob>(
        res.jobs.map((job) => [job.jobId, job]),
      );

      // Verify job-p1: adopted and all preserved columns match
      const p1 = jobMap.get("job-p1")!;
      assert.ok(p1);
      assert.strictEqual(p1.appServerGeneration, 99n);
      assert.strictEqual(p1.state, "Pending");
      assert.strictEqual(p1.targetThreadId, "thread-eligible-1");
      assert.strictEqual(p1.channelId, 1111n);
      assert.strictEqual(p1.ownerUserId, 2222n);
      assert.strictEqual(p1.discordMessageId, 3333n);
      assert.strictEqual(p1.executionGeneration, 5n);
      assert.strictEqual(p1.turnObservationGeneration, 7n);
      assert.strictEqual(p1.prompt, "eligible prompt 1");
      assert.strictEqual(p1.queued, true);
      assert.strictEqual(p1.ackSent, false);
      assert.strictEqual(p1.attemptCount, 3n);
      assert.strictEqual(p1.turnId, null);
      assert.deepStrictEqual(p1.baselineTurnIds, ["turn-base-1"]);
      assert.strictEqual(p1.lastError, "");
      assert.strictEqual(p1.createdAt, 1000.0);
      assert.strictEqual(p1.updatedAt, 1001.0);
      assert.strictEqual(p1.goalWaiting, false);

      // Verify job-p2: already matching generation, remains pending and 99n
      const p2 = jobMap.get("job-p2")!;
      assert.ok(p2);
      assert.strictEqual(p2.appServerGeneration, 99n);
      assert.strictEqual(p2.state, "Pending");

      // Verify job-p-held: not adopted because target is held
      const held = jobMap.get("job-p-held")!;
      assert.ok(held);
      assert.strictEqual(held.appServerGeneration, 10n);
      assert.strictEqual(held.state, "Pending");

      // Verify job-running: not adopted, state Running
      const running = jobMap.get("job-running")!;
      assert.ok(running);
      assert.strictEqual(running.appServerGeneration, 10n);
      assert.strictEqual(running.state, "Running");

      // Verify job-starting: not adopted, state Starting
      const starting = jobMap.get("job-starting")!;
      assert.ok(starting);
      assert.strictEqual(starting.appServerGeneration, 10n);
      assert.strictEqual(starting.state, "Starting");

      // Verify job-quarantined: not adopted, state Quarantined
      const quar = jobMap.get("job-quarantined")!;
      assert.ok(quar);
      assert.strictEqual(quar.appServerGeneration, 10n);
      assert.strictEqual(quar.state, "Quarantined");

      // Verify job-p3: adopted to 99n
      const p3 = jobMap.get("job-p3")!;
      assert.ok(p3);
      assert.strictEqual(p3.appServerGeneration, 99n);
      assert.strictEqual(p3.state, "Pending");
    });
  });

  describe("Suite 4: Targeted change scope and returned target states", () => {
    it("scopes updates to specified target and returns all jobs for that target while filtering out others", async () => {
      const dbPath = await createTestDb();
      const setupDb = trackDb(await openInitialized(dbPath));

      // Target A jobs
      insertJob(setupDb, {
        job_id: "job-a-pending",
        target_thread_id: "target-A",
        state: "pending",
        app_server_generation: 1n,
        created_at: 100.0,
      });
      insertJob(setupDb, {
        job_id: "job-a-running",
        target_thread_id: "target-A",
        state: "running",
        app_server_generation: 1n,
        created_at: 101.0,
      });
      insertJob(setupDb, {
        job_id: "job-a-already-matching",
        target_thread_id: "target-A",
        state: "pending",
        app_server_generation: 99n,
        created_at: 102.0,
      });
      insertJob(setupDb, {
        job_id: "job-a-held",
        target_thread_id: "target-A-held",
        state: "pending",
        app_server_generation: 1n,
        created_at: 103.0,
      });
      setupDb
        .prepare(
          "INSERT INTO codex_dead_generation_holds (target_thread_id, runtime_id, generation, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("target-A-held", "runtime-x", 1n, 100.0);

      // Target B jobs (unrelated target)
      insertJob(setupDb, {
        job_id: "job-b-pending",
        target_thread_id: "target-B",
        state: "pending",
        app_server_generation: 1n,
        created_at: 104.0,
      });

      setupDb.close();

      const res = await adoptTargetGeneration(dbPath, "target-A", 99n);

      assert.strictEqual(res.adoptedCount, 1n);
      assert.strictEqual(res.jobs.length, 3);
      for (const job of res.jobs) {
        assert.strictEqual(job.targetThreadId, "target-A");
      }

      const aPending = res.jobs.find((j) => j.jobId === "job-a-pending")!;
      assert.ok(aPending);
      assert.strictEqual(aPending.appServerGeneration, 99n);
      assert.strictEqual(aPending.state, "Pending");

      const aRunning = res.jobs.find((j) => j.jobId === "job-a-running")!;
      assert.ok(aRunning);
      assert.strictEqual(aRunning.appServerGeneration, 1n);
      assert.strictEqual(aRunning.state, "Running");

      const aMatching = res.jobs.find((j) => j.jobId === "job-a-already-matching")!;
      assert.ok(aMatching);
      assert.strictEqual(aMatching.appServerGeneration, 99n);
      assert.strictEqual(aMatching.state, "Pending");

      // Re-read DB on separate connection to verify target-B and target-A-held were unaffected
      const checkDb = trackDb(await openInitialized(dbPath));
      const bJob = selectJob(checkDb, "job-b-pending");
      assert.strictEqual(bJob.appServerGeneration, 1n);
      const aHeldJob = selectJob(checkDb, "job-a-held");
      assert.strictEqual(aHeldJob.appServerGeneration, 1n);
      checkDb.close();
    });
  });

  describe("Suite 5: Sealed generation decoupling vs dead generation hold semantics", () => {
    it("does not gate adoption when an incident exists in codex_dead_generation_incidents", async () => {
      const dbPath = await createTestDb();
      const setupDb = trackDb(await openInitialized(dbPath));

      insertJob(setupDb, {
        job_id: "job-incident-test",
        target_thread_id: "thread-unheld",
        state: "pending",
        app_server_generation: 1n,
      });
      setupDb
        .prepare(
          "INSERT INTO codex_dead_generation_incidents (runtime_id, generation, snapshot_json, queue_jobs_json, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("runtime-incident", 99n, "{}", "[]", 500.0);
      setupDb.close();

      const res = await adoptGeneration(dbPath, 99n);
      assert.strictEqual(res.adoptedCount, 1n);
      const row = res.jobs[0];
      assert.ok(row);
      assert.strictEqual(row.appServerGeneration, 99n);
    });

    it("gates adoption strictly by target thread presence in codex_dead_generation_holds regardless of hold generation", async () => {
      const dbPath = await createTestDb();
      const setupDb = trackDb(await openInitialized(dbPath));

      insertJob(setupDb, {
        job_id: "job-hold-diff-gen",
        target_thread_id: "thread-hold-test",
        state: "pending",
        app_server_generation: 1n,
      });
      // Hold recorded with generation 77n, but adoption request is for 99n
      setupDb
        .prepare(
          "INSERT INTO codex_dead_generation_holds (target_thread_id, runtime_id, generation, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("thread-hold-test", "runtime-hold", 77n, 600.0);
      setupDb.close();

      const genRes = await adoptGeneration(dbPath, 99n);
      assert.strictEqual(genRes.adoptedCount, 0n);
      const row = genRes.jobs[0];
      assert.ok(row);
      assert.strictEqual(row.appServerGeneration, 1n);

      const targetRes = await adoptTargetGeneration(dbPath, "thread-hold-test", 99n);
      assert.strictEqual(targetRes.adoptedCount, 0n);
      const targetRow = targetRes.jobs[0];
      assert.ok(targetRow);
      assert.strictEqual(targetRow.appServerGeneration, 1n);
    });
  });

  describe("Suite 6: Extremal signed i64 and negative generations", () => {
    it("adopts negative generations (-1n)", async () => {
      const dbPath = await createTestDb();
      const setupDb = trackDb(await openInitialized(dbPath));
      insertJob(setupDb, {
        job_id: "job-neg",
        target_thread_id: "t-neg",
        state: "pending",
        app_server_generation: 0n,
      });
      setupDb.close();

      const res = await adoptGeneration(dbPath, -1n);
      assert.strictEqual(res.adoptedCount, 1n);
      const row = res.jobs[0];
      assert.ok(row);
      assert.strictEqual(row.appServerGeneration, -1n);

      const checkDb = trackDb(await openInitialized(dbPath));
      assert.strictEqual(selectJob(checkDb, "job-neg").appServerGeneration, -1n);
      checkDb.close();
    });

    it("adopts I64_MIN (-9223372036854775808n)", async () => {
      const dbPath = await createTestDb();
      const setupDb = trackDb(await openInitialized(dbPath));
      insertJob(setupDb, {
        job_id: "job-min",
        target_thread_id: "t-min",
        state: "pending",
        app_server_generation: 0n,
      });
      setupDb.close();

      const res = await adoptGeneration(dbPath, I64_MIN);
      assert.strictEqual(res.adoptedCount, 1n);
      const row = res.jobs[0];
      assert.ok(row);
      assert.strictEqual(row.appServerGeneration, I64_MIN);

      const checkDb = trackDb(await openInitialized(dbPath));
      assert.strictEqual(selectJob(checkDb, "job-min").appServerGeneration, I64_MIN);
      checkDb.close();
    });

    it("adopts I64_MAX (9223372036854775807n) with adoptTargetGeneration", async () => {
      const dbPath = await createTestDb();
      const setupDb = trackDb(await openInitialized(dbPath));
      insertJob(setupDb, {
        job_id: "job-max",
        target_thread_id: "t-max",
        state: "pending",
        app_server_generation: 0n,
      });
      setupDb.close();

      const res = await adoptTargetGeneration(dbPath, "t-max", I64_MAX);
      assert.strictEqual(res.adoptedCount, 1n);
      const row = res.jobs[0];
      assert.ok(row);
      assert.strictEqual(row.appServerGeneration, I64_MAX);

      const checkDb = trackDb(await openInitialized(dbPath));
      assert.strictEqual(selectJob(checkDb, "job-max").appServerGeneration, I64_MAX);
      checkDb.close();
    });

    it("adopts generation 0n", async () => {
      const dbPath = await createTestDb();
      const setupDb = trackDb(await openInitialized(dbPath));
      insertJob(setupDb, {
        job_id: "job-zero",
        target_thread_id: "t-zero",
        state: "pending",
        app_server_generation: 10n,
      });
      setupDb.close();

      const res = await adoptGeneration(dbPath, 0n);
      assert.strictEqual(res.adoptedCount, 1n);
      const row = res.jobs[0];
      assert.ok(row);
      assert.strictEqual(row.appServerGeneration, 0n);
    });
  });

  describe("Suite 7: Strict Unicode scalars, empty target, and embedded NUL", () => {
    it("preserves exact Unicode scalars without replacement characters for complex target threads", async () => {
      const dbPath = await createTestDb();
      const complexTarget = "thread-🎯-\u{1F984}-\u{1F600}-한글-日本語-éàü";
      const complexJobId = "job-unicode-🌟";

      const setupDb = trackDb(await openInitialized(dbPath));
      insertJob(setupDb, {
        job_id: complexJobId,
        target_thread_id: complexTarget,
        state: "pending",
        app_server_generation: 1n,
      });
      setupDb.close();

      const res = await adoptTargetGeneration(dbPath, complexTarget, 88n);
      assert.strictEqual(res.adoptedCount, 1n);
      assert.strictEqual(res.jobs.length, 1);
      const row = res.jobs[0];
      assert.ok(row);
      assert.strictEqual(row.targetThreadId, complexTarget);
      assert.strictEqual(row.jobId, complexJobId);
      assert.strictEqual(row.targetThreadId.includes("\uFFFD"), false);
    });

    it("handles empty string target correctly", async () => {
      const dbPath = await createTestDb();
      const setupDb = trackDb(await openInitialized(dbPath));
      insertJob(setupDb, {
        job_id: "job-empty-target",
        target_thread_id: "",
        state: "pending",
        app_server_generation: 1n,
      });
      setupDb.close();

      const res = await adoptTargetGeneration(dbPath, "", 88n);
      assert.strictEqual(res.adoptedCount, 1n);
      assert.strictEqual(res.jobs.length, 1);
      const row = res.jobs[0];
      assert.ok(row);
      assert.strictEqual(row.targetThreadId, "");
      assert.strictEqual(row.appServerGeneration, 88n);
    });

    it("handles embedded NUL byte in target thread ID", async () => {
      const dbPath = await createTestDb();
      const nulTarget = "thread\0with\0embedded\0nul";
      const setupDb = trackDb(await openInitialized(dbPath));
      insertJob(setupDb, {
        job_id: "job-nul-target",
        target_thread_id: nulTarget,
        state: "pending",
        app_server_generation: 1n,
      });
      setupDb.close();

      const res = await adoptTargetGeneration(dbPath, nulTarget, 88n);
      assert.strictEqual(res.adoptedCount, 1n);
      assert.strictEqual(res.jobs.length, 1);
      const row = res.jobs[0];
      assert.ok(row);
      assert.strictEqual(row.targetThreadId, nulTarget);
      assert.strictEqual(row.appServerGeneration, 88n);
    });
  });

  describe("Suite 8: allJobs ordering (created_at asc, job_id asc)", () => {
    it("returns jobs strictly ordered by created_at then job_id", async () => {
      const dbPath = await createTestDb();
      const setupDb = trackDb(await openInitialized(dbPath));

      // Insert jobs deliberately out of order
      insertJob(setupDb, {
        job_id: "job-c",
        target_thread_id: "t-order",
        created_at: 200.0,
      });
      insertJob(setupDb, {
        job_id: "job-b",
        target_thread_id: "t-order",
        created_at: 100.0,
      });
      insertJob(setupDb, {
        job_id: "job-a",
        target_thread_id: "t-order",
        created_at: 100.0,
      });
      insertJob(setupDb, {
        job_id: "job-d",
        target_thread_id: "t-order",
        created_at: 300.0,
      });
      insertJob(setupDb, {
        job_id: "job-e",
        target_thread_id: "t-order",
        created_at: 200.0,
      });
      setupDb.close();

      const res = await adoptGeneration(dbPath, 77n);
      const returnedIds = res.jobs.map((j) => j.jobId);
      assert.deepStrictEqual(returnedIds, [
        "job-a", // 100.0, 'job-a' < 'job-b'
        "job-b", // 100.0
        "job-c", // 200.0, 'job-c' < 'job-e'
        "job-e", // 200.0
        "job-d", // 300.0
      ]);
    });
  });

  describe("Suite 9: Decoding failure and transaction rollback", () => {
    it("throws StoreIntegrityError and rolls back target changes when an unrelated row has malformed baseline_turn_ids", async () => {
      const dbPath = await createTestDb();
      const setupDb = trackDb(await openInitialized(dbPath));

      // Valid job on target-A
      insertJob(setupDb, {
        job_id: "job-target-valid",
        target_thread_id: "target-A",
        state: "pending",
        app_server_generation: 10n,
        baseline_turn_ids: "[]",
      });

      // Malformed row on unrelated target-B (not valid JSON)
      insertJob(setupDb, {
        job_id: "job-unrelated-malformed",
        target_thread_id: "target-B",
        state: "pending",
        app_server_generation: 10n,
        baseline_turn_ids: "NOT_VALID_JSON{[",
      });

      setupDb.close();

      // In adoptTargetGeneration, allJobs(db) decodes ALL rows before filtering by target.
      // Since target-B row is malformed, allJobs throws StoreIntegrityError and aborts transaction.
      await assert.rejects(
        adoptTargetGeneration(dbPath, "target-A", 99n),
        StoreIntegrityError,
      );

      // Verify on a separate fresh connection that target-A's update was ROLLED BACK
      const verifyDb = trackDb(await openInitialized(dbPath));
      const targetJob = selectJob(verifyDb, "job-target-valid");
      assert.strictEqual(
        targetJob.appServerGeneration,
        10n,
        "target-A job must not be committed when unrelated row decode fails",
      );
      verifyDb.close();
    });

    it("throws StoreIntegrityError and rolls back global adoption when a matching row has malformed baseline_turn_ids", async () => {
      const dbPath = await createTestDb();
      const setupDb = trackDb(await openInitialized(dbPath));

      insertJob(setupDb, {
        job_id: "job-valid-1",
        target_thread_id: "t1",
        state: "pending",
        app_server_generation: 10n,
        baseline_turn_ids: "[]",
      });
      insertJob(setupDb, {
        job_id: "job-malformed",
        target_thread_id: "t2",
        state: "pending",
        app_server_generation: 10n,
        baseline_turn_ids: "{",
      });
      setupDb.close();

      await assert.rejects(adoptGeneration(dbPath, 99n), StoreIntegrityError);

      const verifyDb = trackDb(await openInitialized(dbPath));
      const validJob = selectJob(verifyDb, "job-valid-1");
      assert.strictEqual(validJob.appServerGeneration, 10n);
      verifyDb.close();
    });

    it("throws InvalidQueueStateError and rolls back when a row has an illegal state string", async () => {
      const dbPath = await createTestDb();
      const setupDb = trackDb(await openInitialized(dbPath));

      insertJob(setupDb, {
        job_id: "job-target-ok",
        target_thread_id: "t-legal",
        state: "pending",
        app_server_generation: 10n,
      });
      insertJob(setupDb, {
        job_id: "job-corrupt-state",
        target_thread_id: "t-corrupt",
        state: "invalid_state_xyz",
        app_server_generation: 10n,
      });
      setupDb.close();

      await assert.rejects(
        adoptTargetGeneration(dbPath, "t-legal", 99n),
        InvalidQueueStateError,
      );

      const verifyDb = trackDb(await openInitialized(dbPath));
      assert.strictEqual(selectJob(verifyDb, "job-target-ok").appServerGeneration, 10n);
      verifyDb.close();
    });
  });

  describe("Suite 10: SQLite native trigger interactions", () => {
    it("rolls back changes when an UPDATE BEFORE trigger aborts", async () => {
      const dbPath = await createTestDb();
      const setupDb = trackDb(await openInitialized(dbPath));

      insertJob(setupDb, {
        job_id: "job-trigger-abort",
        target_thread_id: "t-abort",
        state: "pending",
        app_server_generation: 10n,
      });

      setupDb.exec(`
        CREATE TRIGGER trg_test_abort BEFORE UPDATE ON codex_turn_queue
        BEGIN
          SELECT RAISE(ABORT, 'custom trigger abort message');
        END;
      `);
      setupDb.close();

      await assert.rejects(
        adoptGeneration(dbPath, 99n),
        /custom trigger abort message/,
      );

      const verifyDb = trackDb(await openInitialized(dbPath));
      assert.strictEqual(
        selectJob(verifyDb, "job-trigger-abort").appServerGeneration,
        10n,
      );
      verifyDb.close();
    });

    it("reports adoptedCount 0n and unchanged jobs when a trigger raises IGNORE", async () => {
      const dbPath = await createTestDb();
      const setupDb = trackDb(await openInitialized(dbPath));

      insertJob(setupDb, {
        job_id: "job-trigger-ignore",
        target_thread_id: "t-ignore",
        state: "pending",
        app_server_generation: 10n,
      });

      setupDb.exec(`
        CREATE TRIGGER trg_test_ignore BEFORE UPDATE ON codex_turn_queue
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);
      setupDb.close();

      const res = await adoptGeneration(dbPath, 99n);
      assert.strictEqual(res.adoptedCount, 0n);
      assert.strictEqual(res.jobs.length, 1);
      const row = res.jobs[0];
      assert.ok(row);
      assert.strictEqual(row.appServerGeneration, 10n);

      const verifyDb = trackDb(await openInitialized(dbPath));
      assert.strictEqual(
        selectJob(verifyDb, "job-trigger-ignore").appServerGeneration,
        10n,
      );
      verifyDb.close();
    });

    it("does not inflate adoptedCount when a trigger executes auxiliary inserts/updates", async () => {
      const dbPath = await createTestDb();
      const setupDb = trackDb(await openInitialized(dbPath));

      insertJob(setupDb, {
        job_id: "job-audit-1",
        target_thread_id: "t-audit",
        state: "pending",
        app_server_generation: 10n,
        created_at: 100.0,
      });
      insertJob(setupDb, {
        job_id: "job-audit-2",
        target_thread_id: "t-audit",
        state: "pending",
        app_server_generation: 10n,
        created_at: 200.0,
      });

      setupDb.exec(`
        CREATE TABLE auxiliary_audit_log (
          log_id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL
        );
        CREATE TRIGGER trg_audit AFTER UPDATE ON codex_turn_queue
        BEGIN
          INSERT INTO auxiliary_audit_log (job_id) VALUES (NEW.job_id);
          INSERT INTO auxiliary_audit_log (job_id) VALUES (NEW.job_id || '-dup');
        END;
      `);
      setupDb.close();

      const res = await adoptGeneration(dbPath, 99n);
      // Exactly 2 codex_turn_queue rows were adopted, not inflated by the 4 trigger inserts
      assert.strictEqual(res.adoptedCount, 2n);

      const verifyDb = trackDb(await openInitialized(dbPath));
      const stmt = verifyDb.prepare("SELECT COUNT(*) AS count FROM auxiliary_audit_log");
      const auditCount = (stmt.get() as { count: number | bigint }).count;
      assert.strictEqual(Number(auditCount), 4);
      verifyDb.close();
    });
  });

  describe("Suite 11: Commit durability via separate connection", () => {
    it("ensures adopted changes are durably persisted and rereadable on a newly opened connection", async () => {
      const dbPath = await createTestDb();
      const setupDb = trackDb(await openInitialized(dbPath));
      insertJob(setupDb, {
        job_id: "job-durable-1",
        target_thread_id: "t-durable",
        state: "pending",
        app_server_generation: 1n,
      });
      setupDb.close();

      const res = await adoptGeneration(dbPath, 555n);
      assert.strictEqual(res.adoptedCount, 1n);

      const rereadDb = trackDb(await openInitialized(dbPath));
      const stored = selectJob(rereadDb, "job-durable-1");
      assert.strictEqual(stored.appServerGeneration, 555n);
      rereadDb.close();
    });
  });

  describe("Suite 12: BEGIN IMMEDIATE transaction ownership", () => {
    it("verifies BEGIN IMMEDIATE ownership by failing with database locked when another connection holds an IMMEDIATE transaction", async () => {
      const dbPath = await createTestDb();
      const lockDb = trackDb(await openInitialized(dbPath));

      insertJob(lockDb, {
        job_id: "job-lock-1",
        target_thread_id: "t-lock",
        state: "pending",
        app_server_generation: 1n,
      });

      // Acquire write lock via BEGIN IMMEDIATE
      lockDb.exec("BEGIN IMMEDIATE;");

      // adoptGeneration attempts BEGIN IMMEDIATE and must fail because the file lock is held
      await assert.rejects(
        adoptGeneration(dbPath, 99n),
        /busy|locked/i,
      );

      lockDb.exec("ROLLBACK;");
      lockDb.close();

      // After lock release, adoption succeeds
      const res = await adoptGeneration(dbPath, 99n);
      assert.strictEqual(res.adoptedCount, 1n);
      const row = res.jobs[0];
      assert.ok(row);
      assert.strictEqual(row.appServerGeneration, 99n);
    });
  });
});
