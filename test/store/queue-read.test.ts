import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  selectJob,
  allJobs,
  serializeStoredQueueJob,
  isQuarantineEncoding,
  queueJobStateAsString,
  completionEvidenceGeneration,
  QueueJobNotFoundError,
  InvalidQueueStateError,
  StoreIntegrityError,
  QUARANTINED_TURN_PREFIX,
  QUARANTINED_ERROR_PREFIX,
  type StoredQueueJob,
  type QueueJobState,
} from "../../src/store/queue-read.ts";
import {
  migrateSchemaVersion,
  migrateSchemaExtensions,
} from "../../src/store/schema-assembly.ts";

const I64_MIN = -9223372036854775808n;

function migrateSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  migrateSchemaVersion(db, 1n);
  migrateSchemaVersion(db, 2n);
  migrateSchemaExtensions(db);
  db.exec("PRAGMA user_version = 2");
  db.exec("COMMIT");
}

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  migrateSchema(db);
  return db;
}

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

describe("queue-read decoder integration", () => {
  it("selectJob decodes all 19 fields accurately with >2^53 bigint, signed min/0/negative generations, nonzero booleans, and mixed timestamps", () => {
    const db = createDb();
    try {
      insertJob(db, {
        job_id: "job-all-19",
        target_thread_id: "thread-tgt-1",
        channel_id: 9007199254740995n,
        owner_user_id: 9007199254740997n,
        discord_message_id: 9007199254740999n,
        app_server_generation: I64_MIN,
        execution_generation: -42n,
        prompt: "test all 19 prompt",
        queued: 2n,
        ack_sent: 5n,
        state: "starting",
        attempt_count: -1n,
        turn_id: "turn-xyz",
        baseline_turn_ids: JSON.stringify(["turn-base-1", "turn-base-2"]),
        last_error: "prior failure",
        created_at: 1712000000.125,
        updated_at: 1712000050n,
        goal_waiting: 1n,
        turn_observation_generation: 0n,
      });

      const job = selectJob(db, "job-all-19");
      assert.equal(job.jobId, "job-all-19");
      assert.equal(job.targetThreadId, "thread-tgt-1");
      assert.equal(job.channelId, 9007199254740995n);
      assert.equal(job.ownerUserId, 9007199254740997n);
      assert.equal(job.discordMessageId, 9007199254740999n);
      assert.equal(job.appServerGeneration, I64_MIN);
      assert.equal(job.executionGeneration, -42n);
      assert.equal(job.prompt, "test all 19 prompt");
      assert.equal(job.queued, true);
      assert.equal(job.ackSent, true);
      assert.equal(job.state, "Starting");
      assert.equal(job.attemptCount, -1n);
      assert.equal(job.turnId, "turn-xyz");
      assert.deepEqual(job.baselineTurnIds, ["turn-base-1", "turn-base-2"]);
      assert.equal(job.lastError, "prior failure");
      assert.equal(job.createdAt, 1712000000.125);
      assert.equal(job.updatedAt, 1712000050);
      assert.equal(job.goalWaiting, true);
      assert.equal(job.turnObservationGeneration, 0n);
    } finally {
      db.close();
    }
  });

  it("selectJob decodes optional nullable fields as null and false boolean flags", () => {
    const db = createDb();
    try {
      insertJob(db, {
        job_id: "job-nullable-1",
        owner_user_id: null,
        discord_message_id: null,
        execution_generation: null,
        turn_observation_generation: null,
        turn_id: null,
        queued: 0n,
        ack_sent: 0n,
        goal_waiting: 0n,
        created_at: 1712000000n,
        updated_at: 1712000000.75,
      });

      const job = selectJob(db, "job-nullable-1");
      assert.equal(job.ownerUserId, null);
      assert.equal(job.discordMessageId, null);
      assert.equal(job.executionGeneration, null);
      assert.equal(job.turnObservationGeneration, null);
      assert.equal(job.turnId, null);
      assert.equal(job.queued, false);
      assert.equal(job.ackSent, false);
      assert.equal(job.goalWaiting, false);
      assert.equal(job.createdAt, 1712000000);
      assert.equal(job.updatedAt, 1712000000.75);
    } finally {
      db.close();
    }
  });

  it("selectJob throws StoreIntegrityError on fraction REAL values evading INTEGER column affinity", () => {
    const intCols = [
      "channel_id",
      "owner_user_id",
      "discord_message_id",
      "app_server_generation",
      "execution_generation",
      "attempt_count",
      "queued",
      "ack_sent",
      "goal_waiting",
      "turn_observation_generation",
    ] as const;

    for (const col of intCols) {
      const db = createDb();
      try {
        const jid = `job-frac-${col}`;
        insertJob(db, { job_id: jid, [col]: 12.5 });
        assert.throws(
          () => selectJob(db, jid),
          (err: unknown) => {
            assert.ok(err instanceof StoreIntegrityError);
            return true;
          },
        );
      } finally {
        db.close();
      }
    }
  });

  it("selectJob and allJobs throw StoreIntegrityError on BLOB masquerades in TEXT columns", () => {
    const textCols = [
      "target_thread_id",
      "prompt",
      "state",
      "turn_id",
      "baseline_turn_ids",
      "last_error",
    ] as const;

    for (const col of textCols) {
      const db = createDb();
      try {
        const jid = `job-blob-${col}`;
        insertJob(db, { job_id: jid, [col]: new Uint8Array([0x61, 0x62, 0x63]) });
        assert.throws(
          () => selectJob(db, jid),
          (err: unknown) => {
            assert.ok(err instanceof StoreIntegrityError);
            return true;
          },
        );
      } finally {
        db.close();
      }
    }

    const dbBlob = createDb();
    try {
      insertJob(dbBlob, { job_id: new Uint8Array([0x6a, 0x6f, 0x62]) });
      assert.throws(
        () => allJobs(dbBlob),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          return true;
        },
      );
    } finally {
      dbBlob.close();
    }
  });

  it("decodes legitimate astral UTF-8, BOM, and replacement characters across text fields", () => {
    const db = createDb();
    try {
      const validAstral = "\uFEFF astral \u{1F680}\u{1F30D} replacement \uFFFD";
      insertJob(db, {
        job_id: "job-unicode-ok",
        target_thread_id: validAstral,
        prompt: validAstral,
        turn_id: validAstral,
        last_error: validAstral,
      });

      const job = selectJob(db, "job-unicode-ok");
      assert.equal(job.targetThreadId, validAstral);
      assert.equal(job.prompt, validAstral);
      assert.equal(job.turnId, validAstral);
      assert.equal(job.lastError, validAstral);
    } finally {
      db.close();
    }
  });

  it("throws StoreIntegrityError when any of the 7 TEXT fields is overwritten with invalid UTF-8 byte 0x80", () => {
    const dbJobId = createDb();
    try {
      insertJob(dbJobId, { job_id: "job-utf8-bad-id" });
      dbJobId.exec("UPDATE codex_turn_queue SET job_id = CAST(X'80' AS TEXT) WHERE job_id = 'job-utf8-bad-id'");
      assert.throws(
        () => allJobs(dbJobId),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          return true;
        },
      );
    } finally {
      dbJobId.close();
    }

    const other6 = [
      "target_thread_id",
      "prompt",
      "state",
      "turn_id",
      "baseline_turn_ids",
      "last_error",
    ] as const;

    for (const col of other6) {
      const db = createDb();
      try {
        const jid = `job-utf8-bad-${col}`;
        insertJob(db, { job_id: jid, turn_id: "turn-valid" });
        db.exec(`UPDATE codex_turn_queue SET ${col} = CAST(X'80' AS TEXT) WHERE job_id = '${jid}'`);
        assert.throws(
          () => selectJob(db, jid),
          (err: unknown) => {
            assert.ok(err instanceof StoreIntegrityError);
            return true;
          },
        );
      } finally {
        db.close();
      }
    }
  });

  it("selectJob throws exact QueueJobNotFoundError on missing id and TypeError on malformed surrogate strings", () => {
    const db = createDb();
    try {
      assert.throws(
        () => selectJob(db, "no-such-job"),
        (err: unknown) => {
          assert.ok(err instanceof QueueJobNotFoundError);
          assert.equal(err.name, "QueueJobNotFoundError");
          assert.equal(err.kind, "QueueJobNotFound");
          assert.equal(err.message, "durable queue job not found: no-such-job");
          return true;
        },
      );

      assert.throws(() => selectJob(db, "\uD800"), TypeError);
      assert.throws(() => selectJob(db, 12345 as unknown as string), TypeError);
    } finally {
      db.close();
    }
  });

  it("selectJob throws exact InvalidQueueStateError on unknown state strings and literal raw quarantined", () => {
    const db = createDb();
    try {
      insertJob(db, { job_id: "job-unknown-state", state: "bogus_state" });
      assert.throws(
        () => selectJob(db, "job-unknown-state"),
        (err: unknown) => {
          assert.ok(err instanceof InvalidQueueStateError);
          assert.equal(err.name, "InvalidQueueStateError");
          assert.equal(err.kind, "InvalidQueueState");
          assert.equal(err.message, "invalid durable queue state: bogus_state");
          return true;
        },
      );

      insertJob(db, { job_id: "job-raw-quarantined", state: "quarantined" });
      assert.throws(
        () => selectJob(db, "job-raw-quarantined"),
        (err: unknown) => {
          assert.ok(err instanceof InvalidQueueStateError);
          assert.equal(err.name, "InvalidQueueStateError");
          assert.equal(err.kind, "InvalidQueueState");
          assert.equal(err.message, "invalid durable queue state: quarantined");
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  it("decodes Quarantined state only when raw running and both turn and error prefixes are present", () => {
    const db = createDb();
    try {
      insertJob(db, {
        job_id: "job-quarantine-ok",
        state: "running",
        turn_id: `${QUARANTINED_TURN_PREFIX}turn-001`,
        last_error: `${QUARANTINED_ERROR_PREFIX}process died`,
      });
      assert.equal(selectJob(db, "job-quarantine-ok").state, "Quarantined");

      insertJob(db, {
        job_id: "job-missing-turn-prefix",
        state: "running",
        turn_id: "turn-001",
        last_error: `${QUARANTINED_ERROR_PREFIX}process died`,
      });
      assert.equal(selectJob(db, "job-missing-turn-prefix").state, "Running");

      insertJob(db, {
        job_id: "job-missing-err-prefix",
        state: "running",
        turn_id: `${QUARANTINED_TURN_PREFIX}turn-001`,
        last_error: "regular error message",
      });
      assert.equal(selectJob(db, "job-missing-err-prefix").state, "Running");

      insertJob(db, {
        job_id: "job-null-turn-id",
        state: "running",
        turn_id: null,
        last_error: `${QUARANTINED_ERROR_PREFIX}process died`,
      });
      assert.equal(selectJob(db, "job-null-turn-id").state, "Running");

      insertJob(db, {
        job_id: "job-pending-with-prefixes",
        state: "pending",
        turn_id: `${QUARANTINED_TURN_PREFIX}turn-001`,
        last_error: `${QUARANTINED_ERROR_PREFIX}process died`,
      });
      assert.equal(selectJob(db, "job-pending-with-prefixes").state, "Pending");
    } finally {
      db.close();
    }
  });

  it("verifies quarantine helper functions and completion evidence generation fallback", () => {
    assert.equal(
      isQuarantineEncoding("running", `${QUARANTINED_TURN_PREFIX}turn-1`, `${QUARANTINED_ERROR_PREFIX}err`),
      true,
    );
    assert.equal(
      isQuarantineEncoding("running", "turn-1", `${QUARANTINED_ERROR_PREFIX}err`),
      false,
    );
    assert.equal(
      isQuarantineEncoding("running", null, `${QUARANTINED_ERROR_PREFIX}err`),
      false,
    );
    assert.equal(
      isQuarantineEncoding("pending", `${QUARANTINED_TURN_PREFIX}turn-1`, `${QUARANTINED_ERROR_PREFIX}err`),
      false,
    );

    assert.equal(queueJobStateAsString("Pending"), "pending");
    assert.equal(queueJobStateAsString("Starting"), "starting");
    assert.equal(queueJobStateAsString("Running"), "running");
    assert.equal(queueJobStateAsString("Quarantined"), "quarantined");
    assert.throws(
      () => queueJobStateAsString("Invalid" as unknown as QueueJobState),
      InvalidQueueStateError,
    );

    const jobWithTurnGen = {
      turnObservationGeneration: 99n,
      appServerGeneration: 12n,
    } as StoredQueueJob;
    assert.equal(completionEvidenceGeneration(jobWithTurnGen), 99n);

    const jobWithoutTurnGen = {
      turnObservationGeneration: null,
      appServerGeneration: 12n,
    } as StoredQueueJob;
    assert.equal(completionEvidenceGeneration(jobWithoutTurnGen), 12n);
  });

  it("decodes baseline_turn_ids nonarray to empty array, canonicalizes numbers/decimals/-0, and rejects invalid JSON", () => {
    const db = createDb();
    try {
      insertJob(db, { job_id: "job-base-obj", baseline_turn_ids: '{"not": "array"}' });
      assert.deepEqual(selectJob(db, "job-base-obj").baselineTurnIds, []);

      insertJob(db, { job_id: "job-base-str", baseline_turn_ids: '"plain string"' });
      assert.deepEqual(selectJob(db, "job-base-str").baselineTurnIds, []);

      insertJob(db, { job_id: "job-base-num", baseline_turn_ids: "12345" });
      assert.deepEqual(selectJob(db, "job-base-num").baselineTurnIds, []);

      insertJob(db, { job_id: "job-base-null", baseline_turn_ids: "null" });
      assert.deepEqual(selectJob(db, "job-base-null").baselineTurnIds, []);

      insertJob(db, {
        job_id: "job-base-mixed",
        baseline_turn_ids: '["alpha", 9.999999999999999e-6, {"tag": 1}, -0]',
      });
      const mixedJob = selectJob(db, "job-base-mixed");
      assert.deepEqual(mixedJob.baselineTurnIds, [
        "alpha",
        "0.00001",
        '{"tag":1}',
        "-0.0",
      ]);

      insertJob(db, { job_id: "job-base-bad-json", baseline_turn_ids: '{"broken' });
      assert.throws(
        () => selectJob(db, "job-base-bad-json"),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match(err.message, /Failed to parse baseline_turn_ids JSON/);
          return true;
        },
      );

      insertJob(db, {
        job_id: "job-base-dup-overflow",
        baseline_turn_ids: '{"a":1e999,"a":1}',
      });
      assert.throws(
        () => selectJob(db, "job-base-dup-overflow"),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  it("preserves caller transaction without closing database and orders allJobs by created_at then job_id", () => {
    const db = createDb();
    try {
      insertJob(db, { job_id: "job-z", created_at: 200, updated_at: 200 });
      insertJob(db, { job_id: "job-b", created_at: 100, updated_at: 100 });
      insertJob(db, { job_id: "job-a", created_at: 100, updated_at: 100 });

      db.exec("BEGIN IMMEDIATE");

      const single = selectJob(db, "job-a");
      assert.equal(single.jobId, "job-a");

      const jobs = allJobs(db);
      assert.deepEqual(
        jobs.map((j) => j.jobId),
        ["job-a", "job-b", "job-z"],
      );

      // Verify db is open and transaction active
      const testRow = db.prepare("SELECT 1 AS val").get() as { val: number };
      assert.equal(testRow.val, 1);
      assert.doesNotThrow(() => db.exec("ROLLBACK"));
    } finally {
      db.close();
    }
  });

  describe("actual SQLite inserted REAL +Infinity/-Infinity decode retained and serializer exact created_at:null updated_at:null", () => {
    it("standalone job from selectJob mutated NaN timestamps both serialize null; NOT NULL constraint rejects NULL", () => {
      const db = createDb();
      try {
        insertJob(db, {
          created_at: Infinity,
          updated_at: -Infinity,
        });

        const job = selectJob(db, "job-default-1");
        assert.equal(job.createdAt, Infinity);
        assert.equal(job.updatedAt, -Infinity);

        const serializedInf = serializeStoredQueueJob(job);
        assert.match(serializedInf, /"created_at":null,"updated_at":null/);

        job.createdAt = Number.NaN;
        job.updatedAt = Number.NaN;
        const serializedNaN = serializeStoredQueueJob(job);
        assert.match(serializedNaN, /"created_at":null,"updated_at":null/);

        assert.throws(
          () => {
            db.prepare("UPDATE codex_turn_queue SET created_at = NULL WHERE job_id = ?").run("job-default-1");
          },
          (err: unknown) => {
            const sqliteErr = err as { code?: string; errcode?: number; message?: string };
            assert.ok(
              sqliteErr.errcode === 1299 ||
                (sqliteErr.code === "ERR_SQLITE_ERROR" && /NOT NULL/.test(sqliteErr.message ?? "")),
            );
            return true;
          },
        );

        assert.throws(
          () => {
            db.prepare("UPDATE codex_turn_queue SET created_at = 1712000000.5, updated_at = NULL WHERE job_id = ?").run("job-default-1");
          },
          (err: unknown) => {
            const sqliteErr = err as { code?: string; errcode?: number; message?: string };
            assert.ok(
              sqliteErr.errcode === 1299 ||
                (sqliteErr.code === "ERR_SQLITE_ERROR" && /NOT NULL/.test(sqliteErr.message ?? "")),
            );
            return true;
          },
        );

        const remainingJob = selectJob(db, "job-default-1");
        assert.equal(remainingJob.createdAt, Infinity);
        assert.equal(remainingJob.updatedAt, -Infinity);
      } finally {
        db.close();
      }
    });
  });
});
