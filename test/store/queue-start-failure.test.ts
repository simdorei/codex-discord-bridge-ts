import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { test } from "node:test";
import { openInitialized } from "../../src/store/owned-driver.ts";
import {
  selectJob,
  allJobs,
  StoreIntegrityError,
  type StoredQueueJob,
} from "../../src/store/queue-read.ts";
import {
  recordStartFailure,
  DeadGenerationTargetHeldError,
  SystemTimeError,
  QueueJobNotFoundError,
} from "../../src/store/queue-start-failure.ts";
import { holdIn, reasonIn } from "../../src/store/execution-hold.ts";
import { I64_MAX, I64_MIN } from "../../src/protocol/ids.ts";

// Explicit note on timestamp precision: JavaScript Date.now() operates at millisecond precision (nowMs / 1000).
// There is an explicit millisecond precision gap; there is no universal binary64 / Rust nanosecond parity.

async function fixture(
  run: (path: string, db: DatabaseSync) => Promise<void>,
): Promise<void> {
  const root = resolve(realpathSync(tmpdir()));
  const dir = mkdtempSync(join(root, "cdr-ts-queue-start-failure-"));
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

interface InsertJobOptions {
  jobId: string;
  targetThreadId?: string;
  channelId?: bigint;
  ownerUserId?: bigint | null;
  discordMessageId?: bigint | null;
  appServerGeneration?: bigint;
  executionGeneration?: bigint | null;
  prompt?: string;
  queued?: number;
  ackSent?: number;
  state?: string;
  attemptCount?: bigint;
  turnId?: string | null;
  baselineTurnIds?: string;
  lastError?: string;
  createdAt?: number;
  updatedAt?: number;
  goalWaiting?: number;
  turnObservationGeneration?: bigint | null;
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

async function withMockClock<T>(
  now: number | (() => number),
  action: (getCalls: () => number) => Promise<T>,
): Promise<T> {
  const originalDateNow = Date.now;
  let calls = 0;
  Date.now = () => {
    calls++;
    if (typeof now === "function") {
      return now();
    }
    return now;
  };
  try {
    return await action(() => calls);
  } finally {
    Date.now = originalDateNow;
  }
}

test("full snapshot Running, Starting, and Pending accepted; ambiguous true->Starting, false->Pending; only state, error, time change", async () => {
  await fixture(async (path, db) => {
    const fullJob: InsertJobOptions = {
      jobId: "job-full-snap",
      targetThreadId: "thread-full-snap",
      channelId: 987654321012345678n,
      ownerUserId: 123456789012345678n,
      discordMessageId: 888888888888888888n,
      appServerGeneration: 111111111111111111n,
      executionGeneration: 222222222222222222n,
      turnObservationGeneration: 333333333333333333n,
      goalWaiting: 1,
      prompt: "original prompt with unicode 🚀 and \n newline",
      queued: 1,
      ackSent: 1,
      state: "running",
      attemptCount: 42n,
      turnId: "turn-orig-123",
      baselineTurnIds: '["base-1", "base-2"]',
      lastError: "old error",
      createdAt: 1700000000.125,
      updatedAt: 1700000000.125,
    };
    insertJob(db, fullJob);

    const original = selectJob(db, fullJob.jobId);
    assert.equal(original.state, "Running");

    const snapStarting = await withMockClock(1700000100500, async () => {
      return await recordStartFailure(
        path,
        fullJob.jobId,
        fullJob.appServerGeneration!,
        "  new start error  ",
        true,
      );
    });

    assert.equal(snapStarting.state, "Starting");
    assert.equal(snapStarting.lastError, "new start error");
    assert.equal(snapStarting.updatedAt, 1700000100.5);

    assert.equal(snapStarting.jobId, original.jobId);
    assert.equal(snapStarting.targetThreadId, original.targetThreadId);
    assert.equal(snapStarting.channelId, original.channelId);
    assert.equal(snapStarting.ownerUserId, original.ownerUserId);
    assert.equal(snapStarting.discordMessageId, original.discordMessageId);
    assert.equal(snapStarting.appServerGeneration, original.appServerGeneration);
    assert.equal(snapStarting.executionGeneration, original.executionGeneration);
    assert.equal(
      snapStarting.turnObservationGeneration,
      original.turnObservationGeneration,
    );
    assert.equal(snapStarting.goalWaiting, original.goalWaiting);
    assert.equal(snapStarting.prompt, original.prompt);
    assert.equal(snapStarting.queued, original.queued);
    assert.equal(snapStarting.ackSent, original.ackSent);
    assert.equal(snapStarting.attemptCount, original.attemptCount);
    assert.equal(snapStarting.turnId, original.turnId);
    assert.deepEqual(snapStarting.baselineTurnIds, original.baselineTurnIds);
    assert.equal(snapStarting.createdAt, original.createdAt);

    const snapPending = await withMockClock(1700000200250, async () => {
      return await recordStartFailure(
        path,
        fullJob.jobId,
        fullJob.appServerGeneration!,
        "pending failure",
        false,
      );
    });

    assert.equal(snapPending.state, "Pending");
    assert.equal(snapPending.lastError, "pending failure");
    assert.equal(snapPending.updatedAt, 1700000200.25);
    assert.equal(snapPending.executionGeneration, original.executionGeneration);
    assert.equal(
      snapPending.turnObservationGeneration,
      original.turnObservationGeneration,
    );
    assert.equal(snapPending.turnId, original.turnId);
    assert.deepEqual(snapPending.baselineTurnIds, original.baselineTurnIds);
    assert.equal(snapPending.attemptCount, original.attemptCount);
    assert.equal(snapPending.goalWaiting, original.goalWaiting);

    insertJob(db, {
      jobId: "job-initial-pending",
      state: "pending",
      appServerGeneration: 1n,
    });
    const fromPendingToStarting = await withMockClock(1700000300000, async () => {
      return await recordStartFailure(
        path,
        "job-initial-pending",
        1n,
        "err",
        true,
      );
    });
    assert.equal(fromPendingToStarting.state, "Starting");

    const fromPendingToPending = await withMockClock(1700000400000, async () => {
      return await recordStartFailure(
        path,
        "job-initial-pending",
        1n,
        "err2",
        false,
      );
    });
    assert.equal(fromPendingToPending.state, "Pending");
  });
});

test("matching held target and joined runtime original sealed gen throw DeadGenerationTargetHeldError with clock 0; missing select throws QueueJobNotFoundError with clock 0", async () => {
  await fixture(async (path, db) => {
    insertJob(db, {
      jobId: "job-target-held",
      targetThreadId: "held-target-thread",
      appServerGeneration: 1n,
    });
    db.prepare(
      "INSERT INTO codex_dead_generation_holds (target_thread_id, runtime_id, generation, created_at) VALUES ('held-target-thread', 'runtime-1', 1, 100.0)",
    ).run();

    await withMockClock(
      () => {
        throw new Error("Clock must not be called on held target");
      },
      async (getCalls) => {
        await assert.rejects(
          () =>
            recordStartFailure(
              path,
              "job-target-held",
              1n,
              "start err",
              false,
            ),
          (err: unknown) => {
            assert.ok(err instanceof DeadGenerationTargetHeldError);
            assert.equal(err.kind, "DeadGenerationTargetHeld");
            assert.equal(err.targetThreadId, "held-target-thread");
            return true;
          },
        );
        assert.equal(getCalls(), 0);
      },
    );

    db.prepare(
      "INSERT INTO codex_app_server_runtime (singleton, runtime_id) VALUES (1, 'runtime-seal-test')",
    ).run();
    db.prepare(
      "INSERT INTO codex_dead_generation_incidents (runtime_id, generation, snapshot_json, queue_jobs_json, created_at) VALUES ('runtime-seal-test', 5, '{}', '[]', 200.0)",
    ).run();

    insertJob(db, {
      jobId: "job-sealed-5",
      targetThreadId: "thread-sealed-5",
      appServerGeneration: 5n,
    });

    await withMockClock(
      () => {
        throw new Error("Clock must not be called on sealed generation");
      },
      async (getCalls) => {
        await assert.rejects(
          () =>
            recordStartFailure(path, "job-sealed-5", 5n, "start err", false),
          (err: unknown) => {
            assert.ok(err instanceof DeadGenerationTargetHeldError);
            assert.equal(err.kind, "DeadGenerationTargetHeld");
            assert.equal(err.targetThreadId, "thread-sealed-5");
            return true;
          },
        );
        assert.equal(getCalls(), 0);
      },
    );

    await withMockClock(
      () => {
        throw new Error("Clock must not be called on missing job select");
      },
      async (getCalls) => {
        await assert.rejects(
          () =>
            recordStartFailure(
              path,
              "completely-missing-job",
              1n,
              "err",
              false,
            ),
          (err: unknown) => {
            assert.ok(err instanceof QueueJobNotFoundError);
            assert.equal(err.kind, "QueueJobNotFound");
            return true;
          },
        );
        assert.equal(getCalls(), 0);
      },
    );
  });
});

test("wrong requested gen clock 1 then QueueJobNotFoundError unless original sealed first; explicit joined runtime with original gen 7 requested 8 vs seal 8 not original 7 proves original guard", async () => {
  await fixture(async (path, db) => {
    insertJob(db, {
      jobId: "job-unsealed-unheld",
      targetThreadId: "thread-unsealed",
      appServerGeneration: 10n,
    });

    await withMockClock(123456000, async (getCalls) => {
      await assert.rejects(
        () =>
          recordStartFailure(
            path,
            "job-unsealed-unheld",
            99n,
            "err",
            false,
          ),
        (err: unknown) => {
          assert.ok(err instanceof QueueJobNotFoundError);
          assert.equal(err.kind, "QueueJobNotFound");
          return true;
        },
      );
      assert.equal(getCalls(), 1);
    });

    db.prepare(
      "INSERT INTO codex_app_server_runtime (singleton, runtime_id) VALUES (1, 'rt-proof')",
    ).run();
    db.prepare(
      "INSERT INTO codex_dead_generation_incidents (runtime_id, generation, snapshot_json, queue_jobs_json, created_at) VALUES ('rt-proof', 7, '{}', '[]', 10.0)",
    ).run();

    insertJob(db, {
      jobId: "job-orig-7",
      targetThreadId: "thread-orig-7",
      appServerGeneration: 7n,
    });

    await withMockClock(
      () => {
        throw new Error("Clock must not be called when original gen is sealed");
      },
      async (getCalls) => {
        await assert.rejects(
          () =>
            recordStartFailure(path, "job-orig-7", 8n, "start err", false),
          (err: unknown) => {
            assert.ok(err instanceof DeadGenerationTargetHeldError);
            assert.equal(err.kind, "DeadGenerationTargetHeld");
            assert.equal(err.targetThreadId, "thread-orig-7");
            return true;
          },
        );
        assert.equal(getCalls(), 0);
      },
    );
  });

  await fixture(async (path, db) => {
    db.prepare(
      "INSERT INTO codex_app_server_runtime (singleton, runtime_id) VALUES (1, 'rt-proof-2')",
    ).run();
    db.prepare(
      "INSERT INTO codex_dead_generation_incidents (runtime_id, generation, snapshot_json, queue_jobs_json, created_at) VALUES ('rt-proof-2', 8, '{}', '[]', 20.0)",
    ).run();

    insertJob(db, {
      jobId: "job-orig-7-unsealed",
      targetThreadId: "thread-orig-7-unsealed",
      appServerGeneration: 7n,
      state: "running",
      lastError: "prior error",
    });

    await withMockClock(123456000, async (getCalls) => {
      await assert.rejects(
        () =>
          recordStartFailure(
            path,
            "job-orig-7-unsealed",
            8n,
            "err",
            false,
          ),
        (err: unknown) => {
          assert.ok(err instanceof QueueJobNotFoundError);
          assert.equal(err.kind, "QueueJobNotFound");
          return true;
        },
      );
      assert.equal(getCalls(), 1);
    });

    await withMockClock(123456789, async (getCalls) => {
      const successful = await recordStartFailure(
        path,
        "job-orig-7-unsealed",
        7n,
        "success err",
        false,
      );
      assert.equal(successful.state, "Pending");
      assert.equal(successful.lastError, "success err");
      assert.equal(successful.updatedAt, 123456.789);
      assert.equal(getCalls(), 1);
    });
  });
});

test("Executionhold table row MUST not block this compat leaf; bind/origin tables unaffected", async () => {
  await fixture(async (path, db) => {
    insertJob(db, {
      jobId: "job-exec-held",
      targetThreadId: "thread-exec-held",
      appServerGeneration: 1n,
      state: "running",
      lastError: "init",
    });

    holdIn(
      db,
      "job-exec-held",
      "thread-exec-held",
      "execution-hold-reason",
      "{}",
    );
    assert.equal(reasonIn(db, "job-exec-held"), "execution-hold-reason");

    const mirrorEventsBefore = db
      .prepare("SELECT * FROM codex_session_mirror_events")
      .all();
    const firstRepliesBefore = db
      .prepare("SELECT * FROM codex_new_first_replies")
      .all();
    assert.equal(mirrorEventsBefore.length, 0);
    assert.equal(firstRepliesBefore.length, 0);

    const res = await recordStartFailure(
      path,
      "job-exec-held",
      1n,
      "execution hold should not block",
      false,
    );
    assert.equal(res.state, "Pending");
    assert.equal(res.lastError, "execution hold should not block");

    assert.equal(reasonIn(db, "job-exec-held"), "execution-hold-reason");

    const mirrorEventsAfter = db
      .prepare("SELECT * FROM codex_session_mirror_events")
      .all();
    const firstRepliesAfter = db
      .prepare("SELECT * FROM codex_new_first_replies")
      .all();
    assert.deepEqual(mirrorEventsAfter, mirrorEventsBefore);
    assert.deepEqual(firstRepliesAfter, firstRepliesBefore);
  });
});

test("Integrated Rust whitespace NEL/BOM trim and 1000 scalar bounding with astral plane characters; empty/NUL/supplementary job IDs, signed i64 extrema/negative gen allowed", async () => {
  await fixture(async (path, db) => {
    const prefix = "\u0085\t \r\n\u00A0\u1680\u2000\u2028\u2029\u202F\u205F\u3000";
    const suffix = "\u3000\u205F\u202F\u2029\u2028\u200A\u1680\u00A0\r\n \t\u0085";
    const wsError = `${prefix}trimmed content${suffix}`;

    insertJob(db, { jobId: "job-ws", appServerGeneration: 1n });
    const resWs = await recordStartFailure(path, "job-ws", 1n, wsError, false);
    assert.equal(resWs.lastError, "trimmed content");

    insertJob(db, { jobId: "job-all-ws", appServerGeneration: 1n });
    const resAllWs = await recordStartFailure(
      path,
      "job-all-ws",
      1n,
      "\u0085 \t\r\n\u3000\u00A0",
      false,
    );
    assert.equal(resAllWs.lastError, "");

    insertJob(db, { jobId: "job-bom", appServerGeneration: 1n });
    const bomError = "\uFEFFerror text\uFEFF";
    const resBom = await recordStartFailure(path, "job-bom", 1n, bomError, false);
    assert.equal(resBom.lastError, "\uFEFFerror text\uFEFF");

    insertJob(db, { jobId: "job-bom-ws", appServerGeneration: 1n });
    const bomWithWs = "\u0085  \uFEFFerror\uFEFF  \u0085";
    const resBomWs = await recordStartFailure(
      path,
      "job-bom-ws",
      1n,
      bomWithWs,
      false,
    );
    assert.equal(resBomWs.lastError, "\uFEFFerror\uFEFF");

    const astral1050 = "\u{1F389}".repeat(1050);
    const errorAstral = `\u0085  ${astral1050}  \u3000`;
    insertJob(db, { jobId: "job-astral", appServerGeneration: 1n });
    const resAstral = await recordStartFailure(
      path,
      "job-astral",
      1n,
      errorAstral,
      false,
    );
    assert.equal(Array.from(resAstral.lastError).length, 1000);
    assert.equal(resAstral.lastError, "\u{1F389}".repeat(1000));

    insertJob(db, { jobId: "", appServerGeneration: 1n });
    const resEmpty = await recordStartFailure(path, "", 1n, "empty-id-err", true);
    assert.equal(resEmpty.jobId, "");
    assert.equal(resEmpty.state, "Starting");

    insertJob(db, { jobId: "job\0with\0nul", appServerGeneration: 1n });
    const resNul = await recordStartFailure(
      path,
      "job\0with\0nul",
      1n,
      "nul-err",
      false,
    );
    assert.equal(resNul.jobId, "job\0with\0nul");
    assert.equal(resNul.state, "Pending");

    insertJob(db, { jobId: "job_🚀_turn", appServerGeneration: 1n });
    const resSupp = await recordStartFailure(
      path,
      "job_🚀_turn",
      1n,
      "supp-err",
      true,
    );
    assert.equal(resSupp.jobId, "job_🚀_turn");
    assert.equal(resSupp.state, "Starting");

    insertJob(db, { jobId: "job-i64min", appServerGeneration: I64_MIN });
    const resMin = await recordStartFailure(
      path,
      "job-i64min",
      I64_MIN,
      "min-err",
      false,
    );
    assert.equal(resMin.appServerGeneration, I64_MIN);

    insertJob(db, { jobId: "job-i64max", appServerGeneration: I64_MAX });
    const resMax = await recordStartFailure(
      path,
      "job-i64max",
      I64_MAX,
      "max-err",
      true,
    );
    assert.equal(resMax.appServerGeneration, I64_MAX);

    insertJob(db, { jobId: "job-neg-gen", appServerGeneration: -42n });
    const resNeg = await recordStartFailure(
      path,
      "job-neg-gen",
      -42n,
      "neg-err",
      false,
    );
    assert.equal(resNeg.appServerGeneration, -42n);
  });
});

test("strict input scalar, lone surrogate, and boolean invalid reject before file without object coercion", async () => {
  const root = resolve(realpathSync(tmpdir()));
  const dir = mkdtempSync(join(root, "cdr-ts-queue-start-failure-input-"));
  const nonExistentPath = join(dir, "store.sqlite");
  try {
    let pathToStringCalls = 0;
    let jobToStringCalls = 0;
    let genValueOfCalls = 0;
    let errToStringCalls = 0;
    let ambiguousValueOfCalls = 0;

    await assert.rejects(
      () => recordStartFailure(123 as unknown as string, "job", 1n, "err", false),
      /Invalid path: expected well-formed string/,
    );
    await assert.rejects(
      () =>
        recordStartFailure(
          {
            toString: () => {
              pathToStringCalls++;
              return "path";
            },
          } as unknown as string,
          "job",
          1n,
          "err",
          false,
        ),
      /Invalid path: expected well-formed string/,
    );
    await assert.rejects(
      () => recordStartFailure(join(dir, "path_\uD800"), "job", 1n, "err", false),
      /Invalid path: expected well-formed string/,
    );

    await assert.rejects(
      () => recordStartFailure(nonExistentPath, null as unknown as string, 1n, "err", false),
      /Invalid jobId: expected well-formed string/,
    );
    await assert.rejects(
      () => recordStartFailure(nonExistentPath, 123 as unknown as string, 1n, "err", false),
      /Invalid jobId: expected well-formed string/,
    );
    await assert.rejects(
      () =>
        recordStartFailure(
          nonExistentPath,
          {
            toString: () => {
              jobToStringCalls++;
              return "job";
            },
          } as unknown as string,
          1n,
          "err",
          false,
        ),
      /Invalid jobId: expected well-formed string/,
    );
    await assert.rejects(
      () => recordStartFailure(nonExistentPath, "job_\uD800", 1n, "err", false),
      /Invalid jobId: expected well-formed string/,
    );

    await assert.rejects(
      () =>
        recordStartFailure(
          nonExistentPath,
          "job",
          123 as unknown as bigint,
          "err",
          false,
        ),
      /Invalid generation: expected bigint/,
    );
    await assert.rejects(
      () =>
        recordStartFailure(
          nonExistentPath,
          "job",
          "1" as unknown as bigint,
          "err",
          false,
        ),
      /Invalid generation: expected bigint/,
    );
    await assert.rejects(
      () =>
        recordStartFailure(
          nonExistentPath,
          "job",
          {
            valueOf: () => {
              genValueOfCalls++;
              return 1n;
            },
          } as unknown as bigint,
          "err",
          false,
        ),
      /Invalid generation: expected bigint/,
    );
    await assert.rejects(
      () =>
        recordStartFailure(
          nonExistentPath,
          "job",
          I64_MAX + 1n,
          "err",
          false,
        ),
      /Generation out of signed i64 range/,
    );
    await assert.rejects(
      () =>
        recordStartFailure(
          nonExistentPath,
          "job",
          I64_MIN - 1n,
          "err",
          false,
        ),
      /Generation out of signed i64 range/,
    );

    await assert.rejects(
      () =>
        recordStartFailure(
          nonExistentPath,
          "job",
          1n,
          null as unknown as string,
          false,
        ),
      /Invalid error: expected well-formed string/,
    );
    await assert.rejects(
      () =>
        recordStartFailure(
          nonExistentPath,
          "job",
          1n,
          500 as unknown as string,
          false,
        ),
      /Invalid error: expected well-formed string/,
    );
    await assert.rejects(
      () =>
        recordStartFailure(
          nonExistentPath,
          "job",
          1n,
          {
            toString: () => {
              errToStringCalls++;
              return "err";
            },
          } as unknown as string,
          false,
        ),
      /Invalid error: expected well-formed string/,
    );
    await assert.rejects(
      () => recordStartFailure(nonExistentPath, "job", 1n, "err_\uD800", false),
      /Invalid error: expected well-formed string/,
    );

    await assert.rejects(
      () =>
        recordStartFailure(
          nonExistentPath,
          "job",
          1n,
          "err",
          1 as unknown as boolean,
        ),
      /Invalid ambiguous: expected boolean/,
    );
    await assert.rejects(
      () =>
        recordStartFailure(
          nonExistentPath,
          "job",
          1n,
          "err",
          "true" as unknown as boolean,
        ),
      /Invalid ambiguous: expected boolean/,
    );
    await assert.rejects(
      () =>
        recordStartFailure(
          nonExistentPath,
          "job",
          1n,
          "err",
          null as unknown as boolean,
        ),
      /Invalid ambiguous: expected boolean/,
    );
    await assert.rejects(
      () =>
        recordStartFailure(
          nonExistentPath,
          "job",
          1n,
          "err",
          {
            valueOf: () => {
              ambiguousValueOfCalls++;
              return true;
            },
          } as unknown as boolean,
        ),
      /Invalid ambiguous: expected boolean/,
    );

    assert.equal(existsSync(nonExistentPath), false);
    assert.equal(pathToStringCalls, 0);
    assert.equal(jobToStringCalls, 0);
    assert.equal(genValueOfCalls, 0);
    assert.equal(errToStringCalls, 0);
    assert.equal(ambiguousValueOfCalls, 0);
  } finally {
    const actual = resolve(realpathSync(dir));
    assert.equal(actual.toLowerCase(), resolve(dir).toLowerCase());
    assert.equal(dirname(actual).toLowerCase(), root.toLowerCase());
    rmSync(actual, { recursive: true, force: true });
  }
});

test("Clock: single positive ms to seconds conversion with counter 1; negative ms throws SystemTimeError and rolls back; non-finite throws TypeError and rolls back", async () => {
  await fixture(async (path, db) => {
    insertJob(db, {
      jobId: "job-clock-1",
      appServerGeneration: 1n,
      state: "running",
      lastError: "orig error",
      updatedAt: 50.0,
    });

    await withMockClock(123456789, async (getCalls) => {
      const updated = await recordStartFailure(
        path,
        "job-clock-1",
        1n,
        "failure error",
        false,
      );
      assert.equal(updated.updatedAt, 123456.789);
      assert.equal(getCalls(), 1);
    });

    insertJob(db, {
      jobId: "job-clock-neg",
      appServerGeneration: 1n,
      state: "running",
      lastError: "neg orig",
      updatedAt: 50.0,
    });

    await withMockClock(-1, async (getCalls) => {
      await assert.rejects(
        () =>
          recordStartFailure(path, "job-clock-neg", 1n, "neg failure", false),
        (err: unknown) => {
          assert.ok(err instanceof SystemTimeError);
          assert.equal(err.kind, "SystemTime");
          assert.match(
            err.message,
            /system clock is before the Unix epoch: second time provided was later than self/,
          );
          return true;
        },
      );
      assert.equal(getCalls(), 1);
      const unchanged = selectJob(db, "job-clock-neg");
      assert.equal(unchanged.state, "Running");
      assert.equal(unchanged.lastError, "neg orig");
      assert.equal(unchanged.updatedAt, 50.0);
    });

    insertJob(db, {
      jobId: "job-clock-nan",
      appServerGeneration: 1n,
      state: "running",
      lastError: "nan orig",
      updatedAt: 50.0,
    });

    await withMockClock(NaN, async (getCalls) => {
      await assert.rejects(
        () =>
          recordStartFailure(path, "job-clock-nan", 1n, "nan failure", false),
        (err: unknown) => {
          assert.ok(err instanceof TypeError);
          assert.match(err.message, /system clock must be finite/);
          return true;
        },
      );
      assert.equal(getCalls(), 1);
      const unchanged = selectJob(db, "job-clock-nan");
      assert.equal(unchanged.state, "Running");
      assert.equal(unchanged.lastError, "nan orig");
      assert.equal(unchanged.updatedAt, 50.0);
    });

    await withMockClock(Infinity, async (getCalls) => {
      await assert.rejects(
        () =>
          recordStartFailure(path, "job-clock-nan", 1n, "inf failure", false),
        (err: unknown) => {
          assert.ok(err instanceof TypeError);
          assert.match(err.message, /system clock must be finite/);
          return true;
        },
      );
      assert.equal(getCalls(), 1);
      const unchanged = selectJob(db, "job-clock-nan");
      assert.equal(unchanged.state, "Running");
      assert.equal(unchanged.lastError, "nan orig");
      assert.equal(unchanged.updatedAt, 50.0);
    });
  });
});

test("Native IGNORE changes 0 -> QueueJobNotFoundError (NOT null); ABORT native rollback; AFTER UPDATE malformed baseline decode fail rollback", async () => {
  await fixture(async (path, db) => {
    db.exec(`
      CREATE TRIGGER trigger_ignore_update
      BEFORE UPDATE ON codex_turn_queue
      WHEN NEW.job_id = 'job-ignore'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);

    insertJob(db, {
      jobId: "job-ignore",
      appServerGeneration: 1n,
      state: "running",
      lastError: "prior",
    });

    await assert.rejects(
      () => recordStartFailure(path, "job-ignore", 1n, "err", true),
      (err: unknown) => {
        assert.ok(err instanceof QueueJobNotFoundError);
        assert.equal(err.kind, "QueueJobNotFound");
        assert.equal(
          err.message,
          "durable queue job not found: job-ignore",
        );
        return true;
      },
    );
    const current = selectJob(db, "job-ignore");
    assert.equal(current.state, "Running");
    assert.equal(current.lastError, "prior");

    db.exec(`
      CREATE TRIGGER trigger_abort_update
      BEFORE UPDATE ON codex_turn_queue
      WHEN NEW.job_id = 'job-abort'
      BEGIN
        SELECT RAISE(ABORT, 'custom-native-abort-msg');
      END;
    `);

    insertJob(db, {
      jobId: "job-abort",
      appServerGeneration: 1n,
      state: "running",
      lastError: "prior abort",
    });

    await assert.rejects(
      () => recordStartFailure(path, "job-abort", 1n, "err", true),
      /custom-native-abort-msg/,
    );
    const abortRow = selectJob(db, "job-abort");
    assert.equal(abortRow.state, "Running");
    assert.equal(abortRow.lastError, "prior abort");

    db.exec(`
      CREATE TRIGGER trigger_corrupt_baseline
      AFTER UPDATE ON codex_turn_queue
      WHEN NEW.job_id = 'job-corrupt-after'
      BEGIN
        UPDATE codex_turn_queue SET baseline_turn_ids = '{malformed json' WHERE job_id = NEW.job_id;
      END;
    `);

    insertJob(db, {
      jobId: "job-corrupt-after",
      appServerGeneration: 1n,
      state: "running",
      lastError: "prior corrupt",
      baselineTurnIds: '["turn-preserved"]',
    });

    await assert.rejects(
      () => recordStartFailure(path, "job-corrupt-after", 1n, "err", true),
      (err: unknown) => {
        assert.ok(err instanceof StoreIntegrityError);
        assert.match(
          err.message,
          /Failed to parse baseline_turn_ids JSON/,
        );
        return true;
      },
    );
    const corruptRow = selectJob(db, "job-corrupt-after");
    assert.equal(corruptRow.state, "Running");
    assert.equal(corruptRow.lastError, "prior corrupt");
    assert.deepEqual(corruptRow.baselineTurnIds, ["turn-preserved"]);
  });
});

test("Native integer read setReadBigInts(true) strict indexed narrow assert.ok, fresh migrations persist with discordMessageId default null", async () => {
  await fixture(async (path, db) => {
    insertJob(db, {
      jobId: "job-types-1",
      discordMessageId: null,
      channelId: 999999999999999999n,
      ownerUserId: 111111111111111111n,
      appServerGeneration: 222222222222222222n,
      executionGeneration: 333333333333333333n,
      turnObservationGeneration: 444444444444444444n,
      attemptCount: 15n,
      createdAt: 1600000000.5,
      updatedAt: 1600000000.5,
      queued: 1,
      ackSent: 1,
      goalWaiting: 0,
    });

    insertJob(db, {
      jobId: "job-types-2",
      discordMessageId: null,
      channelId: 888888888888888888n,
    });

    const jobs = allJobs(db);
    assert.equal(jobs.length, 2);

    const stmt = db.prepare(
      "SELECT channel_id, owner_user_id, discord_message_id, app_server_generation, execution_generation, turn_observation_generation, attempt_count, created_at, updated_at, queued, ack_sent, goal_waiting FROM codex_turn_queue WHERE job_id = ?",
    );
    stmt.setReadBigInts(true);
    const row = stmt.get("job-types-1") as Record<string, unknown> | undefined;
    assert.ok(row !== undefined);
    assert.strictEqual(typeof row.channel_id, "bigint");
    assert.strictEqual(typeof row.owner_user_id, "bigint");
    assert.strictEqual(row.discord_message_id, null);
    assert.strictEqual(typeof row.app_server_generation, "bigint");
    assert.strictEqual(typeof row.execution_generation, "bigint");
    assert.strictEqual(typeof row.turn_observation_generation, "bigint");
    assert.strictEqual(typeof row.attempt_count, "bigint");
    assert.strictEqual(typeof row.created_at, "number");
    assert.strictEqual(typeof row.updated_at, "number");
    assert.strictEqual(typeof row.queued, "bigint");
    assert.strictEqual(typeof row.ack_sent, "bigint");
    assert.strictEqual(typeof row.goal_waiting, "bigint");
  });
});

test("One writer lock then release and caller connection reuse", async () => {
  // Document: This test proves single-writer lock contention (SQLITE_BUSY/locked) while an external transaction is active,
  // followed by lock release and caller connection reuse. It does not prove a forced owned COMMIT or handle leak proof.
  await fixture(async (path, db) => {
    insertJob(db, {
      jobId: "job-concurrency",
      appServerGeneration: 1n,
      state: "running",
    });

    db.exec("BEGIN IMMEDIATE;");
    try {
      await assert.rejects(
        () =>
          recordStartFailure(path, "job-concurrency", 1n, "busy err", false),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /busy|locked/i);
          return true;
        },
      );
    } finally {
      db.exec("ROLLBACK;");
    }

    const updated = await recordStartFailure(
      path,
      "job-concurrency",
      1n,
      "recovered err",
      false,
    );
    assert.equal(updated.state, "Pending");
    assert.equal(updated.lastError, "recovered err");

    db.exec(
      "BEGIN IMMEDIATE; UPDATE codex_turn_queue SET ack_sent = 1 WHERE job_id = 'job-concurrency'; COMMIT;",
    );
    const verified = selectJob(db, "job-concurrency");
    assert.equal(verified.ackSent, true);
  });
});
