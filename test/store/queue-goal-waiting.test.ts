import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, beforeEach, afterEach } from "node:test";

import { markGoalWaiting } from "../../src/store/queue-goal-waiting.ts";
import { openInitialized } from "../../src/store/owned-driver.ts";
import {
  LATEST_STORE_SCHEMA_VERSION,
  schemaVersion,
} from "../../src/store/schema-assembly.ts";

const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;

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

function insertHold(
  db: DatabaseSync,
  targetThreadId: string,
  runtimeId = "runtime-1",
  generation = 1n,
  createdAt = 1712000000.0,
): void {
  db.prepare(
    "INSERT INTO codex_dead_generation_holds (target_thread_id, runtime_id, generation, created_at) VALUES (?, ?, ?, ?)",
  ).run(targetThreadId, runtimeId, generation, createdAt);
}

function insertIncident(
  db: DatabaseSync,
  runtimeId = "runtime-1",
  generation = 1n,
  snapshotJson = "{}",
  queueJobsJson = "[]",
  createdAt = 1712000000.0,
): void {
  db.prepare(
    "INSERT INTO codex_dead_generation_incidents (runtime_id, generation, snapshot_json, queue_jobs_json, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(runtimeId, generation, snapshotJson, queueJobsJson, createdAt);
}

function selectJobRow(
  db: DatabaseSync,
  jobId: string,
): Record<string, unknown> | undefined {
  const statement = db.prepare("SELECT * FROM codex_turn_queue WHERE job_id = ?");
  statement.setReadBigInts(true);
  return statement.get(jobId) as Record<string, unknown> | undefined;
}

describe("markGoalWaiting", () => {
  let tempDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goal-waiting-test-"));
    testDbPath = path.join(tempDir, "test.sqlite");
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe("predicate matching and success behavior", () => {
    it("success preserves all other columns and updates goal_waiting and updated_at", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-preservation-1",
          target_thread_id: "thread-preservation-1",
          channel_id: 9999n,
          owner_user_id: 8888n,
          discord_message_id: 7777n,
          app_server_generation: 10n,
          execution_generation: 20n,
          prompt: "custom prompt text",
          queued: 1n,
          ack_sent: 1n,
          state: "running",
          attempt_count: 3n,
          turn_id: "turn-preservation-1",
          baseline_turn_ids: "[\"base-1\"]",
          last_error: "transient warn",
          created_at: 1712000010.25,
          updated_at: 1712000020.5,
          goal_waiting: 0n,
          turn_observation_generation: 4n,
        });
      } finally {
        db.close();
      }

      const dbBefore = await openInitialized(testDbPath);
      let beforeRow: Record<string, unknown> | undefined;
      try {
        beforeRow = selectJobRow(dbBefore, "job-preservation-1");
      } finally {
        dbBefore.close();
      }
      assert.ok(beforeRow, "row must exist before call");
      assert.strictEqual(beforeRow.goal_waiting, 0n);

      const changed = await markGoalWaiting(
        testDbPath,
        "job-preservation-1",
        "turn-preservation-1",
        10n,
      );
      assert.strictEqual(changed, true);

      const dbAfter = await openInitialized(testDbPath);
      let afterRow: Record<string, unknown> | undefined;
      try {
        afterRow = selectJobRow(dbAfter, "job-preservation-1");
      } finally {
        dbAfter.close();
      }
      assert.ok(afterRow, "row must exist after call");
      assert.strictEqual(afterRow.goal_waiting, 1n);
      assert.strictEqual(typeof afterRow.updated_at, "number");
      assert.ok(
        (afterRow.updated_at as number) > (beforeRow.updated_at as number),
        "updated_at must be updated forward in time",
      );

      for (const [key, value] of Object.entries(beforeRow)) {
        if (key === "goal_waiting") {
          assert.strictEqual(afterRow[key], 1n);
        } else if (key === "updated_at") {
          assert.notStrictEqual(afterRow[key], value);
        } else {
          assert.strictEqual(
            afterRow[key],
            value,
            `column ${key} must be preserved without mutation`,
          );
        }
      }
    });

    it("repeat success returns true because SQL counts matched row not desired state change", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-repeat-1",
          turn_id: "turn-repeat-1",
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
          updated_at: 1712000000.0,
        });
      } finally {
        db.close();
      }

      const first = await markGoalWaiting(testDbPath, "job-repeat-1", "turn-repeat-1", 1n);
      assert.strictEqual(first, true);

      const dbMid = await openInitialized(testDbPath);
      let midUpdated: number;
      try {
        const midRow = selectJobRow(dbMid, "job-repeat-1");
        assert.ok(midRow);
        assert.strictEqual(midRow.goal_waiting, 1n);
        midUpdated = midRow.updated_at as number;
      } finally {
        dbMid.close();
      }

      const second = await markGoalWaiting(testDbPath, "job-repeat-1", "turn-repeat-1", 1n);
      assert.strictEqual(
        second,
        true,
        "repeat call must return true because SQLite UPDATE matches the row",
      );

      const dbFinal = await openInitialized(testDbPath);
      try {
        const finalRow = selectJobRow(dbFinal, "job-repeat-1");
        assert.ok(finalRow);
        assert.strictEqual(finalRow.goal_waiting, 1n);
        assert.ok((finalRow.updated_at as number) >= midUpdated);
      } finally {
        dbFinal.close();
      }
    });

    it("missing row returns false without mutation", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-other",
          turn_id: "turn-other",
          state: "running",
          app_server_generation: 1n,
        });
      } finally {
        db.close();
      }

      const changed = await markGoalWaiting(testDbPath, "job-does-not-exist", "turn-1", 1n);
      assert.strictEqual(changed, false);

      const dbCheck = await openInitialized(testDbPath);
      try {
        const other = selectJobRow(dbCheck, "job-other");
        assert.ok(other);
        assert.strictEqual(other.goal_waiting, 0n);
      } finally {
        dbCheck.close();
      }
    });

    it("mismatched turn_id returns false without mutation", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-turn-mismatch",
          turn_id: "turn-real",
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
          updated_at: 1712000001.0,
        });
      } finally {
        db.close();
      }

      const changed = await markGoalWaiting(
        testDbPath,
        "job-turn-mismatch",
        "turn-wrong",
        1n,
      );
      assert.strictEqual(changed, false);

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, "job-turn-mismatch");
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 0n);
        assert.strictEqual(row.updated_at, 1712000001.0);
      } finally {
        dbCheck.close();
      }
    });

    it("null turn_id in db returns false without mutation", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-null-turn",
          turn_id: null,
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
          updated_at: 1712000001.0,
        });
      } finally {
        db.close();
      }

      const changed = await markGoalWaiting(testDbPath, "job-null-turn", "turn-1", 1n);
      assert.strictEqual(changed, false);

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, "job-null-turn");
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 0n);
        assert.strictEqual(row.updated_at, 1712000001.0);
      } finally {
        dbCheck.close();
      }
    });

    it("mismatched generation returns false without mutation", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-gen-mismatch",
          turn_id: "turn-1",
          state: "running",
          app_server_generation: 5n,
          goal_waiting: 0n,
          updated_at: 1712000001.0,
        });
      } finally {
        db.close();
      }

      const changed = await markGoalWaiting(
        testDbPath,
        "job-gen-mismatch",
        "turn-1",
        6n,
      );
      assert.strictEqual(changed, false);

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, "job-gen-mismatch");
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 0n);
        assert.strictEqual(row.updated_at, 1712000001.0);
      } finally {
        dbCheck.close();
      }
    });

    it("pending state returns false without mutation", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-state-pending",
          turn_id: "turn-1",
          state: "pending",
          app_server_generation: 1n,
          goal_waiting: 0n,
          updated_at: 1712000001.0,
        });
      } finally {
        db.close();
      }

      const changed = await markGoalWaiting(
        testDbPath,
        "job-state-pending",
        "turn-1",
        1n,
      );
      assert.strictEqual(changed, false);

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, "job-state-pending");
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 0n);
        assert.strictEqual(row.updated_at, 1712000001.0);
      } finally {
        dbCheck.close();
      }
    });

    it("starting state returns false without mutation", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-state-starting",
          turn_id: "turn-1",
          state: "starting",
          app_server_generation: 1n,
          goal_waiting: 0n,
          updated_at: 1712000001.0,
        });
      } finally {
        db.close();
      }

      const changed = await markGoalWaiting(
        testDbPath,
        "job-state-starting",
        "turn-1",
        1n,
      );
      assert.strictEqual(changed, false);

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, "job-state-starting");
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 0n);
        assert.strictEqual(row.updated_at, 1712000001.0);
      } finally {
        dbCheck.close();
      }
    });

    it("completed or failed states return false without mutation", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-state-completed",
          turn_id: "turn-1",
          state: "completed",
          app_server_generation: 1n,
          goal_waiting: 0n,
        });
        insertJob(db, {
          job_id: "job-state-failed",
          turn_id: "turn-1",
          state: "failed",
          app_server_generation: 1n,
          goal_waiting: 0n,
        });
      } finally {
        db.close();
      }

      assert.strictEqual(
        await markGoalWaiting(testDbPath, "job-state-completed", "turn-1", 1n),
        false,
      );
      assert.strictEqual(
        await markGoalWaiting(testDbPath, "job-state-failed", "turn-1", 1n),
        false,
      );
    });
  });

  describe("dead generation hold vs incident gating", () => {
    it("hold in codex_dead_generation_holds blocks update and returns false without mutation", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-hold-blocked",
          target_thread_id: "thread-held-1",
          turn_id: "turn-1",
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
          updated_at: 1712000005.0,
        });
        insertHold(db, "thread-held-1", "runtime-test", 1n, 1712000000.0);
      } finally {
        db.close();
      }

      const changed = await markGoalWaiting(testDbPath, "job-hold-blocked", "turn-1", 1n);
      assert.strictEqual(changed, false);

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, "job-hold-blocked");
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 0n);
        assert.strictEqual(row.updated_at, 1712000005.0);
      } finally {
        dbCheck.close();
      }
    });

    it("hold for a different target thread does not block update", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-unheld-thread",
          target_thread_id: "thread-active-2",
          turn_id: "turn-1",
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
        });
        insertHold(db, "thread-other-held", "runtime-test", 1n, 1712000000.0);
      } finally {
        db.close();
      }

      const changed = await markGoalWaiting(testDbPath, "job-unheld-thread", "turn-1", 1n);
      assert.strictEqual(changed, true);

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, "job-unheld-thread");
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 1n);
      } finally {
        dbCheck.close();
      }
    });

    it("SEALEDGEN incident alone in codex_dead_generation_incidents DOES NOT gate update", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-sealed-incident-only",
          target_thread_id: "thread-sealed-incident",
          turn_id: "turn-1",
          state: "running",
          app_server_generation: 10n,
          goal_waiting: 0n,
        });
        insertIncident(
          db,
          "runtime-sealed-1",
          10n,
          JSON.stringify({ reason: "sealed" }),
          "[]",
          1712000000.0,
        );
      } finally {
        db.close();
      }

      const changed = await markGoalWaiting(
        testDbPath,
        "job-sealed-incident-only",
        "turn-1",
        10n,
      );
      assert.strictEqual(
        changed,
        true,
        "incident alone without codex_dead_generation_holds does not block markGoalWaiting",
      );

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, "job-sealed-incident-only");
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 1n);
      } finally {
        dbCheck.close();
      }
    });
  });

  describe("boundary generation, empty strings, and exact Unicode handling", () => {
    it("empty job and turn IDs are allowed and updated", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "",
          turn_id: "",
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
        });
      } finally {
        db.close();
      }

      const changed = await markGoalWaiting(testDbPath, "", "", 1n);
      assert.strictEqual(changed, true);

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, "");
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 1n);
      } finally {
        dbCheck.close();
      }
    });

    it("negative i64 generation is allowed and updated", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-neg-gen",
          turn_id: "turn-neg-gen",
          state: "running",
          app_server_generation: -42n,
          goal_waiting: 0n,
        });
      } finally {
        db.close();
      }

      const changed = await markGoalWaiting(testDbPath, "job-neg-gen", "turn-neg-gen", -42n);
      assert.strictEqual(changed, true);

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, "job-neg-gen");
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 1n);
      } finally {
        dbCheck.close();
      }
    });

    it("minimum i64 generation is accepted and updated", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-min-i64",
          turn_id: "turn-min-i64",
          state: "running",
          app_server_generation: I64_MIN,
          goal_waiting: 0n,
        });
      } finally {
        db.close();
      }

      const changed = await markGoalWaiting(
        testDbPath,
        "job-min-i64",
        "turn-min-i64",
        I64_MIN,
      );
      assert.strictEqual(changed, true);

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, "job-min-i64");
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 1n);
      } finally {
        dbCheck.close();
      }
    });

    it("maximum i64 generation is accepted and updated", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-max-i64",
          turn_id: "turn-max-i64",
          state: "running",
          app_server_generation: I64_MAX,
          goal_waiting: 0n,
        });
      } finally {
        db.close();
      }

      const changed = await markGoalWaiting(
        testDbPath,
        "job-max-i64",
        "turn-max-i64",
        I64_MAX,
      );
      assert.strictEqual(changed, true);

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, "job-max-i64");
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 1n);
      } finally {
        dbCheck.close();
      }
    });

    it("normal strings with NUL byte and BOM and valid supplementary characters are accepted", async () => {
      const nulJob = "job\u0000with-nul";
      const nulTurn = "turn\u0000with-nul";
      const bomJob = "\uFEFFjob-with-bom";
      const bomTurn = "\uFEFFturn-with-bom";
      const emojiJob = "job-\uD83D\uDE00-emoji";
      const emojiTurn = "turn-\uD83D\uDE80-rocket";

      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: nulJob,
          turn_id: nulTurn,
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
        });
        insertJob(db, {
          job_id: bomJob,
          turn_id: bomTurn,
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
        });
        insertJob(db, {
          job_id: emojiJob,
          turn_id: emojiTurn,
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
        });
      } finally {
        db.close();
      }

      assert.strictEqual(await markGoalWaiting(testDbPath, nulJob, nulTurn, 1n), true);
      assert.strictEqual(await markGoalWaiting(testDbPath, bomJob, bomTurn, 1n), true);
      assert.strictEqual(await markGoalWaiting(testDbPath, emojiJob, emojiTurn, 1n), true);
    });

    it("exact IDs without normalization: NFC and NFD strings do not alias or match", async () => {
      const nfcJob = "caf\u00E9-job";
      const nfdJob = "cafe\u0301-job";
      const nfcTurn = "resum\u00E9-turn";
      const nfdTurn = "resume\u0301-turn";

      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: nfcJob,
          turn_id: nfcTurn,
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
        });
      } finally {
        db.close();
      }

      const nfdMismatch = await markGoalWaiting(testDbPath, nfdJob, nfdTurn, 1n);
      assert.strictEqual(
        nfdMismatch,
        false,
        "NFD queried against NFC row must not match because strings are exact without normalization",
      );

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, nfcJob);
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 0n);
      } finally {
        dbCheck.close();
      }

      const nfcMatch = await markGoalWaiting(testDbPath, nfcJob, nfcTurn, 1n);
      assert.strictEqual(nfcMatch, true);
    });
  });

  describe("critical isolated surrogate alias regressions", () => {
    it("surrogate alias: persisted real FFFD job row + normal turn, call unpaired surrogate job -> TypeError / new unchanged row", async () => {
      const persistedJobId = "job-\uFFFD-alias-target";
      const normalTurnId = "turn-normal-1";
      const unpairedSurrogateJobId = "job-\uD800-alias-target";

      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: persistedJobId,
          turn_id: normalTurnId,
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
          updated_at: 1712000000.123,
        });
      } finally {
        db.close();
      }

      await assert.rejects(
        markGoalWaiting(testDbPath, unpairedSurrogateJobId, normalTurnId, 1n),
        (err: unknown) => {
          assert.ok(err instanceof TypeError);
          assert.strictEqual(err.message, "jobId must not contain unpaired surrogates");
          return true;
        },
      );

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, persistedJobId);
        assert.ok(row, "persisted real FFFD row must remain present");
        assert.strictEqual(
          row.goal_waiting,
          0n,
          "row must not be updated by surrogate alias",
        );
        assert.strictEqual(row.updated_at, 1712000000.123);
      } finally {
        dbCheck.close();
      }
    });

    it("surrogate alias: normal job + FFFD turn row / unpaired surrogate turn -> TypeError / new unchanged row", async () => {
      const normalJobId = "job-normal-1";
      const persistedTurnId = "turn-\uFFFD-alias-target";
      const unpairedSurrogateTurnId = "turn-\uD800-alias-target";

      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: normalJobId,
          turn_id: persistedTurnId,
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
          updated_at: 1712000000.456,
        });
      } finally {
        db.close();
      }

      await assert.rejects(
        markGoalWaiting(testDbPath, normalJobId, unpairedSurrogateTurnId, 1n),
        (err: unknown) => {
          assert.ok(err instanceof TypeError);
          assert.strictEqual(err.message, "turnId must not contain unpaired surrogates");
          return true;
        },
      );

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, normalJobId);
        assert.ok(row, "persisted row with FFFD turn must remain present");
        assert.strictEqual(
          row.goal_waiting,
          0n,
          "row must not be updated by surrogate alias",
        );
        assert.strictEqual(row.updated_at, 1712000000.456);
      } finally {
        dbCheck.close();
      }
    });

    it("surrogate alias: path surrogate rejection no file, no fabricated host native alias claim", async () => {
      const badPath = path.join(tempDir, "bad-path-\uD800.sqlite");

      await assert.rejects(
        markGoalWaiting(badPath, "job-1", "turn-1", 1n),
        (err: unknown) => {
          assert.ok(err instanceof TypeError);
          assert.strictEqual(err.message, "path must not contain unpaired surrogates");
          return true;
        },
      );

      const fileCreated = await fs.access(badPath).then(
        () => true,
        () => false,
      );
      assert.strictEqual(
        fileCreated,
        false,
        "path surrogate rejection must happen before openInitialized so no file is created",
      );
    });
  });

  describe("input validation before opening / no file created", () => {
    it("rejections before opening create no file for invalid path, jobId, turnId, or generation", async () => {
      const nonExistentPath = path.join(tempDir, "must-not-exist.sqlite");

      await assert.rejects(
        markGoalWaiting(123 as unknown as string, "job", "turn", 1n),
        { name: "TypeError", message: "path must be a string" },
      );
      await assert.rejects(
        markGoalWaiting(nonExistentPath, null as unknown as string, "turn", 1n),
        { name: "TypeError", message: "jobId must be a string" },
      );
      await assert.rejects(
        markGoalWaiting(nonExistentPath, "job", undefined as unknown as string, 1n),
        { name: "TypeError", message: "turnId must be a string" },
      );
      await assert.rejects(
        markGoalWaiting(nonExistentPath, "job", "turn", 123 as unknown as bigint),
        { name: "TypeError", message: "generation must be a bigint" },
      );
      await assert.rejects(
        markGoalWaiting(nonExistentPath, "job", "turn", "10" as unknown as bigint),
        { name: "TypeError", message: "generation must be a bigint" },
      );
      await assert.rejects(
        markGoalWaiting(nonExistentPath, "job", "turn", I64_MAX + 1n),
        {
          name: "RangeError",
          message: `generation out of i64 range: ${(I64_MAX + 1n).toString()}`,
        },
      );
      await assert.rejects(
        markGoalWaiting(nonExistentPath, "job", "turn", I64_MIN - 1n),
        {
          name: "RangeError",
          message: `generation out of i64 range: ${(I64_MIN - 1n).toString()}`,
        },
      );
      await assert.rejects(
        markGoalWaiting(nonExistentPath, "bad-\uDC00-low", "turn", 1n),
        { name: "TypeError", message: "jobId must not contain unpaired surrogates" },
      );
      await assert.rejects(
        markGoalWaiting(nonExistentPath, "job", "bad-\uD83D-high-only", 1n),
        { name: "TypeError", message: "turnId must not contain unpaired surrogates" },
      );

      const created = await fs.access(nonExistentPath).then(
        () => true,
        () => false,
      );
      assert.strictEqual(created, false, "no database file should have been created");
    });
  });

  describe("clock sampling, precision gap, and SystemTime errors", () => {
    it("single first positive / invalid second count 1 / same timestamp with explicit millisecond precision gap", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-clock-positive",
          turn_id: "turn-clock-positive",
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
        });
      } finally {
        db.close();
      }

      const originalDateNow = Date.now;
      let dateNowCalls = 0;
      const fixedMs = 1712005000123;
      try {
        Date.now = () => {
          dateNowCalls++;
          if (dateNowCalls === 1) {
            return fixedMs;
          }
          throw new Error("Date.now must not be sampled more than once");
        };

        const changed = await markGoalWaiting(
          testDbPath,
          "job-clock-positive",
          "turn-clock-positive",
          1n,
        );
        assert.strictEqual(changed, true);
        assert.strictEqual(dateNowCalls, 1, "Date.now must be sampled exactly once");
      } finally {
        Date.now = originalDateNow;
      }

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, "job-clock-positive");
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 1n);
        assert.strictEqual(row.updated_at, fixedMs / 1000);
        // Explicit millisecond precision gap: JS Date.now provides millisecond resolution
        // (3 decimal places in seconds), differing from full Rust nanosecond resolution.
        assert.strictEqual(Number(row.updated_at) * 1000, fixedMs);
      } finally {
        dbCheck.close();
      }
    });

    it("first negative SystemTime kind / message prefix before SQL and row unchanged", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-negative-clock",
          turn_id: "turn-1",
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
          updated_at: 1712000000.5,
        });
      } finally {
        db.close();
      }

      const originalDateNow = Date.now;
      let dateNowCalls = 0;
      try {
        Date.now = () => {
          dateNowCalls++;
          return -500;
        };

        await assert.rejects(
          markGoalWaiting(testDbPath, "job-negative-clock", "turn-1", 1n),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.strictEqual(err.name, "SystemTimeError");
            assert.strictEqual((err as { kind?: unknown }).kind, "SystemTime");
            assert.ok(
              err.message.startsWith("system clock is before the Unix epoch"),
              `expected message prefix, got: ${err.message}`,
            );
            return true;
          },
        );
        assert.strictEqual(dateNowCalls, 1);
      } finally {
        Date.now = originalDateNow;
      }

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, "job-negative-clock");
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 0n);
        assert.strictEqual(row.updated_at, 1712000000.5);
      } finally {
        dbCheck.close();
      }
    });

    it("first NaN ±Infinity TypeError('system clock must be finite'), all before SQL and row unchanged", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-nonfinite-clock",
          turn_id: "turn-1",
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
          updated_at: 1712000000.5,
        });
      } finally {
        db.close();
      }

      const originalDateNow = Date.now;
      try {
        for (const badValue of [NaN, Infinity, -Infinity]) {
          let calls = 0;
          Date.now = () => {
            calls++;
            return badValue;
          };

          await assert.rejects(
            markGoalWaiting(testDbPath, "job-nonfinite-clock", "turn-1", 1n),
            (err: unknown) => {
              assert.ok(err instanceof TypeError);
              assert.strictEqual(err.message, "system clock must be finite");
              return true;
            },
          );
          assert.strictEqual(calls, 1);
        }
      } finally {
        Date.now = originalDateNow;
      }

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, "job-nonfinite-clock");
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 0n);
        assert.strictEqual(row.updated_at, 1712000000.5);
      } finally {
        dbCheck.close();
      }
    });

    it("even missing row / wrong gen clock must sample once, clock error wins before SQL", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-real-gen1",
          turn_id: "turn-1",
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
          updated_at: 1712000000.0,
        });
      } finally {
        db.close();
      }

      const originalDateNow = Date.now;
      try {
        let missingCalls = 0;
        Date.now = () => {
          missingCalls++;
          return NaN;
        };
        await assert.rejects(
          markGoalWaiting(testDbPath, "job-missing-entirely", "turn-1", 1n),
          { name: "TypeError", message: "system clock must be finite" },
        );
        assert.strictEqual(missingCalls, 1);

        let wrongGenCalls = 0;
        Date.now = () => {
          wrongGenCalls++;
          return -9999;
        };
        await assert.rejects(
          markGoalWaiting(testDbPath, "job-real-gen1", "turn-1", 9999n),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.strictEqual(err.name, "SystemTimeError");
            assert.strictEqual((err as { kind?: unknown }).kind, "SystemTime");
            assert.ok(err.message.startsWith("system clock is before the Unix epoch"));
            return true;
          },
        );
        assert.strictEqual(wrongGenCalls, 1);
      } finally {
        Date.now = originalDateNow;
      }

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, "job-real-gen1");
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 0n);
        assert.strictEqual(row.updated_at, 1712000000.0);
      } finally {
        dbCheck.close();
      }
    });
  });

  describe("native SQLite triggers, fresh initialization, and connection ownership", () => {
    it("native BEFORE UPDATE IGNORE returns false and leaves row unchanged", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-trigger-ignore",
          turn_id: "turn-1",
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
          updated_at: 1712000001.0,
        });
        db.exec(`
          CREATE TRIGGER trg_test_ignore BEFORE UPDATE ON codex_turn_queue
          BEGIN
            SELECT RAISE(IGNORE);
          END;
        `);
      } finally {
        db.close();
      }

      const changed = await markGoalWaiting(testDbPath, "job-trigger-ignore", "turn-1", 1n);
      assert.strictEqual(changed, false);

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, "job-trigger-ignore");
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 0n);
        assert.strictEqual(row.updated_at, 1712000001.0);
      } finally {
        dbCheck.close();
      }
    });

    it("native BEFORE UPDATE ABORT propagates native SQLite error and leaves row unchanged", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-trigger-abort",
          turn_id: "turn-1",
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
          updated_at: 1712000001.0,
        });
        db.exec(`
          CREATE TRIGGER trg_test_abort BEFORE UPDATE ON codex_turn_queue
          BEGIN
            SELECT RAISE(ABORT, 'aborted by test trigger');
          END;
        `);
      } finally {
        db.close();
      }

      await assert.rejects(
        markGoalWaiting(testDbPath, "job-trigger-abort", "turn-1", 1n),
        /aborted by test trigger/,
      );

      const dbCheck = await openInitialized(testDbPath);
      try {
        const row = selectJobRow(dbCheck, "job-trigger-abort");
        assert.ok(row);
        assert.strictEqual(row.goal_waiting, 0n);
        assert.strictEqual(row.updated_at, 1712000001.0);
      } finally {
        dbCheck.close();
      }
    });

    it("normal AFTER UPDATE trigger effect is executed when update succeeds", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-trigger-after",
          turn_id: "turn-1",
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
        });
        db.exec(`
          CREATE TABLE test_audit_log (
            job_id TEXT,
            goal_waiting INTEGER,
            updated_at REAL
          );
          CREATE TRIGGER trg_test_after AFTER UPDATE ON codex_turn_queue
          BEGIN
            INSERT INTO test_audit_log VALUES (NEW.job_id, NEW.goal_waiting, NEW.updated_at);
          END;
        `);
      } finally {
        db.close();
      }

      const changed = await markGoalWaiting(testDbPath, "job-trigger-after", "turn-1", 1n);
      assert.strictEqual(changed, true);

      const dbCheck = await openInitialized(testDbPath);
      try {
        const auditRow = dbCheck
          .prepare("SELECT * FROM test_audit_log WHERE job_id = ?")
          .get("job-trigger-after") as Record<string, unknown> | undefined;
        assert.ok(auditRow, "after update audit row must be inserted");
        assert.strictEqual(auditRow.goal_waiting, 1);
      } finally {
        dbCheck.close();
      }
    });

    it("initialization before statement on fresh missing row returns false and leaves current migrations/schema", async () => {
      const freshDbPath = path.join(tempDir, "fresh-empty.sqlite");
      const changed = await markGoalWaiting(freshDbPath, "missing-from-fresh", "turn-1", 1n);
      assert.strictEqual(changed, false);

      const dbCheck = new DatabaseSync(freshDbPath);
      try {
        assert.strictEqual(schemaVersion(dbCheck), LATEST_STORE_SCHEMA_VERSION);
        const tables = dbCheck
          .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
          .all() as Array<{ name: string }>;
        const tableNames = tables.map((t) => t.name);
        assert.ok(tableNames.includes("codex_turn_queue"));
        assert.ok(tableNames.includes("codex_delivery_outbox"));
        assert.ok(tableNames.includes("codex_dead_generation_holds"));
      } finally {
        dbCheck.close();
      }
    });

    it("db remains accessible on separate connection after successful markGoalWaiting call", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-access-success",
          turn_id: "turn-1",
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
        });
      } finally {
        db.close();
      }

      const changed = await markGoalWaiting(testDbPath, "job-access-success", "turn-1", 1n);
      assert.strictEqual(changed, true);

      const separateDb = new DatabaseSync(testDbPath);
      try {
        const row = separateDb
          .prepare("SELECT count(*) as count FROM codex_turn_queue")
          .get() as { count: number };
        assert.ok(row.count >= 1);
      } finally {
        separateDb.close();
      }
    });

    it("db remains accessible on separate connection after error during markGoalWaiting call", async () => {
      const db = await openInitialized(testDbPath);
      try {
        insertJob(db, {
          job_id: "job-access-err",
          turn_id: "turn-1",
          state: "running",
          app_server_generation: 1n,
          goal_waiting: 0n,
        });
        db.exec(`
          CREATE TRIGGER trg_test_abort_access BEFORE UPDATE ON codex_turn_queue
          BEGIN
            SELECT RAISE(ABORT, 'aborted access test');
          END;
        `);
      } finally {
        db.close();
      }

      await assert.rejects(
        markGoalWaiting(testDbPath, "job-access-err", "turn-1", 1n),
        /aborted access test/,
      );

      const separateDb = new DatabaseSync(testDbPath);
      try {
        const row = separateDb
          .prepare("SELECT count(*) as count FROM codex_turn_queue")
          .get() as { count: number };
        assert.ok(row.count >= 1);
      } finally {
        separateDb.close();
      }
    });
  });
});
