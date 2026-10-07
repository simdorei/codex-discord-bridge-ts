import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { I64_MAX, I64_MIN } from "../../src/protocol/ids.ts";
import { holdIn, EXECUTION_HOLD_PREFIX } from "../../src/store/execution-hold.ts";
import { openInitialized } from "../../src/store/owned-driver.ts";
import { beginAttempt } from "../../src/store/queue-begin-attempt.ts";
import { QueueJobNotFoundError, selectJob } from "../../src/store/queue-read.ts";
import {
  assertStoreIntegrity,
  LATEST_STORE_SCHEMA_VERSION,
  schemaVersion,
  StoreIntegrityError,
} from "../../src/store/schema-assembly.ts";

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

function serializeIdentity(overrides: Record<string, unknown> = {}): string {
  const full = {
    ingress_id: "ing-default",
    job_id: "job-default-1",
    thread_id: "thread-default-1",
    cwd: "/workspace/project",
    state_db: "/workspace/project/state.sqlite",
    channel_id: 1000n,
    origin_channel_id: 2000n,
    event_id: 3000n as bigint | null,
    kind: "message" as const,
    creation_generation: 1n,
    prompt_sha256: "sha256-abc123def456",
    acknowledgement: "ack-token-xyz",
    ...overrides,
  };
  const eventPart = full.event_id === null ? "null" : full.event_id.toString();
  return `{"ingress_id":${JSON.stringify(full.ingress_id)},"job_id":${JSON.stringify(full.job_id)},"thread_id":${JSON.stringify(full.thread_id)},"cwd":${JSON.stringify(full.cwd)},"state_db":${JSON.stringify(full.state_db)},"channel_id":${full.channel_id.toString()},"origin_channel_id":${full.origin_channel_id.toString()},"event_id":${eventPart},"kind":${JSON.stringify(full.kind)},"creation_generation":${full.creation_generation.toString()},"prompt_sha256":${JSON.stringify(full.prompt_sha256)},"acknowledgement":${JSON.stringify(full.acknowledgement)}}`;
}

function insertNewReply(
  db: DatabaseSync,
  jobId: string,
  ingressId: string,
  identityJson: string,
  turnId: string | null = null,
  version: bigint = 1n,
): void {
  const stmt = db.prepare(`
    INSERT INTO codex_new_first_replies (
      job_id, ingress_id, identity_json, turn_id, accepted_at,
      state, version, scan_json, last_error, confirmation_delivered,
      warning_due, checked_at, ack_recovery_allowed
    ) VALUES (?, ?, ?, ?, NULL, 'pending', ?, '{}', '', 0, 0, 0, 0)
  `);
  stmt.run(jobId, ingressId, identityJson, turnId, version);
}

function snapshotTable(db: DatabaseSync, tableName: string): Array<Record<string, unknown>> {
  const stmt = db.prepare(`SELECT * FROM ${tableName}`);
  stmt.setReadBigInts(true);
  return stmt.all() as Array<Record<string, unknown>>;
}

interface TestEnv {
  tempDir: string;
  dbPath: string;
  cleanup: () => void;
}

function createTestEnv(): TestEnv {
  const tempDir = mkdtempSync(join(tmpdir(), "queue-begin-attempt-"));
  const dbPath = join(tempDir, "test.sqlite");
  return {
    tempDir,
    dbPath,
    cleanup: () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error on Windows teardown
      }
    },
  };
}

describe("beginAttempt input validation and domain boundary guards", () => {
  it("rejects non-string and malformed Unicode database path without creating file", async () => {
    const env = createTestEnv();
    const nonExistentPath = join(env.tempDir, "non-existent.sqlite");
    try {
      await assert.rejects(
        async () => beginAttempt(123 as unknown as string, "job-1", [], 1n),
        {
          name: "TypeError",
          message: "Invalid database path: 123",
        },
      );
      await assert.rejects(
        async () => beginAttempt("bad-\uD800-path", "job-1", [], 1n),
        {
          name: "TypeError",
          message: "Invalid database path: bad-\uD800-path",
        },
      );
      assert.equal(existsSync(nonExistentPath), false);
    } finally {
      env.cleanup();
    }
  });

  it("rejects non-string and malformed Unicode jobId without creating file", async () => {
    const env = createTestEnv();
    const nonExistentPath = join(env.tempDir, "non-existent-job.sqlite");
    try {
      await assert.rejects(
        async () => beginAttempt(nonExistentPath, null as unknown as string, [], 1n),
        {
          name: "TypeError",
          message: "Invalid job id: null",
        },
      );
      await assert.rejects(
        async () => beginAttempt(nonExistentPath, "job-\uD800-bad", [], 1n),
        {
          name: "TypeError",
          message: "Invalid job id: job-\uD800-bad",
        },
      );
      assert.equal(existsSync(nonExistentPath), false);
    } finally {
      env.cleanup();
    }
  });

  it("rejects non-array baselineTurnIds without creating file", async () => {
    const env = createTestEnv();
    const nonExistentPath = join(env.tempDir, "non-existent-baseline.sqlite");
    try {
      await assert.rejects(
        async () => beginAttempt(nonExistentPath, "job-1", "not-array" as unknown as readonly string[], 1n),
        {
          name: "TypeError",
          message: "baselineTurnIds must be an array",
        },
      );
      await assert.rejects(
        async () => beginAttempt(nonExistentPath, "job-1", null as unknown as readonly string[], 1n),
        {
          name: "TypeError",
          message: "baselineTurnIds must be an array",
        },
      );
      assert.equal(existsSync(nonExistentPath), false);
    } finally {
      env.cleanup();
    }
  });

  it("rejects non-string or malformed Unicode baselineTurnIds elements without creating file", async () => {
    const env = createTestEnv();
    const nonExistentPath = join(env.tempDir, "non-existent-items.sqlite");
    try {
      await assert.rejects(
        async () => beginAttempt(nonExistentPath, "job-1", ["valid-1", 42 as unknown as string], 1n),
        {
          name: "TypeError",
          message: "baselineTurnIds element 1 must be a well-formed string",
        },
      );
      await assert.rejects(
        async () => beginAttempt(nonExistentPath, "job-1", ["turn-\uD800-bad"], 1n),
        {
          name: "TypeError",
          message: "baselineTurnIds element 0 must be a well-formed string",
        },
      );
      assert.equal(existsSync(nonExistentPath), false);
    } finally {
      env.cleanup();
    }
  });

  it("rejects non-bigint generation without creating file", async () => {
    const env = createTestEnv();
    const nonExistentPath = join(env.tempDir, "non-existent-gen.sqlite");
    try {
      await assert.rejects(
        async () => beginAttempt(nonExistentPath, "job-1", [], 123 as unknown as bigint),
        {
          name: "TypeError",
          message: "generation must be a bigint",
        },
      );
      await assert.rejects(
        async () => beginAttempt(nonExistentPath, "job-1", [], "1" as unknown as bigint),
        {
          name: "TypeError",
          message: "generation must be a bigint",
        },
      );
      assert.equal(existsSync(nonExistentPath), false);
    } finally {
      env.cleanup();
    }
  });

  it("rejects generation out of signed i64 range without creating file", async () => {
    const env = createTestEnv();
    const nonExistentPath = join(env.tempDir, "non-existent-i64.sqlite");
    try {
      await assert.rejects(
        async () => beginAttempt(nonExistentPath, "job-1", [], I64_MAX + 1n),
        {
          name: "RangeError",
          message: `generation out of signed i64 range: ${(I64_MAX + 1n).toString()}`,
        },
      );
      await assert.rejects(
        async () => beginAttempt(nonExistentPath, "job-1", [], I64_MIN - 1n),
        {
          name: "RangeError",
          message: `generation out of signed i64 range: ${(I64_MIN - 1n).toString()}`,
        },
      );
      assert.equal(existsSync(nonExistentPath), false);
    } finally {
      env.cleanup();
    }
  });
});

describe("beginAttempt baseline serialization and pre-await mutation isolation", () => {
  it("preserves NUL, BOM, supplementary Unicode, duplicates, and exact ordering in baseline turn ids", async () => {
    const env = createTestEnv();
    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-unicode-1",
          app_server_generation: 1n,
        });
      } finally {
        setupDb.close();
      }

      const complexBaseline: readonly string[] = [
        "turn-\0-nul",
        "\uFEFFturn-bom",
        "turn-🚀-supp",
        "turn-𠮷-cjk",
        "turn-duplicate",
        "turn-duplicate",
        "order-z",
        "order-a",
      ];

      const job = await beginAttempt(env.dbPath, "job-unicode-1", complexBaseline, 1n);
      const parsedBaseline = Array.isArray(job.baselineTurnIds)
        ? job.baselineTurnIds
        : JSON.parse(job.baselineTurnIds as unknown as string);
      assert.deepEqual(parsedBaseline, complexBaseline);

      const verifyDb = new DatabaseSync(env.dbPath);
      try {
        const row = verifyDb.prepare("SELECT baseline_turn_ids FROM codex_turn_queue WHERE job_id = ?").get("job-unicode-1") as { baseline_turn_ids: string };
        assert.equal(row.baseline_turn_ids, JSON.stringify(complexBaseline));
      } finally {
        verifyDb.close();
      }
    } finally {
      env.cleanup();
    }
  });

  it("snapshots and serializes baseline before await openInitialized, ignoring synchronous array mutation right after call", async () => {
    const env = createTestEnv();
    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-mutation-1",
          app_server_generation: 1n,
        });
      } finally {
        setupDb.close();
      }

      const mutableBaseline: string[] = ["turn-original-alpha", "turn-original-beta"];
      const promise = beginAttempt(env.dbPath, "job-mutation-1", mutableBaseline, 1n);
      // Synchronous mutation right after invocation before promise resolves
      mutableBaseline.push("turn-mutated-gamma");
      mutableBaseline[0] = "turn-corrupted-alpha";

      const job = await promise;
      const parsedBaseline = Array.isArray(job.baselineTurnIds)
        ? job.baselineTurnIds
        : JSON.parse(job.baselineTurnIds as unknown as string);
      assert.deepEqual(parsedBaseline, ["turn-original-alpha", "turn-original-beta"]);

      const verifyDb = new DatabaseSync(env.dbPath);
      try {
        const row = verifyDb.prepare("SELECT baseline_turn_ids FROM codex_turn_queue WHERE job_id = ?").get("job-mutation-1") as { baseline_turn_ids: string };
        assert.equal(row.baseline_turn_ids, JSON.stringify(["turn-original-alpha", "turn-original-beta"]));
      } finally {
        verifyDb.close();
      }
    } finally {
      env.cleanup();
    }
  });
});

describe("beginAttempt precedence rules across hold, dead generation, clock, and missing row", () => {
  it("execution hold precedes missing row check and clock (clock counter 0)", async () => {
    const env = createTestEnv();
    let clockCalls = 0;
    const originalNow = Date.now;
    Date.now = () => {
      clockCalls++;
      return 123456;
    };

    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        // Job does NOT exist in codex_turn_queue, but execution hold exists
        holdIn(setupDb, "job-held-missing", "thread-held", "pre-execution manual hold", "{}");
      } finally {
        setupDb.close();
      }

      await assert.rejects(
        async () => beginAttempt(env.dbPath, "job-held-missing", [], 1n),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError || (err as { name?: string }).name === "StoreIntegrityError");
          assert.ok((err as Error).message.includes(EXECUTION_HOLD_PREFIX));
          assert.ok((err as Error).message.includes("pre-execution manual hold"));
          return true;
        },
      );
      assert.equal(clockCalls, 0);
    } finally {
      Date.now = originalNow;
      env.cleanup();
    }
  });

  it("missing row check on unheld job precedes clock (clock counter 0)", async () => {
    const env = createTestEnv();
    let clockCalls = 0;
    const originalNow = Date.now;
    Date.now = () => {
      clockCalls++;
      return 123456;
    };

    try {
      const setupDb = await openInitialized(env.dbPath);
      setupDb.close();

      await assert.rejects(
        async () => beginAttempt(env.dbPath, "job-absent-1", [], 1n),
        (err: unknown) => {
          assert.ok(err instanceof QueueJobNotFoundError || (err as { name?: string }).name === "QueueJobNotFoundError");
          return true;
        },
      );
      assert.equal(clockCalls, 0);
    } finally {
      Date.now = originalNow;
      env.cleanup();
    }
  });

  it("dead generation target hold precedes clock (clock counter 0)", async () => {
    const env = createTestEnv();
    let clockCalls = 0;
    const originalNow = Date.now;
    Date.now = () => {
      clockCalls++;
      return 123456;
    };

    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-target-held",
          target_thread_id: "thread-dead-held",
          app_server_generation: 7n,
        });
        setupDb.prepare(`
          INSERT INTO codex_dead_generation_holds (target_thread_id, runtime_id, generation, created_at)
          VALUES (?, ?, ?, ?)
        `).run("thread-dead-held", "rt-test-1", 7n, 100.0);
      } finally {
        setupDb.close();
      }

      await assert.rejects(
        async () => beginAttempt(env.dbPath, "job-target-held", [], 7n),
        (err: unknown) => {
          assert.equal((err as { name?: string }).name, "DeadGenerationTargetHeldError");
          assert.equal((err as { kind?: string }).kind, "DeadGenerationTargetHeld");
          assert.ok((err as Error).message.includes("thread-dead-held"));
          return true;
        },
      );
      assert.equal(clockCalls, 0);
    } finally {
      Date.now = originalNow;
      env.cleanup();
    }
  });

  it("sealed generation incident on original generation precedes clock (clock counter 0)", async () => {
    const env = createTestEnv();
    let clockCalls = 0;
    const originalNow = Date.now;
    Date.now = () => {
      clockCalls++;
      return 123456;
    };

    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-sealed-orig",
          target_thread_id: "thread-sealed-1",
          app_server_generation: 7n,
        });
        setupDb.prepare(`
          INSERT INTO codex_app_server_runtime (singleton, runtime_id) VALUES (1, 'rt-singleton-1')
        `).run();
        setupDb.prepare(`
          INSERT INTO codex_dead_generation_incidents (runtime_id, generation, snapshot_json, queue_jobs_json, created_at)
          VALUES ('rt-singleton-1', 7, '{}', '[]', 100.0)
        `).run();
      } finally {
        setupDb.close();
      }

      await assert.rejects(
        async () => beginAttempt(env.dbPath, "job-sealed-orig", [], 7n),
        (err: unknown) => {
          assert.equal((err as { name?: string }).name, "DeadGenerationTargetHeldError");
          assert.equal((err as { kind?: string }).kind, "DeadGenerationTargetHeld");
          return true;
        },
      );
      assert.equal(clockCalls, 0);
    } finally {
      Date.now = originalNow;
      env.cleanup();
    }
  });

  it("wrong requested generation passes dead generation check on original 7n, samples clock once before UPDATE, then throws QueueJobNotFoundError", async () => {
    const env = createTestEnv();
    let clockCalls = 0;
    const originalNow = Date.now;
    Date.now = () => {
      clockCalls++;
      return 123456;
    };

    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-gen-mismatch",
          app_server_generation: 7n,
        });
      } finally {
        setupDb.close();
      }

      await assert.rejects(
        async () => beginAttempt(env.dbPath, "job-gen-mismatch", [], 8n),
        (err: unknown) => {
          assert.ok(err instanceof QueueJobNotFoundError || (err as { name?: string }).name === "QueueJobNotFoundError");
          return true;
        },
      );
      assert.equal(clockCalls, 1);
    } finally {
      Date.now = originalNow;
      env.cleanup();
    }
  });

  it("original generation 7 with request generation 8: sealing gen 7 throws DeadGenerationTargetHeldError", async () => {
    const env = createTestEnv();
    let clockCalls = 0;
    const originalNow = Date.now;
    Date.now = () => {
      clockCalls++;
      return 123456;
    };

    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-gen7-req8",
          target_thread_id: "thread-7-8",
          app_server_generation: 7n,
        });
        setupDb.prepare(`
          INSERT INTO codex_app_server_runtime (singleton, runtime_id) VALUES (1, 'rt-singleton-1')
        `).run();
        setupDb.prepare(`
          INSERT INTO codex_dead_generation_incidents (runtime_id, generation, snapshot_json, queue_jobs_json, created_at)
          VALUES ('rt-singleton-1', 7, '{}', '[]', 100.0)
        `).run();
      } finally {
        setupDb.close();
      }

      await assert.rejects(
        async () => beginAttempt(env.dbPath, "job-gen7-req8", [], 8n),
        (err: unknown) => {
          assert.equal((err as { name?: string }).name, "DeadGenerationTargetHeldError");
          return true;
        },
      );
      assert.equal(clockCalls, 0);
    } finally {
      Date.now = originalNow;
      env.cleanup();
    }
  });

  it("original generation 7 with request generation 8: sealing gen 8 alone passes check on gen 7, samples clock, and throws QueueJobNotFoundError on UPDATE", async () => {
    const env = createTestEnv();
    let clockCalls = 0;
    const originalNow = Date.now;
    Date.now = () => {
      clockCalls++;
      return 123456;
    };

    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-gen7-req8-seal8",
          target_thread_id: "thread-7-8-s8",
          app_server_generation: 7n,
        });
        setupDb.prepare(`
          INSERT INTO codex_app_server_runtime (singleton, runtime_id) VALUES (1, 'rt-singleton-1')
        `).run();
        setupDb.prepare(`
          INSERT INTO codex_dead_generation_incidents (runtime_id, generation, snapshot_json, queue_jobs_json, created_at)
          VALUES ('rt-singleton-1', 8, '{}', '[]', 100.0)
        `).run();
      } finally {
        setupDb.close();
      }

      await assert.rejects(
        async () => beginAttempt(env.dbPath, "job-gen7-req8-seal8", [], 8n),
        (err: unknown) => {
          assert.ok(err instanceof QueueJobNotFoundError || (err as { name?: string }).name === "QueueJobNotFoundError");
          return true;
        },
      );
      assert.equal(clockCalls, 1);
    } finally {
      Date.now = originalNow;
      env.cleanup();
    }
  });
});

describe("beginAttempt fresh file initialization on missing row failure", () => {
  it("initializes full schema version and tables on non-existent database file before missing row error", async () => {
    const env = createTestEnv();
    const freshDbPath = join(env.tempDir, "fresh-target.sqlite");
    assert.equal(existsSync(freshDbPath), false);

    try {
      await assert.rejects(
        async () => beginAttempt(freshDbPath, "missing-row-fresh", [], 1n),
        (err: unknown) => {
          assert.ok(err instanceof QueueJobNotFoundError || (err as { name?: string }).name === "QueueJobNotFoundError");
          return true;
        },
      );

      assert.equal(existsSync(freshDbPath), true);
      const verifyDb = new DatabaseSync(freshDbPath);
      try {
        assert.equal(schemaVersion(verifyDb), LATEST_STORE_SCHEMA_VERSION);
        assertStoreIntegrity(verifyDb);

        const queueRows = verifyDb.prepare("SELECT count(*) as cnt FROM codex_turn_queue").get() as { cnt: bigint | number };
        assert.equal(Number(queueRows.cnt), 0);
      } finally {
        verifyDb.close();
      }
    } finally {
      env.cleanup();
    }
  });
});

describe("beginAttempt clock single sample semantic contracts and error boundaries", () => {
  it("clock single sample: counter first 123456 then -1 asserts clock count before updatedAt", async () => {
    const env = createTestEnv();
    let clockCalls = 0;
    const originalNow = Date.now;
    Date.now = () => {
      clockCalls++;
      if (clockCalls === 1) {
        return 123456;
      }
      return -1;
    };

    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-clock-neg",
          app_server_generation: 1n,
          updated_at: 0.0,
        });
      } finally {
        setupDb.close();
      }

      const job = await beginAttempt(env.dbPath, "job-clock-neg", [], 1n);
      // Assert counter before timestamp so old double-count failure is preserved under test
      assert.equal(clockCalls, 1);
      assert.equal(job.updatedAt, 123.456);
    } finally {
      Date.now = originalNow;
      env.cleanup();
    }
  });

  it("clock single sample: counter first 123456 then NaN asserts clock count before updatedAt", async () => {
    const env = createTestEnv();
    let clockCalls = 0;
    const originalNow = Date.now;
    Date.now = () => {
      clockCalls++;
      if (clockCalls === 1) {
        return 123456;
      }
      return NaN;
    };

    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-clock-nan",
          app_server_generation: 1n,
          updated_at: 0.0,
        });
      } finally {
        setupDb.close();
      }

      const job = await beginAttempt(env.dbPath, "job-clock-nan", [], 1n);
      assert.equal(clockCalls, 1);
      assert.equal(job.updatedAt, 123.456);
    } finally {
      Date.now = originalNow;
      env.cleanup();
    }
  });

  it("clock single sample: counter first 123456 then Infinity asserts clock count before updatedAt", async () => {
    const env = createTestEnv();
    let clockCalls = 0;
    const originalNow = Date.now;
    Date.now = () => {
      clockCalls++;
      if (clockCalls === 1) {
        return 123456;
      }
      return Infinity;
    };

    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-clock-inf",
          app_server_generation: 1n,
          updated_at: 0.0,
        });
      } finally {
        setupDb.close();
      }

      const job = await beginAttempt(env.dbPath, "job-clock-inf", [], 1n);
      assert.equal(clockCalls, 1);
      assert.equal(job.updatedAt, 123.456);
    } finally {
      Date.now = originalNow;
      env.cleanup();
    }
  });

  it("clock single sample: counter first 123456 then -Infinity asserts clock count before updatedAt", async () => {
    const env = createTestEnv();
    let clockCalls = 0;
    const originalNow = Date.now;
    Date.now = () => {
      clockCalls++;
      if (clockCalls === 1) {
        return 123456;
      }
      return -Infinity;
    };

    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-clock-neginf",
          app_server_generation: 1n,
          updated_at: 0.0,
        });
      } finally {
        setupDb.close();
      }

      const job = await beginAttempt(env.dbPath, "job-clock-neginf", [], 1n);
      assert.equal(clockCalls, 1);
      assert.equal(job.updatedAt, 123.456);
    } finally {
      Date.now = originalNow;
      env.cleanup();
    }
  });

  it("first negative clock rejects with SystemTimeError before SQL mutation", async () => {
    const env = createTestEnv();
    let clockCalls = 0;
    const originalNow = Date.now;
    Date.now = () => {
      clockCalls++;
      return -1;
    };

    let snapshotBefore: Array<Record<string, unknown>>;
    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-first-neg",
          app_server_generation: 1n,
          updated_at: 999.0,
          state: "pending",
        });
        snapshotBefore = snapshotTable(setupDb, "codex_turn_queue");
      } finally {
        setupDb.close();
      }

      await assert.rejects(
        async () => beginAttempt(env.dbPath, "job-first-neg", [], 1n),
        (err: unknown) => {
          assert.equal((err as { name?: string }).name, "SystemTimeError");
          assert.equal((err as { kind?: string }).kind, "SystemTime");
          assert.ok((err as Error).message.includes("system clock is before the Unix epoch"));
          return true;
        },
      );
      assert.equal(clockCalls, 1);

      const verifyDb = new DatabaseSync(env.dbPath);
      try {
        const snapshotAfter = snapshotTable(verifyDb, "codex_turn_queue");
        assert.deepEqual(snapshotAfter, snapshotBefore);
      } finally {
        verifyDb.close();
      }
    } finally {
      Date.now = originalNow;
      env.cleanup();
    }
  });

  it("first NaN clock rejects with TypeError('system clock must be finite') before SQL mutation", async () => {
    const env = createTestEnv();
    let clockCalls = 0;
    const originalNow = Date.now;
    Date.now = () => {
      clockCalls++;
      return NaN;
    };

    let snapshotBefore: Array<Record<string, unknown>>;
    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-first-nan",
          app_server_generation: 1n,
          updated_at: 888.0,
        });
        snapshotBefore = snapshotTable(setupDb, "codex_turn_queue");
      } finally {
        setupDb.close();
      }

      await assert.rejects(
        async () => beginAttempt(env.dbPath, "job-first-nan", [], 1n),
        {
          name: "TypeError",
          message: "system clock must be finite",
        },
      );
      assert.equal(clockCalls, 1);

      const verifyDb = new DatabaseSync(env.dbPath);
      try {
        const snapshotAfter = snapshotTable(verifyDb, "codex_turn_queue");
        assert.deepEqual(snapshotAfter, snapshotBefore);
      } finally {
        verifyDb.close();
      }
    } finally {
      Date.now = originalNow;
      env.cleanup();
    }
  });

  it("first +Infinity clock rejects with TypeError('system clock must be finite') before SQL mutation", async () => {
    const env = createTestEnv();
    let clockCalls = 0;
    const originalNow = Date.now;
    Date.now = () => {
      clockCalls++;
      return Infinity;
    };

    let snapshotBefore: Array<Record<string, unknown>>;
    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-first-posinf",
          app_server_generation: 1n,
          updated_at: 777.0,
        });
        snapshotBefore = snapshotTable(setupDb, "codex_turn_queue");
      } finally {
        setupDb.close();
      }

      await assert.rejects(
        async () => beginAttempt(env.dbPath, "job-first-posinf", [], 1n),
        {
          name: "TypeError",
          message: "system clock must be finite",
        },
      );
      assert.equal(clockCalls, 1);

      const verifyDb = new DatabaseSync(env.dbPath);
      try {
        const snapshotAfter = snapshotTable(verifyDb, "codex_turn_queue");
        assert.deepEqual(snapshotAfter, snapshotBefore);
      } finally {
        verifyDb.close();
      }
    } finally {
      Date.now = originalNow;
      env.cleanup();
    }
  });

  it("first -Infinity clock rejects with TypeError('system clock must be finite') before SQL mutation", async () => {
    const env = createTestEnv();
    let clockCalls = 0;
    const originalNow = Date.now;
    Date.now = () => {
      clockCalls++;
      return -Infinity;
    };

    let snapshotBefore: Array<Record<string, unknown>>;
    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-first-neginf",
          app_server_generation: 1n,
          updated_at: 666.0,
        });
        snapshotBefore = snapshotTable(setupDb, "codex_turn_queue");
      } finally {
        setupDb.close();
      }

      await assert.rejects(
        async () => beginAttempt(env.dbPath, "job-first-neginf", [], 1n),
        {
          name: "TypeError",
          message: "system clock must be finite",
        },
      );
      assert.equal(clockCalls, 1);

      const verifyDb = new DatabaseSync(env.dbPath);
      try {
        const snapshotAfter = snapshotTable(verifyDb, "codex_turn_queue");
        assert.deepEqual(snapshotAfter, snapshotBefore);
      } finally {
        verifyDb.close();
      }
    } finally {
      Date.now = originalNow;
      env.cleanup();
    }
  });

  it("preserves exact millisecond-to-seconds conversion fidelity gap without Rust nanosecond precision claim", async () => {
    const env = createTestEnv();
    const originalNow = Date.now;
    // Exact millisecond representation: 1712000000123 ms -> 1712000000.123 s
    Date.now = () => 1712000000123;

    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-ms-fidelity",
          app_server_generation: 1n,
        });
      } finally {
        setupDb.close();
      }

      const job = await beginAttempt(env.dbPath, "job-ms-fidelity", [], 1n);
      assert.equal(job.updatedAt, 1712000000.123);
    } finally {
      Date.now = originalNow;
      env.cleanup();
    }
  });
});

describe("beginAttempt exact SQL UPDATE mutations, state transitions, and saturations", () => {
  it("executes exact UPDATE: state starting, execution=app_server_generation, clears observations/goals/turn/error, increments attempt, preserves other columns", async () => {
    const env = createTestEnv();
    const originalNow = Date.now;
    Date.now = () => 1712345678900;

    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-full-mutation",
          target_thread_id: "thread-exact-1",
          channel_id: 1111n,
          owner_user_id: 2222n,
          discord_message_id: 3333n,
          app_server_generation: 4n,
          execution_generation: 2n,
          prompt: "custom test prompt",
          queued: 1n,
          ack_sent: 1n,
          state: "running",
          attempt_count: 5n,
          turn_id: "turn-prior-uuid",
          baseline_turn_ids: JSON.stringify(["old-baseline"]),
          last_error: "prior failure reason",
          created_at: 1712000000.25,
          updated_at: 1712000001.25,
          goal_waiting: 1n,
          turn_observation_generation: 3n,
        });
      } finally {
        setupDb.close();
      }

      const newBaselines = ["new-turn-alpha", "new-turn-beta"];
      const job = await beginAttempt(env.dbPath, "job-full-mutation", newBaselines, 4n);

      assert.equal(job.jobId, "job-full-mutation");
      assert.equal(job.targetThreadId, "thread-exact-1");
      assert.equal(job.channelId, 1111n);
      assert.equal(job.ownerUserId, 2222n);
      assert.equal(job.discordMessageId, 3333n);
      assert.equal(job.appServerGeneration, 4n);
      assert.equal(job.prompt, "custom test prompt");
      assert.equal(job.queued, true);
      assert.equal(job.ackSent, true);
      assert.equal(job.createdAt, 1712000000.25);

      // Mutated fields
      assert.equal(job.state.toLowerCase(), "starting");
      assert.equal(job.executionGeneration, 4n); // current app_server_generation
      assert.equal(job.turnObservationGeneration, null);
      assert.equal(job.goalWaiting, false);
      assert.equal(job.attemptCount, 6n); // 5n + 1n
      assert.equal(job.turnId, null);
      assert.equal(job.lastError, "");
      assert.equal(job.updatedAt, 1712345678.9);

      const parsedBaseline = Array.isArray(job.baselineTurnIds)
        ? job.baselineTurnIds
        : JSON.parse(job.baselineTurnIds as unknown as string);
      assert.deepEqual(parsedBaseline, newBaselines);
    } finally {
      Date.now = originalNow;
      env.cleanup();
    }
  });

  it("saturates attempt_count at signed i64 max (9223372036854775807) without overflow", async () => {
    const env = createTestEnv();
    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-saturate-max",
          app_server_generation: 1n,
          attempt_count: I64_MAX,
        });
      } finally {
        setupDb.close();
      }

      const job = await beginAttempt(env.dbPath, "job-saturate-max", [], 1n);
      assert.equal(job.attemptCount, I64_MAX);
    } finally {
      env.cleanup();
    }
  });

  it("allows transition from existing running, starting, or pending states", async () => {
    const env = createTestEnv();
    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-from-pending",
          state: "pending",
          app_server_generation: 1n,
        });
        insertJob(setupDb, {
          job_id: "job-from-running",
          state: "running",
          app_server_generation: 1n,
        });
        insertJob(setupDb, {
          job_id: "job-from-starting",
          state: "starting",
          app_server_generation: 1n,
        });
      } finally {
        setupDb.close();
      }

      const job1 = await beginAttempt(env.dbPath, "job-from-pending", [], 1n);
      assert.equal(job1.state.toLowerCase(), "starting");

      const job2 = await beginAttempt(env.dbPath, "job-from-running", [], 1n);
      assert.equal(job2.state.toLowerCase(), "starting");

      const job3 = await beginAttempt(env.dbPath, "job-from-starting", [], 1n);
      assert.equal(job3.state.toLowerCase(), "starting");
    } finally {
      env.cleanup();
    }
  });
});

describe("beginAttempt AFTER UPDATE triggers, binding, mirror origin, and transactional rollback", () => {
  it("Starting + non-null turn from trigger: bindRunningIn is no-op BUT recordJobOrigin records origin event", async () => {
    const env = createTestEnv();
    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-trg-starting",
          target_thread_id: "thread-trg-starting",
          channel_id: 1000n,
          prompt: "starting prompt trigger test",
          app_server_generation: 1n,
        });
        insertNewReply(
          setupDb,
          "job-trg-starting",
          "ing-starting-1",
          serializeIdentity({
            job_id: "job-trg-starting",
            thread_id: "thread-trg-starting",
            channel_id: 1000n,
          }),
          null,
          1n,
        );

        // AFTER UPDATE trigger sets non-null turn_id while leaving state as starting
        setupDb.exec(`
          CREATE TRIGGER trg_test_set_turn AFTER UPDATE ON codex_turn_queue
          BEGIN
            UPDATE codex_turn_queue SET turn_id = 'injected-starting-turn' WHERE job_id = NEW.job_id;
          END;
        `);
      } finally {
        setupDb.close();
      }

      const job = await beginAttempt(env.dbPath, "job-trg-starting", [], 1n);
      assert.equal(job.turnId, "injected-starting-turn");
      assert.equal(job.state.toLowerCase(), "starting");

      const verifyDb = new DatabaseSync(env.dbPath);
      try {
        // bindRunningIn is a no-op because job.state !== 'Running'
        const replyRow = verifyDb.prepare("SELECT turn_id, version FROM codex_new_first_replies WHERE job_id = ?").get("job-trg-starting") as { turn_id: string | null; version: bigint | number };
        assert.equal(replyRow.turn_id, null);
        assert.equal(Number(replyRow.version), 1);

        // recordJobOrigin succeeds because job.turnId !== null
        const events = verifyDb.prepare("SELECT count(*) as cnt FROM codex_session_mirror_events WHERE codex_thread_id = ?").get("thread-trg-starting") as { cnt: bigint | number };
        assert.equal(Number(events.cnt), 1);
      } finally {
        verifyDb.close();
      }
    } finally {
      env.cleanup();
    }
  });

  it("Running + turn + valid first reply identity from trigger: executes BOTH bindRunningIn AND recordJobOrigin", async () => {
    const env = createTestEnv();
    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-trg-running",
          target_thread_id: "thread-trg-running",
          channel_id: 1000n,
          prompt: "running trigger prompt",
          app_server_generation: 1n,
        });
        insertNewReply(
          setupDb,
          "job-trg-running",
          "ing-running-1",
          serializeIdentity({
            job_id: "job-trg-running",
            thread_id: "thread-trg-running",
            channel_id: 1000n,
          }),
          null,
          1n,
        );

        // AFTER UPDATE trigger simulates transition to running and non-null turn
        setupDb.exec(`
          CREATE TRIGGER trg_test_set_running AFTER UPDATE ON codex_turn_queue
          BEGIN
            UPDATE codex_turn_queue SET state = 'running', turn_id = 'injected-running-turn' WHERE job_id = NEW.job_id;
          END;
        `);
      } finally {
        setupDb.close();
      }

      const job = await beginAttempt(env.dbPath, "job-trg-running", [], 1n);
      assert.equal(job.turnId, "injected-running-turn");
      assert.equal(job.state.toLowerCase(), "running");

      const verifyDb = new DatabaseSync(env.dbPath);
      try {
        const replyRow = verifyDb.prepare("SELECT turn_id, version, accepted_at FROM codex_new_first_replies WHERE job_id = ?").get("job-trg-running") as {
          turn_id: string | null;
          version: bigint | number;
          accepted_at: number | null;
        };
        assert.equal(replyRow.turn_id, "injected-running-turn");
        assert.equal(Number(replyRow.version), 2);
        assert.equal(replyRow.accepted_at, job.updatedAt);

        const events = verifyDb.prepare("SELECT count(*) as cnt FROM codex_session_mirror_events WHERE codex_thread_id = ?").get("thread-trg-running") as { cnt: bigint | number };
        assert.equal(Number(events.cnt), 1);
      } finally {
        verifyDb.close();
      }
    } finally {
      env.cleanup();
    }
  });

  it("mismatched first reply destination in trigger rolls back queue update, binding, and origin records", async () => {
    const env = createTestEnv();
    let queueBefore: Array<Record<string, unknown>>;
    let replyBefore: Array<Record<string, unknown>>;
    let mirrorBefore: Array<Record<string, unknown>>;

    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-mismatch-rollback",
          target_thread_id: "thread-actual",
          channel_id: 1000n,
          prompt: "rollback prompt test",
          app_server_generation: 1n,
          state: "pending",
          attempt_count: 0n,
        });
        // Identity has conflicting thread_id: 'thread-mismatched'
        insertNewReply(
          setupDb,
          "job-mismatch-rollback",
          "ing-mismatch-1",
          serializeIdentity({
            job_id: "job-mismatch-rollback",
            thread_id: "thread-mismatched",
            channel_id: 1000n,
          }),
          null,
          1n,
        );

        setupDb.exec(`
          CREATE TRIGGER trg_test_mismatch AFTER UPDATE ON codex_turn_queue
          BEGIN
            UPDATE codex_turn_queue SET state = 'running', turn_id = 'trigger-mismatch-turn' WHERE job_id = NEW.job_id;
          END;
        `);

        queueBefore = snapshotTable(setupDb, "codex_turn_queue");
        replyBefore = snapshotTable(setupDb, "codex_new_first_replies");
        mirrorBefore = snapshotTable(setupDb, "codex_session_mirror_events");
      } finally {
        setupDb.close();
      }

      await assert.rejects(
        async () => beginAttempt(env.dbPath, "job-mismatch-rollback", [], 1n),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError || (err as { name?: string }).name === "StoreIntegrityError");
          assert.ok((err as Error).message.includes("new first-turn binding changed its destination"));
          return true;
        },
      );

      const verifyDb = new DatabaseSync(env.dbPath);
      try {
        const queueAfter = snapshotTable(verifyDb, "codex_turn_queue");
        const replyAfter = snapshotTable(verifyDb, "codex_new_first_replies");
        const mirrorAfter = snapshotTable(verifyDb, "codex_session_mirror_events");

        assert.deepEqual(queueAfter, queueBefore);
        assert.deepEqual(replyAfter, replyBefore);
        assert.deepEqual(mirrorAfter, mirrorBefore);
      } finally {
        verifyDb.close();
      }
    } finally {
      env.cleanup();
    }
  });

  it("mirror origin insert ABORT rolls back entire queue and reply binding transaction", async () => {
    const env = createTestEnv();
    let queueBefore: Array<Record<string, unknown>>;
    let replyBefore: Array<Record<string, unknown>>;
    let mirrorBefore: Array<Record<string, unknown>>;

    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-origin-abort",
          target_thread_id: "thread-abort-1",
          channel_id: 1000n,
          prompt: "abort trigger prompt",
          app_server_generation: 1n,
        });
        insertNewReply(
          setupDb,
          "job-origin-abort",
          "ing-abort-1",
          serializeIdentity({
            job_id: "job-origin-abort",
            thread_id: "thread-abort-1",
            channel_id: 1000n,
          }),
          null,
          1n,
        );

        setupDb.exec(`
          CREATE TRIGGER trg_test_running_abort AFTER UPDATE ON codex_turn_queue
          BEGIN
            UPDATE codex_turn_queue SET state = 'running', turn_id = 'abort-turn-1' WHERE job_id = NEW.job_id;
          END;
        `);
        setupDb.exec(`
          CREATE TRIGGER trg_abort_origin BEFORE INSERT ON codex_session_mirror_events
          BEGIN
            SELECT RAISE(ABORT, 'forced mirror origin insert abort');
          END;
        `);

        queueBefore = snapshotTable(setupDb, "codex_turn_queue");
        replyBefore = snapshotTable(setupDb, "codex_new_first_replies");
        mirrorBefore = snapshotTable(setupDb, "codex_session_mirror_events");
      } finally {
        setupDb.close();
      }

      await assert.rejects(
        async () => beginAttempt(env.dbPath, "job-origin-abort", [], 1n),
        (err: unknown) => {
          assert.ok((err as Error).message.includes("forced mirror origin insert abort"));
          return true;
        },
      );

      const verifyDb = new DatabaseSync(env.dbPath);
      try {
        const queueAfter = snapshotTable(verifyDb, "codex_turn_queue");
        const replyAfter = snapshotTable(verifyDb, "codex_new_first_replies");
        const mirrorAfter = snapshotTable(verifyDb, "codex_session_mirror_events");

        assert.deepEqual(queueAfter, queueBefore);
        assert.deepEqual(replyAfter, replyBefore);
        assert.deepEqual(mirrorAfter, mirrorBefore);
      } finally {
        verifyDb.close();
      }
    } finally {
      env.cleanup();
    }
  });

  it("trigger RAISE(IGNORE) on update produces changes 0 and throws QueueJobNotFoundError, preserving queue row", async () => {
    const env = createTestEnv();
    let queueBefore: Array<Record<string, unknown>>;

    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-raise-ignore",
          app_server_generation: 1n,
        });
        setupDb.exec(`
          CREATE TRIGGER trg_test_ignore BEFORE UPDATE ON codex_turn_queue
          BEGIN
            SELECT RAISE(IGNORE);
          END;
        `);
        queueBefore = snapshotTable(setupDb, "codex_turn_queue");
      } finally {
        setupDb.close();
      }

      await assert.rejects(
        async () => beginAttempt(env.dbPath, "job-raise-ignore", [], 1n),
        (err: unknown) => {
          assert.ok(err instanceof QueueJobNotFoundError || (err as { name?: string }).name === "QueueJobNotFoundError");
          return true;
        },
      );

      const verifyDb = new DatabaseSync(env.dbPath);
      try {
        const queueAfter = snapshotTable(verifyDb, "codex_turn_queue");
        assert.deepEqual(queueAfter, queueBefore);
      } finally {
        verifyDb.close();
      }
    } finally {
      env.cleanup();
    }
  });

  it("trigger RAISE(ABORT) on update preserves native error and rolls back", async () => {
    const env = createTestEnv();
    let queueBefore: Array<Record<string, unknown>>;

    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-raise-abort",
          app_server_generation: 1n,
        });
        setupDb.exec(`
          CREATE TRIGGER trg_test_native_abort BEFORE UPDATE ON codex_turn_queue
          BEGIN
            SELECT RAISE(ABORT, 'custom native abort before update');
          END;
        `);
        queueBefore = snapshotTable(setupDb, "codex_turn_queue");
      } finally {
        setupDb.close();
      }

      await assert.rejects(
        async () => beginAttempt(env.dbPath, "job-raise-abort", [], 1n),
        (err: unknown) => {
          assert.ok((err as Error).message.includes("custom native abort before update"));
          return true;
        },
      );

      const verifyDb = new DatabaseSync(env.dbPath);
      try {
        const queueAfter = snapshotTable(verifyDb, "codex_turn_queue");
        assert.deepEqual(queueAfter, queueBefore);
      } finally {
        verifyDb.close();
      }
    } finally {
      env.cleanup();
    }
  });

  it("re-selecting invalid BLOB in queue table causes decode error and rolls back entire transaction", async () => {
    const env = createTestEnv();
    let queueBefore: Array<Record<string, unknown>>;

    try {
      const setupDb = await openInitialized(env.dbPath);
      try {
        insertJob(setupDb, {
          job_id: "job-reselect-corrupt",
          prompt: "valid original prompt",
          app_server_generation: 1n,
        });
        // Injects invalid leading byte into prompt column
        setupDb.exec(`
          CREATE TRIGGER trg_test_corrupt AFTER UPDATE ON codex_turn_queue
          BEGIN
            UPDATE codex_turn_queue SET prompt = X'FF' WHERE job_id = NEW.job_id;
          END;
        `);
        queueBefore = snapshotTable(setupDb, "codex_turn_queue");
      } finally {
        setupDb.close();
      }

      await assert.rejects(
        async () => beginAttempt(env.dbPath, "job-reselect-corrupt", [], 1n),
      );

      const verifyDb = new DatabaseSync(env.dbPath);
      try {
        const queueAfter = snapshotTable(verifyDb, "codex_turn_queue");
        assert.deepEqual(queueAfter, queueBefore);
      } finally {
        verifyDb.close();
      }
    } finally {
      env.cleanup();
    }
  });
});
