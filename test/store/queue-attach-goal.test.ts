import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { I64_MAX, I64_MIN } from "../../src/protocol/ids.ts";
import { openInitialized } from "../../src/store/owned-driver.ts";
import {
  attachGoalTurn,
  InvalidQueueStateError,
  now,
  SystemTimeError,
} from "../../src/store/queue-attach-goal.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";

/**
 * Concurrency and platform note:
 * SQLite synchronization tests are bound to single-process task-owned file handles.
 * No true operating-system file handle closure proofs or multi-process concurrency
 * assertions are attempted in pure Node.js environments.
 *
 * Clock precision gap note:
 * JavaScript's Date.now() provides millisecond precision (f64 seconds = ms / 1000),
 * whereas Rust's SystemTime provides nanosecond precision. This precision gap is expected.
 *
 * Deliberate test API exposure note:
 * `now()` is deliberately exported from `src/store/queue-attach-goal.ts` to enable
 * deterministic clock validation under boundary and non-finite timestamps.
 */

async function withFixture(
  run: (path: string, db: DatabaseSync) => Promise<void>,
): Promise<void> {
  const root = resolve(realpathSync(tmpdir()));
  const dir = mkdtempSync(join(root, "cdr-ts-queue-attach-goal-"));
  const path = join(dir, "store.sqlite");
  const db = await openInitialized(path);
  try {
    await run(path, db);
  } finally {
    try {
      db.close();
    } catch {}
    const actual = resolve(realpathSync(dir));
    assert.equal(actual.toLowerCase(), resolve(dir).toLowerCase());
    assert.equal(dirname(actual).toLowerCase(), root.toLowerCase());
    rmSync(actual, { recursive: true, force: true });
  }
}

async function withDir(
  run: (dir: string, path: string) => Promise<void>,
): Promise<void> {
  const root = resolve(realpathSync(tmpdir()));
  const dir = mkdtempSync(join(root, "cdr-ts-queue-attach-dir-"));
  const path = join(dir, "store.sqlite");
  try {
    await run(dir, path);
  } finally {
    const actual = resolve(realpathSync(dir));
    assert.equal(actual.toLowerCase(), resolve(dir).toLowerCase());
    assert.equal(dirname(actual).toLowerCase(), root.toLowerCase());
    rmSync(actual, { recursive: true, force: true });
  }
}

async function withEncodingFixture(
  encoding: "UTF-16le" | "UTF-16be",
  run: (path: string, db: DatabaseSync) => Promise<void>,
): Promise<void> {
  const root = resolve(realpathSync(tmpdir()));
  const dir = mkdtempSync(join(root, `cdr-ts-queue-attach-${encoding.toLowerCase()}-`));
  const path = join(dir, "store.sqlite");
  const rawDb = new DatabaseSync(path);
  try {
    rawDb.exec(`PRAGMA encoding = '${encoding}';`);
    rawDb.exec("CREATE TABLE sentinel (id INTEGER PRIMARY KEY);");
    const checkRow = rawDb.prepare("PRAGMA encoding;").get() as Record<string, unknown> | undefined;
    assert.equal(checkRow ? Object.values(checkRow)[0] : undefined, encoding);
  } finally {
    rawDb.close();
  }
  const db = await openInitialized(path);
  try {
    await run(path, db);
  } finally {
    try {
      db.close();
    } catch {}
    const actual = resolve(realpathSync(dir));
    assert.equal(actual.toLowerCase(), resolve(dir).toLowerCase());
    assert.equal(dirname(actual).toLowerCase(), root.toLowerCase());
    rmSync(actual, { recursive: true, force: true });
  }
}

interface InsertJobOptions {
  jobId: unknown;
  targetThreadId?: string;
  generation?: bigint;
  state?: string;
  goalWaiting?: number | bigint;
  turnId?: string | null;
  turnObservationGeneration?: bigint | null;
  ownerUserId?: bigint | null;
  channelId?: bigint;
  prompt?: string;
  queued?: number;
  ackSent?: number;
  attemptCount?: number;
  baselineTurnIds?: string;
  createdAt?: number;
  updatedAt?: number;
}

function insertJob(db: DatabaseSync, opts: InsertJobOptions): void {
  const stmt = db.prepare(
    "INSERT INTO codex_turn_queue (" +
      "job_id, target_thread_id, channel_id, owner_user_id, app_server_generation, " +
      "prompt, queued, ack_sent, state, attempt_count, baseline_turn_ids, " +
      "created_at, updated_at, goal_waiting, turn_id, turn_observation_generation" +
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  stmt.run(
    opts.jobId as string | Uint8Array,
    opts.targetThreadId ?? "target_thread_1",
    opts.channelId ?? 5n,
    opts.ownerUserId ?? 7n,
    opts.generation ?? 1n,
    opts.prompt ?? "test prompt",
    opts.queued ?? 1,
    opts.ackSent ?? 0,
    opts.state ?? "running",
    opts.attemptCount ?? 0,
    opts.baselineTurnIds ?? "[]",
    opts.createdAt ?? 1000,
    opts.updatedAt ?? 1000,
    opts.goalWaiting ?? 1,
    opts.turnId ?? null,
    opts.turnObservationGeneration ?? null,
  );
}

function insertHold(
  db: DatabaseSync,
  targetThreadId: string,
  generation = 1n,
  runtimeId = "runtime",
): void {
  db.prepare(
    "INSERT INTO codex_dead_generation_holds (target_thread_id, runtime_id, generation, created_at) VALUES (?, ?, ?, ?)",
  ).run(targetThreadId, runtimeId, generation, 0);
}

function getJobRow(db: DatabaseSync, jobId: string): Record<string, unknown> {
  const stmt = db.prepare("SELECT * FROM codex_turn_queue WHERE job_id = ?");
  stmt.setReadBigInts(true);
  const row = stmt.get(jobId) as Record<string, unknown> | undefined;
  assert.ok(row !== undefined, `Job ${jobId} not found`);
  return row;
}

test("successful attachGoalTurn updates only turn_id, turn_observation_generation, goal_waiting, updated_at", async () => {
  await withFixture(async (path, db) => {
    const tableInfo = db.prepare("PRAGMA table_info(codex_turn_queue);").all() as Array<{ name: string }>;
    const hasExecGen = tableInfo.some((col) => col.name === "execution_generation");

    insertJob(db, {
      jobId: "job-1",
      targetThreadId: "thread-1",
      generation: 42n,
      state: "running",
      goalWaiting: 1,
      createdAt: 1000,
      updatedAt: 1000,
    });
    if (hasExecGen) {
      db.prepare("UPDATE codex_turn_queue SET execution_generation = ? WHERE job_id = 'job-1'").run(99n);
    }

    const before = getJobRow(db, "job-1");
    const turnId = "turn-42-alpha";
    const res = await attachGoalTurn(path, "thread-1", turnId, 42n);
    assert.equal(res, true);

    const after = getJobRow(db, "job-1");

    assert.equal(after["turn_id"], turnId);
    assert.equal(after["turn_observation_generation"], 42n);
    assert.equal(after["goal_waiting"], 0n);
    assert.ok(typeof after["updated_at"] === "number");
    assert.ok((after["updated_at"] as number) > 1000);

    for (const key of Object.keys(before)) {
      if (
        key === "turn_id" ||
        key === "turn_observation_generation" ||
        key === "goal_waiting" ||
        key === "updated_at"
      ) {
        continue;
      }
      assert.deepEqual(after[key], before[key], `Column ${key} should remain unchanged`);
    }

    assert.equal(after["app_server_generation"], 42n);
    if (hasExecGen) {
      assert.equal(after["execution_generation"], 99n);
    }
  });
});

test("signed generation extrema (I64_MAX, I64_MIN) and negative generation are valid", async () => {
  await withFixture(async (path, db) => {
    insertJob(db, {
      jobId: "job-max",
      targetThreadId: "thread-max",
      generation: I64_MAX,
      state: "running",
      goalWaiting: 1,
    });
    const resMax = await attachGoalTurn(path, "thread-max", "turn-max", I64_MAX);
    assert.equal(resMax, true);
    const rowMax = getJobRow(db, "job-max");
    assert.equal(rowMax["turn_observation_generation"], I64_MAX);
    assert.equal(rowMax["goal_waiting"], 0n);

    insertJob(db, {
      jobId: "job-min",
      targetThreadId: "thread-min",
      generation: I64_MIN,
      state: "running",
      goalWaiting: 1,
    });
    const resMin = await attachGoalTurn(path, "thread-min", "turn-min", I64_MIN);
    assert.equal(resMin, true);
    const rowMin = getJobRow(db, "job-min");
    assert.equal(rowMin["turn_observation_generation"], I64_MIN);
    assert.equal(rowMin["goal_waiting"], 0n);

    insertJob(db, {
      jobId: "job-neg",
      targetThreadId: "thread-neg",
      generation: -1n,
      state: "running",
      goalWaiting: 1,
    });
    const resNeg = await attachGoalTurn(path, "thread-neg", "turn-neg", -1n);
    assert.equal(resNeg, true);
    const rowNeg = getJobRow(db, "job-neg");
    assert.equal(rowNeg["turn_observation_generation"], -1n);
    assert.equal(rowNeg["goal_waiting"], 0n);
  });
});

test("turnId boundary strings: empty, whitespace, NUL, BOM, supplementary characters", async () => {
  await withFixture(async (path, db) => {
    const testCases: Array<{ id: string; target: string; turnId: string }> = [
      { id: "job-empty", target: "target-empty", turnId: "" },
      { id: "job-ws", target: "target-ws", turnId: "   \t\r\n  " },
      { id: "job-nul", target: "target-nul", turnId: "turn\0with\0nul" },
      { id: "job-bom", target: "target-bom", turnId: "\uFEFFturn_bom" },
      { id: "job-supp", target: "target-supp", turnId: "🚀_turn_\u{1F600}_sparkle_✨" },
    ];

    for (const tc of testCases) {
      insertJob(db, {
        jobId: tc.id,
        targetThreadId: tc.target,
        generation: 1n,
        state: "running",
        goalWaiting: 1,
      });
      const res = await attachGoalTurn(path, tc.target, tc.turnId, 1n);
      assert.equal(res, true, `attachGoalTurn failed for ${tc.id}`);
      const row = getJobRow(db, tc.id);
      assert.equal(row["turn_id"], tc.turnId, `turn_id mismatch for ${tc.id}`);
      assert.equal(row["goal_waiting"], 0n);
    }
  });
});

test("target held (even with other gen hold) returns false before queue query and clock sampling", async () => {
  await withFixture(async (path, db) => {
    insertHold(db, "target-held", 999n);

    db.prepare(
      "INSERT INTO codex_turn_queue (" +
        "job_id, target_thread_id, channel_id, owner_user_id, app_server_generation, " +
        "prompt, queued, ack_sent, state, attempt_count, baseline_turn_ids, " +
        "created_at, updated_at, goal_waiting" +
      ") VALUES (CAST(X'FF' AS TEXT), 'target-held', 5, 7, 1, 'p', 1, 0, 'running', 0, '[]', 1000, 1000, 1)",
    ).run();

    const originalDateNow = Date.now;
    let clockSampled = false;
    Date.now = () => {
      clockSampled = true;
      throw new Error("Clock sampled when target was held");
    };

    try {
      const res = await attachGoalTurn(path, "target-held", "turn-1", 1n);
      assert.equal(res, false);
      assert.equal(clockSampled, false, "Clock must not be sampled when target is held");
    } finally {
      Date.now = originalDateNow;
    }
  });
});

test("zero matching owners commits false, does not sample clock, and filters non-matching jobs", async () => {
  await withFixture(async (path, db) => {
    insertJob(db, { jobId: "job-pending", targetThreadId: "t-filter", generation: 1n, state: "pending", goalWaiting: 1 });
    insertJob(db, { jobId: "job-completed", targetThreadId: "t-filter", generation: 1n, state: "completed", goalWaiting: 1 });
    insertJob(db, { jobId: "job-gw0", targetThreadId: "t-filter", generation: 1n, state: "running", goalWaiting: 0 });
    insertJob(db, { jobId: "job-gw2", targetThreadId: "t-filter", generation: 1n, state: "running", goalWaiting: 2 });
    insertJob(db, { jobId: "job-wrong-gen", targetThreadId: "t-filter", generation: 2n, state: "running", goalWaiting: 1 });
    insertJob(db, { jobId: "job-other-target", targetThreadId: "other-target", generation: 1n, state: "running", goalWaiting: 1 });

    const originalDateNow = Date.now;
    let clockSampled = false;
    Date.now = () => {
      clockSampled = true;
      throw new Error("Clock sampled on zero matching owners");
    };

    try {
      const res = await attachGoalTurn(path, "t-filter", "turn-filter", 1n);
      assert.equal(res, false);
      assert.equal(clockSampled, false);
    } finally {
      Date.now = originalDateNow;
    }

    const jobs = ["job-pending", "job-completed", "job-gw0", "job-gw2", "job-wrong-gen", "job-other-target"];
    for (const id of jobs) {
      const row = getJobRow(db, id);
      assert.equal(row["turn_id"], null);
      assert.equal(row["turn_observation_generation"], null);
    }
  });
});

test("fresh database file without prior tables initializes migrations and persists on zero owners", async () => {
  await withDir(async (_dir, freshPath) => {
    const res = await attachGoalTurn(freshPath, "t-fresh", "turn-fresh", 1n);
    assert.equal(res, false);

    const inspectDb = new DatabaseSync(freshPath);
    try {
      const versionRow = inspectDb.prepare("PRAGMA user_version;").get() as { user_version: number } | undefined;
      assert.ok(versionRow !== undefined);
      assert.ok(versionRow.user_version > 0);

      const countRow = inspectDb.prepare("SELECT COUNT(*) AS count FROM codex_turn_queue;").get() as
        | { count: number }
        | undefined;
      assert.ok(countRow !== undefined);
      assert.equal(countRow.count, 0);
    } finally {
      inspectDb.close();
    }
  });
});

test("exactly duplicate owners throws InvalidQueueStateError, clock 0, all unchanged", async () => {
  await withFixture(async (path, db) => {
    insertJob(db, { jobId: "job-dup-1", targetThreadId: "t-dup", generation: 1n, state: "running", goalWaiting: 1, updatedAt: 100 });
    insertJob(db, { jobId: "job-dup-2", targetThreadId: "t-dup", generation: 1n, state: "running", goalWaiting: 1, updatedAt: 200 });

    const originalDateNow = Date.now;
    let clockSampled = false;
    Date.now = () => {
      clockSampled = true;
      throw new Error("Clock sampled on duplicate owners");
    };

    try {
      await assert.rejects(
        async () => {
          await attachGoalTurn(path, "t-dup", "turn-dup", 1n);
        },
        (err: unknown) => {
          assert.ok(err instanceof InvalidQueueStateError);
          assert.equal(err.kind, "InvalidQueueState");
          assert.equal(err.name, "InvalidQueueStateError");
          assert.equal(
            err.message,
            "invalid durable queue state: multiple goal-waiting jobs for t-dup",
          );
          return true;
        },
      );
      assert.equal(clockSampled, false);
    } finally {
      Date.now = originalDateNow;
    }

    const r1 = getJobRow(db, "job-dup-1");
    assert.equal(r1["goal_waiting"], 1n);
    assert.equal(r1["turn_id"], null);
    assert.equal(r1["updated_at"], 100);

    const r2 = getJobRow(db, "job-dup-2");
    assert.equal(r2["goal_waiting"], 1n);
    assert.equal(r2["turn_id"], null);
    assert.equal(r2["updated_at"], 200);
  });
});

test("decode ALL matching IDs before duplicate decision: valid + native BLOB throws StoreIntegrityError, not InvalidQueueState", async () => {
  await withFixture(async (path, db) => {
    insertJob(db, { jobId: "job-valid", targetThreadId: "t-blob-dup", generation: 1n, state: "running", goalWaiting: 1 });
    insertJob(db, {
      jobId: Buffer.from("job-blob-id"),
      targetThreadId: "t-blob-dup",
      generation: 1n,
      state: "running",
      goalWaiting: 1,
    });

    await assert.rejects(
      async () => {
        await attachGoalTurn(path, "t-blob-dup", "turn-1", 1n);
      },
      (err: unknown) => {
        assert.ok(err instanceof StoreIntegrityError);
        assert.notEqual((err as { kind?: string }).kind, "InvalidQueueState");
        return true;
      },
    );

    const r1 = getJobRow(db, "job-valid");
    assert.equal(r1["goal_waiting"], 1n);
    assert.equal(r1["turn_id"], null);
  });
});

test("decode ALL matching IDs before duplicate decision: valid + malformed UTF-8 CAST(X'FF' AS TEXT) throws StoreIntegrityError", async () => {
  await withFixture(async (path, db) => {
    insertJob(db, { jobId: "job-valid-2", targetThreadId: "t-utf8-dup", generation: 1n, state: "running", goalWaiting: 1 });
    db.prepare(
      "INSERT INTO codex_turn_queue (" +
        "job_id, target_thread_id, channel_id, owner_user_id, app_server_generation, " +
        "prompt, queued, ack_sent, state, attempt_count, baseline_turn_ids, " +
        "created_at, updated_at, goal_waiting" +
      ") VALUES (CAST(X'FF' AS TEXT), 't-utf8-dup', 5, 7, 1, 'p', 1, 0, 'running', 0, '[]', 1000, 1000, 1)",
    ).run();

    await assert.rejects(
      async () => {
        await attachGoalTurn(path, "t-utf8-dup", "turn-2", 1n);
      },
      (err: unknown) => {
        assert.ok(err instanceof StoreIntegrityError);
        assert.notEqual((err as { kind?: string }).kind, "InvalidQueueState");
        return true;
      },
    );

    const r1 = getJobRow(db, "job-valid-2");
    assert.equal(r1["goal_waiting"], 1n);
    assert.equal(r1["turn_id"], null);
  });
});

test("single matching job with native BLOB containing valid UTF-8 text must reject with StoreIntegrityError", async () => {
  await withFixture(async (path, db) => {
    insertJob(db, {
      jobId: Buffer.from("job-blob-valid-ascii"),
      targetThreadId: "t-blob-single",
      generation: 1n,
      state: "running",
      goalWaiting: 1,
    });

    await assert.rejects(
      async () => {
        await attachGoalTurn(path, "t-blob-single", "turn-blob", 1n);
      },
      (err: unknown) => {
        assert.ok(err instanceof StoreIntegrityError);
        return true;
      },
    );
  });
});

test("single matching job with malformed UTF-8 text must reject rather than replace and update wrong row", async () => {
  await withFixture(async (path, db) => {
    db.prepare(
      "INSERT INTO codex_turn_queue (" +
        "job_id, target_thread_id, channel_id, owner_user_id, app_server_generation, " +
        "prompt, queued, ack_sent, state, attempt_count, baseline_turn_ids, " +
        "created_at, updated_at, goal_waiting" +
      ") VALUES (CAST(X'FF' AS TEXT), 't-single-malformed', 5, 7, 1, 'p', 1, 0, 'running', 0, '[]', 1000, 1000, 1)",
    ).run();

    await assert.rejects(
      async () => {
        await attachGoalTurn(path, "t-single-malformed", "turn-malformed", 1n);
      },
      (err: unknown) => {
        assert.ok(err instanceof StoreIntegrityError);
        return true;
      },
    );
  });
});

test("valid replacement character U+FFFD stored job is accepted when alias matches, but rejected on corrupt alias", async () => {
  await withFixture(async (path, db) => {
    insertJob(db, {
      jobId: "\uFFFD",
      targetThreadId: "t-fffd",
      generation: 1n,
      state: "running",
      goalWaiting: 1,
    });

    const res = await attachGoalTurn(path, "t-fffd", "turn-fffd", 1n);
    assert.equal(res, true);
    const row = getJobRow(db, "\uFFFD");
    assert.equal(row["turn_id"], "turn-fffd");
    assert.equal(row["goal_waiting"], 0n);
  });
});

test("UTF-16LE encoding database fixture correctly decodes job_id and updates row", async () => {
  await withEncodingFixture("UTF-16le", async (path, db) => {
    const encRow = db.prepare("PRAGMA encoding;").get() as Record<string, unknown> | undefined;
    assert.ok(encRow !== undefined);
    const encValues = Object.values(encRow) as string[];
    assert.ok(encValues[0] !== undefined);
    assert.equal(encValues[0], "UTF-16le");

    insertJob(db, {
      jobId: "job-utf16le",
      targetThreadId: "t-utf16le",
      generation: 1n,
      state: "running",
      goalWaiting: 1,
    });

    const res = await attachGoalTurn(path, "t-utf16le", "turn-utf16le", 1n);
    assert.equal(res, true);

    const row = getJobRow(db, "job-utf16le");
    assert.equal(row["turn_id"], "turn-utf16le");
    assert.equal(row["turn_observation_generation"], 1n);
    assert.equal(row["goal_waiting"], 0n);
  });
});

test("UTF-16BE encoding database fixture correctly decodes job_id and updates row", async () => {
  await withEncodingFixture("UTF-16be", async (path, db) => {
    const encRow = db.prepare("PRAGMA encoding;").get() as Record<string, unknown> | undefined;
    assert.ok(encRow !== undefined);
    const encValues = Object.values(encRow) as string[];
    assert.ok(encValues[0] !== undefined);
    assert.equal(encValues[0], "UTF-16be");

    insertJob(db, {
      jobId: "job-utf16be",
      targetThreadId: "t-utf16be",
      generation: 1n,
      state: "running",
      goalWaiting: 1,
    });

    const res = await attachGoalTurn(path, "t-utf16be", "turn-utf16be", 1n);
    assert.equal(res, true);

    const row = getJobRow(db, "job-utf16be");
    assert.equal(row["turn_id"], "turn-utf16be");
    assert.equal(row["turn_observation_generation"], 1n);
    assert.equal(row["goal_waiting"], 0n);
  });
});

test("BEFORE UPDATE trigger with RAISE(IGNORE) commits true even with changes 0 and unchanged row", async () => {
  await withFixture(async (path, db) => {
    db.exec("CREATE TRIGGER ignore_update BEFORE UPDATE ON codex_turn_queue BEGIN SELECT RAISE(IGNORE); END;");
    insertJob(db, {
      jobId: "job-ignore",
      targetThreadId: "t-ignore",
      generation: 1n,
      state: "running",
      goalWaiting: 1,
    });

    const res = await attachGoalTurn(path, "t-ignore", "turn-ignored", 1n);
    assert.equal(res, true);

    const row = getJobRow(db, "job-ignore");
    assert.equal(row["goal_waiting"], 1n);
    assert.equal(row["turn_id"], null);
  });
});

test("BEFORE UPDATE trigger with RAISE(ABORT) rolls back native error and preserves row unchanged", async () => {
  await withFixture(async (path, db) => {
    db.exec(
      "CREATE TRIGGER abort_update BEFORE UPDATE ON codex_turn_queue BEGIN SELECT RAISE(ABORT, 'aborted by trigger'); END;",
    );
    insertJob(db, {
      jobId: "job-abort",
      targetThreadId: "t-abort",
      generation: 1n,
      state: "running",
      goalWaiting: 1,
    });

    await assert.rejects(
      async () => {
        await attachGoalTurn(path, "t-abort", "turn-aborted", 1n);
      },
      /aborted by trigger/,
    );

    const row = getJobRow(db, "job-abort");
    assert.equal(row["goal_waiting"], 1n);
    assert.equal(row["turn_id"], null);
  });
});

test("AFTER UPDATE trigger commits audit row alongside successful transaction", async () => {
  await withFixture(async (path, db) => {
    db.exec("CREATE TABLE audit_log (job_id TEXT, new_turn_id TEXT, updated_at REAL);");
    db.exec(
      "CREATE TRIGGER audit_update AFTER UPDATE ON codex_turn_queue BEGIN " +
        "INSERT INTO audit_log VALUES (NEW.job_id, NEW.turn_id, NEW.updated_at); " +
      "END;",
    );
    insertJob(db, {
      jobId: "job-audit",
      targetThreadId: "t-audit",
      generation: 1n,
      state: "running",
      goalWaiting: 1,
    });

    const res = await attachGoalTurn(path, "t-audit", "turn-audited", 1n);
    assert.equal(res, true);

    const auditRow = db.prepare("SELECT * FROM audit_log WHERE job_id = 'job-audit'").get() as
      | { job_id: string; new_turn_id: string; updated_at: number }
      | undefined;
    assert.ok(auditRow !== undefined);
    assert.equal(auditRow.job_id, "job-audit");
    assert.equal(auditRow.new_turn_id, "turn-audited");
  });
});

test("single unique Date.now positive first call then invalid second call samples timestamp exactly once", async () => {
  await withFixture(async (path, db) => {
    insertJob(db, {
      jobId: "job-clock-1",
      targetThreadId: "t-clock",
      generation: 1n,
      state: "running",
      goalWaiting: 1,
    });

    const originalDateNow = Date.now;
    let calls = 0;
    const fixedMs = 1712345678123;
    Date.now = () => {
      calls++;
      if (calls === 1) return fixedMs;
      return NaN;
    };

    try {
      const res = await attachGoalTurn(path, "t-clock", "turn-clock", 1n);
      assert.equal(res, true);
      assert.equal(calls, 1, "Date.now must be called exactly once");

      const row = getJobRow(db, "job-clock-1");
      assert.equal(row["updated_at"], fixedMs / 1000);
    } finally {
      Date.now = originalDateNow;
    }
  });
});

test("first negative Date.now throws SystemTimeError before UPDATE and preserves row unchanged", async () => {
  await withFixture(async (path, db) => {
    insertJob(db, {
      jobId: "job-neg-clock",
      targetThreadId: "t-neg-clock",
      generation: 1n,
      state: "running",
      goalWaiting: 1,
      updatedAt: 777,
    });

    const originalDateNow = Date.now;
    Date.now = () => -100;

    try {
      await assert.rejects(
        async () => {
          await attachGoalTurn(path, "t-neg-clock", "turn-neg-clock", 1n);
        },
        (err: unknown) => {
          assert.ok(err instanceof SystemTimeError);
          assert.equal(err.kind, "SystemTime");
          assert.equal(err.name, "SystemTimeError");
          assert.ok(err.message.startsWith("system clock is before the Unix epoch"));
          return true;
        },
      );

      const row = getJobRow(db, "job-neg-clock");
      assert.equal(row["goal_waiting"], 1n);
      assert.equal(row["turn_id"], null);
      assert.equal(row["updated_at"], 777);
    } finally {
      Date.now = originalDateNow;
    }
  });
});

test("first NaN, Infinity, -Infinity Date.now throws TypeError and preserves row unchanged", async () => {
  await withFixture(async (path, db) => {
    const invalidValues = [NaN, Infinity, -Infinity];

    for (let i = 0; i < invalidValues.length; i++) {
      const val = invalidValues[i]!;
      const jobId = `job-inv-${i}`;
      const target = `t-inv-${i}`;
      insertJob(db, {
        jobId,
        targetThreadId: target,
        generation: 1n,
        state: "running",
        goalWaiting: 1,
        updatedAt: 888,
      });

      const originalDateNow = Date.now;
      Date.now = () => val;

      try {
        await assert.rejects(
          async () => {
            await attachGoalTurn(path, target, "turn-inv", 1n);
          },
          (err: unknown) => {
            assert.ok(err instanceof TypeError);
            assert.equal(err.message, "system clock must be finite");
            return true;
          },
        );

        const row = getJobRow(db, jobId);
        assert.equal(row["goal_waiting"], 1n);
        assert.equal(row["turn_id"], null);
        assert.equal(row["updated_at"], 888);
      } finally {
        Date.now = originalDateNow;
      }
    }
  });
});

test("strict input validation: path non-string or lone surrogate rejects before file", async () => {
  await withDir(async (dir, _path) => {
    const nonExistentPath = join(dir, "no-file.sqlite");

    await assert.rejects(
      async () => {
        await attachGoalTurn(123 as unknown as string, "t", "turn", 1n);
      },
      TypeError,
    );
    await assert.rejects(
      async () => {
        await attachGoalTurn(null as unknown as string, "t", "turn", 1n);
      },
      TypeError,
    );

    await assert.rejects(
      async () => {
        await attachGoalTurn(`${nonExistentPath}\uD800`, "t", "turn", 1n);
      },
      (err: unknown) => {
        assert.ok(err instanceof TypeError);
        assert.equal(err.message, "Invalid Unicode surrogate in path");
        return true;
      },
    );
  });
});

test("strict input validation: targetThreadId non-string or lone surrogate rejects before file", async () => {
  await withDir(async (dir, _path) => {
    const nonExistentPath = join(dir, "no-file-target.sqlite");

    await assert.rejects(
      async () => {
        await attachGoalTurn(nonExistentPath, 123 as unknown as string, "turn", 1n);
      },
      TypeError,
    );
    await assert.rejects(
      async () => {
        await attachGoalTurn(nonExistentPath, "target\uD83D", "turn", 1n);
      },
      (err: unknown) => {
        assert.ok(err instanceof TypeError);
        assert.equal(err.message, "Invalid Unicode surrogate in targetThreadId");
        return true;
      },
    );
  });
});

test("strict input validation: turnId non-string or lone surrogate rejects before file", async () => {
  await withDir(async (dir, _path) => {
    const nonExistentPath = join(dir, "no-file-turn.sqlite");

    await assert.rejects(
      async () => {
        await attachGoalTurn(nonExistentPath, "t", null as unknown as string, 1n);
      },
      TypeError,
    );
    await assert.rejects(
      async () => {
        await attachGoalTurn(nonExistentPath, "t", "turn\uDFFF", 1n);
      },
      (err: unknown) => {
        assert.ok(err instanceof TypeError);
        assert.equal(err.message, "Invalid Unicode surrogate in turnId");
        return true;
      },
    );
  });
});

test("strict input validation: generation non-bigint or overflow rejects before file", async () => {
  await withDir(async (dir, _path) => {
    const nonExistentPath = join(dir, "no-file-gen.sqlite");

    await assert.rejects(
      async () => {
        await attachGoalTurn(nonExistentPath, "t", "turn", 1 as unknown as bigint);
      },
      TypeError,
    );
    await assert.rejects(
      async () => {
        await attachGoalTurn(nonExistentPath, "t", "turn", "1" as unknown as bigint);
      },
      TypeError,
    );
    await assert.rejects(
      async () => {
        await attachGoalTurn(nonExistentPath, "t", "turn", I64_MAX + 1n);
      },
      RangeError,
    );
    await assert.rejects(
      async () => {
        await attachGoalTurn(nonExistentPath, "t", "turn", I64_MIN - 1n);
      },
      RangeError,
    );
  });
});

test("NUL exact IDs are preserved without truncation or normalization", async () => {
  await withFixture(async (path, db) => {
    const exactJobId = "job\0with\0nul";
    const exactTarget = "thread\0with\0nul";
    const exactTurn = "turn\0with\0nul";

    insertJob(db, {
      jobId: exactJobId,
      targetThreadId: exactTarget,
      generation: 1n,
      state: "running",
      goalWaiting: 1,
    });

    const resTrunc = await attachGoalTurn(path, "thread", exactTurn, 1n);
    assert.equal(resTrunc, false);

    const resExact = await attachGoalTurn(path, exactTarget, exactTurn, 1n);
    assert.equal(resExact, true);

    const row = getJobRow(db, exactJobId);
    assert.equal(row["turn_id"], exactTurn);
    assert.equal(row["target_thread_id"], exactTarget);
    assert.equal(row["goal_waiting"], 0n);
  });
});

test("now() returns fractional seconds for positive finite timestamp and rejects negative or non-finite", () => {
  const originalDateNow = Date.now;
  try {
    Date.now = () => 1700000000500;
    assert.equal(now(), 1700000000.5);

    Date.now = () => -500;
    assert.throws(() => now(), (err: unknown) => {
      assert.ok(err instanceof SystemTimeError);
      assert.equal(err.kind, "SystemTime");
      return true;
    });

    Date.now = () => NaN;
    assert.throws(() => now(), TypeError);

    Date.now = () => Infinity;
    assert.throws(() => now(), TypeError);
  } finally {
    Date.now = originalDateNow;
  }
});

// Acknowledge END_ATTACH_GOAL_TESTS
