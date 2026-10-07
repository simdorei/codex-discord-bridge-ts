import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  recordJobOrigin,
  recordOrigin,
  recordUserOrigin,
  userOriginMarker,
  type QueueJobState,
  type StoredQueueJob,
} from "../../src/store/mirror-origin.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";

interface EventRow {
  col_type: string;
  col_val: number | null;
}

function createMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE codex_session_mirror_events (
      event_digest TEXT PRIMARY KEY,
      codex_thread_id TEXT NOT NULL,
      created_at REAL NOT NULL
    );
  `);
  return db;
}

function getEventRow(db: DatabaseSync, marker: string): EventRow | undefined {
  const stmt = db.prepare(
    "SELECT typeof(created_at) AS col_type, created_at AS col_val FROM codex_session_mirror_events WHERE event_digest = ?",
  );
  return stmt.get(marker) as EventRow | undefined;
}

function makeJob(
  updatedAt: number,
  overrides: Partial<StoredQueueJob> = {},
): StoredQueueJob {
  return {
    jobId: "job-fixed-1",
    targetThreadId: "thread-job-target",
    channelId: 10001n,
    ownerUserId: 20002n,
    discordMessageId: 30003n,
    appServerGeneration: 1n,
    executionGeneration: 2n,
    turnObservationGeneration: 3n,
    goalWaiting: false,
    prompt: "job test prompt text",
    queued: true,
    ackSent: true,
    state: "Running",
    attemptCount: 1n,
    turnId: "turn-job-1",
    baselineTurnIds: ["turn-base-0"],
    lastError: "",
    createdAt: 1700000000000,
    updatedAt,
    ...overrides,
  };
}

async function withTempDb(fn: (dbPath: string) => Promise<void>): Promise<void> {
  const prefix = "cdr-ts-origin-nonfinite-";
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const trackedPath = fs.realpathSync(rawDir);
  const dbPath = path.join(trackedPath, "test-origin-nonfinite.sqlite");

  try {
    await fn(dbPath);
  } finally {
    const realPath = fs.realpathSync(trackedPath);
    const realTmpDir = fs.realpathSync(os.tmpdir());
    const parent = path.dirname(realPath);

    const normalize = (p: string) =>
      process.platform === "win32" ? p.toLowerCase() : p;

    assert.strictEqual(normalize(realPath), normalize(trackedPath));
    assert.strictEqual(
      normalize(path.resolve(parent)),
      normalize(path.resolve(realTmpDir)),
    );
    assert.ok(
      path.basename(realPath).startsWith(prefix),
      `Expected directory basename to start with ${prefix}, got ${path.basename(realPath)}`,
    );

    fs.rmSync(trackedPath, { recursive: true, force: true });
  }
}

test("recordOrigin persists REAL Infinity and -Infinity exactly on new rows", () => {
  const db = createMemoryDb();
  try {
    const thread = "thread-record-origin-inf";
    const nonFiniteValues = [
      { turn: "turn-pos-inf", prompt: "pos inf prompt", val: Infinity },
      { turn: "turn-neg-inf", prompt: "neg inf prompt", val: -Infinity },
    ];

    for (const item of nonFiniteValues) {
      recordOrigin(db, thread, item.turn, item.prompt, item.val);
      const marker = userOriginMarker(thread, item.turn, item.prompt);
      const row = getEventRow(db, marker);
      assert.ok(row !== undefined, `Row must exist for ${item.val}`);
      assert.strictEqual(row.col_type, "real");
      assert.strictEqual(row.col_val, item.val);
      assert.strictEqual(Number.isFinite(row.col_val), false);
    }
  } finally {
    db.close();
  }
});
test("recordOrigin ignores NaN on new row due to NOT NULL without error", () => {
  const db = createMemoryDb();
  try {
    const thread = "thread-record-origin-nan";
    const turn = "turn-nan";
    const prompt = "nan prompt";

    assert.doesNotThrow(() => {
      recordOrigin(db, thread, turn, prompt, NaN);
    });

    const marker = userOriginMarker(thread, turn, prompt);
    const row = getEventRow(db, marker);
    assert.strictEqual(row, undefined, "Row must not be inserted when now is NaN");

    assert.doesNotThrow(() => {
      recordOrigin(db, thread, turn, prompt, NaN);
    });
    const rowAfterRepeat = getEventRow(db, marker);
    assert.strictEqual(rowAfterRepeat, undefined, "Repeat NaN insert must still leave table empty");

    recordOrigin(db, thread, turn, prompt, 12345.5);
    const rowAfterFinite = getEventRow(db, marker);
    assert.ok(rowAfterFinite !== undefined);
    assert.strictEqual(rowAfterFinite.col_type, "real");
    assert.strictEqual(rowAfterFinite.col_val, 12345.5);
  } finally {
    db.close();
  }
});

test("recordOrigin duplicates preserve original first custody across finite and non-finite timestamps", () => {
  const db = createMemoryDb();
  try {
    const thread = "thread-record-origin-custody";

    // 1. Initial Infinity: duplicate with finite, -Infinity, and NaN preserves initial Infinity
    {
      const turn = "turn-custody-pos-inf";
      const prompt = "custody pos inf";
      const marker = userOriginMarker(thread, turn, prompt);
      recordOrigin(db, thread, turn, prompt, Infinity);

      recordOrigin(db, thread, turn, prompt, 100.0);
      let row = getEventRow(db, marker);
      assert.ok(row !== undefined);
      assert.strictEqual(row.col_type, "real");
      assert.strictEqual(row.col_val, Infinity);

      recordOrigin(db, thread, turn, prompt, -Infinity);
      row = getEventRow(db, marker);
      assert.ok(row !== undefined);
      assert.strictEqual(row.col_val, Infinity);

      recordOrigin(db, thread, turn, prompt, NaN);
      row = getEventRow(db, marker);
      assert.ok(row !== undefined);
      assert.strictEqual(row.col_val, Infinity);
    }

    // 2. Initial -Infinity: duplicate with finite, Infinity, and NaN preserves initial -Infinity
    {
      const turn = "turn-custody-neg-inf";
      const prompt = "custody neg inf";
      const marker = userOriginMarker(thread, turn, prompt);
      recordOrigin(db, thread, turn, prompt, -Infinity);

      recordOrigin(db, thread, turn, prompt, 200.0);
      let row = getEventRow(db, marker);
      assert.ok(row !== undefined);
      assert.strictEqual(row.col_type, "real");
      assert.strictEqual(row.col_val, -Infinity);

      recordOrigin(db, thread, turn, prompt, Infinity);
      row = getEventRow(db, marker);
      assert.ok(row !== undefined);
      assert.strictEqual(row.col_val, -Infinity);

      recordOrigin(db, thread, turn, prompt, NaN);
      row = getEventRow(db, marker);
      assert.ok(row !== undefined);
      assert.strictEqual(row.col_val, -Infinity);
    }

    // 3. Initial finite: duplicate with Infinity, -Infinity, and NaN preserves initial finite timestamp
    {
      const turn = "turn-custody-finite";
      const prompt = "custody finite";
      const marker = userOriginMarker(thread, turn, prompt);
      recordOrigin(db, thread, turn, prompt, 500.25);

      recordOrigin(db, thread, turn, prompt, Infinity);
      let row = getEventRow(db, marker);
      assert.ok(row !== undefined);
      assert.strictEqual(row.col_type, "real");
      assert.strictEqual(row.col_val, 500.25);

      recordOrigin(db, thread, turn, prompt, -Infinity);
      row = getEventRow(db, marker);
      assert.ok(row !== undefined);
      assert.strictEqual(row.col_val, 500.25);

      recordOrigin(db, thread, turn, prompt, NaN);
      row = getEventRow(db, marker);
      assert.ok(row !== undefined);
      assert.strictEqual(row.col_val, 500.25);
    }
  } finally {
    db.close();
  }
});

test("recordJobOrigin handles full 19-field jobs with non-pending states and Some/None turn", () => {
  const db = createMemoryDb();
  try {
    const states: QueueJobState[] = ["Starting", "Running", "Quarantined"];

    for (const [idx, state] of states.entries()) {
      const turn = `turn-job-state-${state.toLowerCase()}`;
      const prompt = `job prompt for ${state}`;
      const val = idx % 2 === 0 ? Infinity : -Infinity;

      const job = makeJob(val, {
        jobId: `job-state-${idx}`,
        targetThreadId: "thread-job-states",
        prompt,
        state,
        turnId: turn,
      });

      recordJobOrigin(db, job);

      const marker = userOriginMarker("thread-job-states", turn, prompt);
      const row = getEventRow(db, marker);
      assert.ok(row !== undefined);
      assert.strictEqual(row.col_type, "real");
      assert.strictEqual(row.col_val, val);
    }

    {
      const nanJob = makeJob(NaN, {
        jobId: "job-nan-state",
        targetThreadId: "thread-job-nan",
        prompt: "job nan prompt",
        state: "Running",
        turnId: "turn-job-nan",
      });
      assert.doesNotThrow(() => {
        recordJobOrigin(db, nanJob);
      });
      const marker = userOriginMarker(
        nanJob.targetThreadId,
        nanJob.turnId!,
        nanJob.prompt,
      );
      const row = getEventRow(db, marker);
      assert.strictEqual(row, undefined);
    }

    {
      const nullTurnJob = makeJob(Infinity, {
        jobId: "job-null-turn",
        targetThreadId: "thread-job-null-turn",
        prompt: "job prompt null turn",
        state: "Running",
        turnId: null,
      });
      assert.doesNotThrow(() => {
        recordJobOrigin(db, nullTurnJob);
      });
      const stmt = db.prepare(
        "SELECT COUNT(*) AS cnt FROM codex_session_mirror_events WHERE codex_thread_id = ?",
      );
      const res = stmt.get(nullTurnJob.targetThreadId) as { cnt: number };
      assert.strictEqual(res.cnt, 0);
    }
  } finally {
    db.close();
  }
});

test("recordJobOrigin duplicates preserve first custody for ±Infinity and NaN", () => {
  const db = createMemoryDb();
  try {
    // 1. Initial job updatedAt: Infinity, duplicate with finite and NaN
    {
      const job1 = makeJob(Infinity, {
        jobId: "job-custody-inf-1",
        targetThreadId: "thread-job-custody-1",
        prompt: "job custody prompt 1",
        turnId: "turn-job-c1",
        state: "Running",
      });
      recordJobOrigin(db, job1);

      const marker = userOriginMarker(
        job1.targetThreadId,
        job1.turnId!,
        job1.prompt,
      );
      let row = getEventRow(db, marker);
      assert.ok(row !== undefined);
      assert.strictEqual(row.col_val, Infinity);

      const job2 = makeJob(9999.0, {
        jobId: "job-custody-inf-2",
        targetThreadId: job1.targetThreadId,
        prompt: job1.prompt,
        turnId: job1.turnId,
        state: "Starting",
      });
      recordJobOrigin(db, job2);
      row = getEventRow(db, marker);
      assert.ok(row !== undefined);
      assert.strictEqual(row.col_val, Infinity);

      const job3 = makeJob(NaN, {
        jobId: "job-custody-inf-3",
        targetThreadId: job1.targetThreadId,
        prompt: job1.prompt,
        turnId: job1.turnId,
        state: "Quarantined",
      });
      recordJobOrigin(db, job3);
      row = getEventRow(db, marker);
      assert.ok(row !== undefined);
      assert.strictEqual(row.col_val, Infinity);
    }

    // 2. Initial job updatedAt: finite, duplicate with -Infinity and NaN
    {
      const job1 = makeJob(1234.5, {
        jobId: "job-custody-fin-1",
        targetThreadId: "thread-job-custody-2",
        prompt: "job custody prompt 2",
        turnId: "turn-job-c2",
        state: "Running",
      });
      recordJobOrigin(db, job1);

      const marker = userOriginMarker(
        job1.targetThreadId,
        job1.turnId!,
        job1.prompt,
      );
      let row = getEventRow(db, marker);
      assert.ok(row !== undefined);
      assert.strictEqual(row.col_val, 1234.5);

      const job2 = makeJob(-Infinity, {
        jobId: "job-custody-fin-2",
        targetThreadId: job1.targetThreadId,
        prompt: job1.prompt,
        turnId: job1.turnId,
        state: "Starting",
      });
      recordJobOrigin(db, job2);
      row = getEventRow(db, marker);
      assert.ok(row !== undefined);
      assert.strictEqual(row.col_val, 1234.5);

      const job3 = makeJob(NaN, {
        jobId: "job-custody-fin-3",
        targetThreadId: job1.targetThreadId,
        prompt: job1.prompt,
        turnId: job1.turnId,
        state: "Quarantined",
      });
      recordJobOrigin(db, job3);
      row = getEventRow(db, marker);
      assert.ok(row !== undefined);
      assert.strictEqual(row.col_val, 1234.5);
    }
  } finally {
    db.close();
  }
});

test("caller BEGIN IMMEDIATE transaction ownership and ROLLBACK for non-finite writes", () => {
  const db = createMemoryDb();
  try {
    const thread = "thread-caller-tx";

    // 1. recordOrigin with Infinity inside caller transaction, rolled back
    {
      const turn = "turn-tx-inf";
      const prompt = "tx prompt inf";
      const marker = userOriginMarker(thread, turn, prompt);

      db.exec("BEGIN IMMEDIATE;");
      assert.strictEqual(db.isTransaction, true);

      recordOrigin(db, thread, turn, prompt, Infinity);

      const inTxRow = getEventRow(db, marker);
      assert.ok(inTxRow !== undefined);
      assert.strictEqual(inTxRow.col_type, "real");
      assert.strictEqual(inTxRow.col_val, Infinity);

      db.exec("ROLLBACK;");
      assert.strictEqual(db.isTransaction, false);

      const afterRollbackRow = getEventRow(db, marker);
      assert.strictEqual(
        afterRollbackRow,
        undefined,
        "Row must be removed after ROLLBACK",
      );
    }

    // 2. recordJobOrigin with -Infinity inside caller transaction, rolled back
    {
      const turn = "turn-tx-job-neg-inf";
      const prompt = "tx prompt job neg inf";
      const marker = userOriginMarker(thread, turn, prompt);
      const job = makeJob(-Infinity, {
        targetThreadId: thread,
        turnId: turn,
        prompt,
        state: "Running",
      });

      db.exec("BEGIN IMMEDIATE;");
      assert.strictEqual(db.isTransaction, true);

      recordJobOrigin(db, job);

      const inTxRow = getEventRow(db, marker);
      assert.ok(inTxRow !== undefined);
      assert.strictEqual(inTxRow.col_type, "real");
      assert.strictEqual(inTxRow.col_val, -Infinity);

      db.exec("ROLLBACK;");
      assert.strictEqual(db.isTransaction, false);

      const afterRollbackRow = getEventRow(db, marker);
      assert.strictEqual(
        afterRollbackRow,
        undefined,
        "Job origin row must be removed after ROLLBACK",
      );
    }

    // 3. Caller transaction with NaN insert attempts rolls back cleanly
    {
      const turn = "turn-tx-nan";
      const prompt = "tx prompt nan";
      const marker = userOriginMarker(thread, turn, prompt);

      db.exec("BEGIN IMMEDIATE;");
      assert.strictEqual(db.isTransaction, true);

      recordOrigin(db, thread, turn, prompt, NaN);

      const inTxRow = getEventRow(db, marker);
      assert.strictEqual(inTxRow, undefined);

      db.exec("ROLLBACK;");
      assert.strictEqual(db.isTransaction, false);
    }
  } finally {
    db.close();
  }
});

test("typeof number validation rejects string, null, bigint across borrowed and owned functions", async () => {
  const db = createMemoryDb();
  try {
    const thread = "thread-val-check";
    const turn = "turn-val-check";
    const prompt = "val check prompt";

    const invalidInputs: unknown[] = [
      "12345",
      null,
      12345n,
      undefined,
      {},
      true,
    ];

    for (const invalid of invalidInputs) {
      assert.throws(
        () => {
          recordOrigin(
            db,
            thread,
            turn,
            prompt,
            invalid as unknown as number,
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /now must be a number/);
          return true;
        },
      );

      const badJob = makeJob(invalid as unknown as number, {
        targetThreadId: thread,
        turnId: turn,
        prompt,
      });
      assert.throws(
        () => {
          recordJobOrigin(db, badJob);
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /now must be a number/);
          return true;
        },
      );

      await assert.rejects(
        async () => {
          await recordUserOrigin(
            "nonexistent-dummy.sqlite",
            thread,
            turn,
            prompt,
            invalid as unknown as number,
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.match((err as Error).message, /now must be a number/);
          return true;
        },
      );
    }

    for (const validNonFinite of [Infinity, -Infinity, NaN]) {
      assert.doesNotThrow(() => {
        recordOrigin(db, thread, `valid-${validNonFinite}`, prompt, validNonFinite);
      });
    }
  } finally {
    db.close();
  }
});

test("owned recordUserOrigin persists REAL ±Infinity and preserves custody independently on reopened tempdb", async () => {
  await withTempDb(async (dbPath) => {
    const thread = "thread-user-inf";

    // 1. Initial Infinity
    const turn1 = "turn-user-pos-inf";
    const prompt1 = "user pos inf prompt";
    const marker1 = userOriginMarker(thread, turn1, prompt1);

    await recordUserOrigin(dbPath, thread, turn1, prompt1, Infinity);

    {
      const checkDb = new DatabaseSync(dbPath);
      try {
        const row = getEventRow(checkDb, marker1);
        assert.ok(row !== undefined);
        assert.strictEqual(row.col_type, "real");
        assert.strictEqual(row.col_val, Infinity);
        assert.strictEqual(Number.isFinite(row.col_val), false);
      } finally {
        checkDb.close();
      }
    }

    await recordUserOrigin(dbPath, thread, turn1, prompt1, 43210.0);
    {
      const checkDb = new DatabaseSync(dbPath);
      try {
        const row = getEventRow(checkDb, marker1);
        assert.ok(row !== undefined);
        assert.strictEqual(row.col_val, Infinity);
      } finally {
        checkDb.close();
      }
    }

    // 2. Initial -Infinity
    const turn2 = "turn-user-neg-inf";
    const prompt2 = "user neg inf prompt";
    const marker2 = userOriginMarker(thread, turn2, prompt2);

    await recordUserOrigin(dbPath, thread, turn2, prompt2, -Infinity);

    {
      const checkDb = new DatabaseSync(dbPath);
      try {
        const row = getEventRow(checkDb, marker2);
        assert.ok(row !== undefined);
        assert.strictEqual(row.col_type, "real");
        assert.strictEqual(row.col_val, -Infinity);
        assert.strictEqual(Number.isFinite(row.col_val), false);
      } finally {
        checkDb.close();
      }
    }

    await recordUserOrigin(dbPath, thread, turn2, prompt2, 87654.0);
    {
      const checkDb = new DatabaseSync(dbPath);
      try {
        const row = getEventRow(checkDb, marker2);
        assert.ok(row !== undefined);
        assert.strictEqual(row.col_val, -Infinity);
      } finally {
        checkDb.close();
      }
    }

    // 3. Initial finite timestamp preserves custody against Infinity and -Infinity duplicates
    const turn3 = "turn-user-custody-fin";
    const prompt3 = "user custody fin prompt";
    const marker3 = userOriginMarker(thread, turn3, prompt3);

    await recordUserOrigin(dbPath, thread, turn3, prompt3, 112233.0);
    await recordUserOrigin(dbPath, thread, turn3, prompt3, Infinity);
    await recordUserOrigin(dbPath, thread, turn3, prompt3, -Infinity);

    {
      const checkDb = new DatabaseSync(dbPath);
      try {
        const row = getEventRow(checkDb, marker3);
        assert.ok(row !== undefined);
        assert.strictEqual(row.col_val, 112233.0);
      } finally {
        checkDb.close();
      }
    }
  });
});

test("owned recordUserOrigin ignores NaN on new row and preserves custody on duplicate on reopened tempdb", async () => {
  await withTempDb(async (dbPath) => {
    const thread = "thread-user-nan";
    const turn = "turn-user-nan";
    const prompt = "user nan prompt";
    const marker = userOriginMarker(thread, turn, prompt);

    await recordUserOrigin(dbPath, thread, turn, prompt, NaN);

    {
      const checkDb = new DatabaseSync(dbPath);
      try {
        const row = getEventRow(checkDb, marker);
        assert.strictEqual(
          row,
          undefined,
          "No row should be inserted for NaN timestamp on new marker",
        );
      } finally {
        checkDb.close();
      }
    }

    await recordUserOrigin(dbPath, thread, turn, prompt, NaN);
    {
      const checkDb = new DatabaseSync(dbPath);
      try {
        const row = getEventRow(checkDb, marker);
        assert.strictEqual(row, undefined);
      } finally {
        checkDb.close();
      }
    }

    await recordUserOrigin(dbPath, thread, turn, prompt, 65432.1);
    {
      const checkDb = new DatabaseSync(dbPath);
      try {
        const row = getEventRow(checkDb, marker);
        assert.ok(row !== undefined);
        assert.strictEqual(row.col_type, "real");
        assert.strictEqual(row.col_val, 65432.1);
      } finally {
        checkDb.close();
      }
    }

    await recordUserOrigin(dbPath, thread, turn, prompt, NaN);
    {
      const checkDb = new DatabaseSync(dbPath);
      try {
        const row = getEventRow(checkDb, marker);
        assert.ok(row !== undefined);
        assert.strictEqual(row.col_type, "real");
        assert.strictEqual(row.col_val, 65432.1);
      } finally {
        checkDb.close();
      }
    }
  });
});
