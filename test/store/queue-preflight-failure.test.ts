import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { I64_MAX, I64_MIN } from "../../src/protocol/ids.ts";
import { openInitialized } from "../../src/store/owned-driver.ts";
import {
  recordPreflightFailure,
  SystemTimeError,
  takeUnicodeScalarChars,
  trimUnicodeWhitespace,
} from "../../src/store/queue-preflight-failure.ts";
import { selectJob, type StoredQueueJob } from "../../src/store/queue-read.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";

async function fixture(
  run: (path: string, db: DatabaseSync) => Promise<void>,
): Promise<void> {
  const root = resolve(realpathSync(tmpdir()));
  const dir = mkdtempSync(join(root, "cdr-ts-queue-preflight-"));
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

interface InsertJobParams {
  jobId: string;
  targetThreadId?: string;
  channelId?: bigint;
  ownerUserId?: bigint | null;
  discordMessageId?: bigint | null;
  appServerGeneration?: bigint;
  executionGeneration?: bigint | null;
  turnObservationGeneration?: bigint | null;
  goalWaiting?: boolean;
  prompt?: string;
  queued?: boolean;
  ackSent?: boolean;
  state?: string;
  attemptCount?: bigint;
  turnId?: string | null;
  baselineTurnIds?: string;
  lastError?: string;
  createdAt?: number;
  updatedAt?: number;
}

function insertJob(db: DatabaseSync, params: InsertJobParams): void {
  const {
    jobId,
    targetThreadId = "target-thread-1",
    channelId = 1001n,
    ownerUserId = 2002n,
    discordMessageId = null,
    appServerGeneration = 1n,
    executionGeneration = null,
    turnObservationGeneration = null,
    goalWaiting = false,
    prompt = "sample prompt",
    queued = true,
    ackSent = false,
    state = "pending",
    attemptCount = 0n,
    turnId = null,
    baselineTurnIds = "[]",
    lastError = "",
    createdAt = 1000,
    updatedAt = 1000,
  } = params;

  db.prepare(
    `INSERT INTO codex_turn_queue (
      job_id, target_thread_id, channel_id, owner_user_id, discord_message_id,
      app_server_generation, execution_generation, turn_observation_generation,
      goal_waiting, prompt, queued, ack_sent, state, attempt_count, turn_id,
      baseline_turn_ids, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    targetThreadId,
    channelId,
    ownerUserId,
    discordMessageId,
    appServerGeneration,
    executionGeneration,
    turnObservationGeneration,
    goalWaiting ? 1 : 0,
    prompt,
    queued ? 1 : 0,
    ackSent ? 1 : 0,
    state,
    attemptCount,
    turnId,
    baselineTurnIds,
    lastError,
    createdAt,
    updatedAt,
  );
}

test("input domain: strict types and non-strings rejected before file creation without invoking toString", async () => {
  const root = resolve(realpathSync(tmpdir()));
  const dir = mkdtempSync(join(root, "cdr-ts-preflight-input-types-"));
  const nonExistentPath = join(dir, "never-created.sqlite");

  try {
    let toStringCalls = 0;
    const hostileObject = {
      toString(): string {
        toStringCalls++;
        throw new Error("hostile toString called");
      },
    };

    await assert.rejects(
      () =>
        recordPreflightFailure(
          hostileObject as unknown as string,
          "job-1",
          1n,
          "err",
        ),
      { name: "TypeError", message: "Invalid database path" },
    );
    assert.equal(toStringCalls, 0);
    assert.equal(existsSync(nonExistentPath), false);

    await assert.rejects(
      () =>
        recordPreflightFailure(
          123 as unknown as string,
          "job-1",
          1n,
          "err",
        ),
      { name: "TypeError", message: "Invalid database path" },
    );
    assert.equal(existsSync(nonExistentPath), false);

    await assert.rejects(
      () =>
        recordPreflightFailure(
          nonExistentPath,
          hostileObject as unknown as string,
          1n,
          "err",
        ),
      { name: "TypeError", message: "Invalid job id" },
    );
    assert.equal(toStringCalls, 0);
    assert.equal(existsSync(nonExistentPath), false);

    await assert.rejects(
      () =>
        recordPreflightFailure(
          nonExistentPath,
          null as unknown as string,
          1n,
          "err",
        ),
      { name: "TypeError", message: "Invalid job id" },
    );
    assert.equal(existsSync(nonExistentPath), false);

    await assert.rejects(
      () =>
        recordPreflightFailure(
          nonExistentPath,
          "job-1",
          hostileObject as unknown as bigint,
          "err",
        ),
      { name: "TypeError", message: "Invalid generation" },
    );
    assert.equal(toStringCalls, 0);
    assert.equal(existsSync(nonExistentPath), false);

    await assert.rejects(
      () =>
        recordPreflightFailure(
          nonExistentPath,
          "job-1",
          100 as unknown as bigint,
          "err",
        ),
      { name: "TypeError", message: "Invalid generation" },
    );
    assert.equal(existsSync(nonExistentPath), false);

    await assert.rejects(
      () =>
        recordPreflightFailure(
          nonExistentPath,
          "job-1",
          1n,
          hostileObject as unknown as string,
        ),
      { name: "TypeError", message: "Invalid error string" },
    );
    assert.equal(toStringCalls, 0);
    assert.equal(existsSync(nonExistentPath), false);

    await assert.rejects(
      () =>
        recordPreflightFailure(
          nonExistentPath,
          "job-1",
          1n,
          false as unknown as string,
        ),
      { name: "TypeError", message: "Invalid error string" },
    );
    assert.equal(existsSync(nonExistentPath), false);
  } finally {
    const actual = resolve(realpathSync(dir));
    assert.equal(actual.toLowerCase(), resolve(dir).toLowerCase());
    rmSync(actual, { recursive: true, force: true });
  }
});

test("input domain: signed i64 overflow for generation rejected before file creation", async () => {
  const root = resolve(realpathSync(tmpdir()));
  const dir = mkdtempSync(join(root, "cdr-ts-preflight-gen-overflow-"));
  const nonExistentPath = join(dir, "never-created.sqlite");

  try {
    await assert.rejects(
      () =>
        recordPreflightFailure(
          nonExistentPath,
          "job-1",
          I64_MAX + 1n,
          "err",
        ),
      {
        name: "RangeError",
        message: `generation out of signed i64 range: ${(I64_MAX + 1n).toString()}`,
      },
    );
    assert.equal(existsSync(nonExistentPath), false);

    await assert.rejects(
      () =>
        recordPreflightFailure(
          nonExistentPath,
          "job-1",
          I64_MIN - 1n,
          "err",
        ),
      {
        name: "RangeError",
        message: `generation out of signed i64 range: ${(I64_MIN - 1n).toString()}`,
      },
    );
    assert.equal(existsSync(nonExistentPath), false);
  } finally {
    const actual = resolve(realpathSync(dir));
    assert.equal(actual.toLowerCase(), resolve(dir).toLowerCase());
    rmSync(actual, { recursive: true, force: true });
  }
});

test("input domain: all lone-surrogate patterns including low+low rejected before file creation", async () => {
  const root = resolve(realpathSync(tmpdir()));
  const dir = mkdtempSync(join(root, "cdr-ts-preflight-surrogates-"));
  const nonExistentPath = join(dir, "never-created.sqlite");

  try {
    const badStrings = [
      "\uD800",
      "\uDBFF",
      "\uDC00",
      "\uDFFF",
      "prefix_\uD800",
      "\uDC00_suffix",
      "\uD800\uD800",
      "\uDC00\uDC00",
      "\uD800a",
      "a\uDC00b",
    ];

    for (const bad of badStrings) {
      const badPath = join(dir, `${bad}.sqlite`);
      await assert.rejects(
        () => recordPreflightFailure(badPath, "job-1", 1n, "err"),
        { name: "TypeError", message: "Invalid database path" },
      );
      assert.equal(existsSync(badPath), false);

      await assert.rejects(
        () => recordPreflightFailure(nonExistentPath, bad, 1n, "err"),
        { name: "TypeError", message: "Invalid job id" },
      );
      assert.equal(existsSync(nonExistentPath), false);

      await assert.rejects(
        () => recordPreflightFailure(nonExistentPath, "job-1", 1n, bad),
        { name: "TypeError", message: "Invalid error string" },
      );
      assert.equal(existsSync(nonExistentPath), false);
    }
  } finally {
    const actual = resolve(realpathSync(dir));
    assert.equal(actual.toLowerCase(), resolve(dir).toLowerCase());
    rmSync(actual, { recursive: true, force: true });
  }
});

test("trimUnicodeWhitespace: includes NEL0085, excludes FEFF, preserves internal whitespace", () => {
  assert.equal(trimUnicodeWhitespace("\u0085hello\u0085"), "hello");
  assert.equal(
    trimUnicodeWhitespace("\u0009\u000A\u000B\u000C\u000D\u0020\u0085\u00A0\u3000trimmed\u0085\u0020"),
    "trimmed",
  );
  assert.equal(trimUnicodeWhitespace("\uFEFFhello\uFEFF"), "\uFEFFhello\uFEFF");
  assert.equal(
    trimUnicodeWhitespace("  \uFEFFhello\uFEFF  "),
    "\uFEFFhello\uFEFF",
  );
  assert.equal(
    trimUnicodeWhitespace("  first \u0085 second \t third  "),
    "first \u0085 second \t third",
  );
  assert.equal(trimUnicodeWhitespace("   \u0085 \t \n  "), "");
  assert.equal(trimUnicodeWhitespace(""), "");
});

test("takeUnicodeScalarChars: truncates after 1000 unicode scalars, preserving surrogate emoji pairs", () => {
  const emoji1001 = "😀".repeat(1001);
  const scalars1000 = takeUnicodeScalarChars(emoji1001, 1000);
  assert.equal(Array.from(scalars1000).length, 1000);
  assert.equal(scalars1000.length, 2000);
  assert.equal(scalars1000, "😀".repeat(1000));

  const mixed = "\uFEFF" + "a".repeat(500) + "🎉".repeat(600);
  const mixedTruncated = takeUnicodeScalarChars(mixed, 1000);
  assert.equal(Array.from(mixedTruncated).length, 1000);
  assert.equal(
    mixedTruncated,
    "\uFEFF" + "a".repeat(500) + "🎉".repeat(499),
  );

  assert.equal(takeUnicodeScalarChars("", 1000), "");
  assert.equal(takeUnicodeScalarChars("short text", 1000), "short text");
});

test("full-row snapshot: matching pending job decodes row, increments attempt, updates lastError and timestamp only", async () => {
  await fixture(async (path, db) => {
    const originalNow = Date.now;
    let nowCalls = 0;
    try {
      Date.now = () => {
        nowCalls++;
        return 1700000000123;
      };

      insertJob(db, {
        jobId: "snapshot-job-1",
        targetThreadId: "target-thread-xyz",
        channelId: 9876543210123456n,
        ownerUserId: 1122334455667788n,
        discordMessageId: 9988776655443322n,
        appServerGeneration: 42n,
        executionGeneration: 101n,
        turnObservationGeneration: 202n,
        goalWaiting: true,
        prompt: "meaningful prompt text with \n and ' quotes",
        queued: true,
        ackSent: true,
        state: "pending",
        attemptCount: 15n,
        turnId: "turn-abc-123",
        baselineTurnIds: '["turn-prev-1","turn-prev-2"]',
        lastError: "old error message",
        createdAt: 1699999000.5,
        updatedAt: 1699999000.5,
      });

      const updated = await recordPreflightFailure(
        path,
        "snapshot-job-1",
        42n,
        "  \u0085 preflight dispatch error \u0085  ",
      );

      assert.ok(updated);
      assert.equal(nowCalls, 1);

      assert.equal(updated.jobId, "snapshot-job-1");
      assert.equal(updated.targetThreadId, "target-thread-xyz");
      assert.equal(updated.channelId, 9876543210123456n);
      assert.equal(updated.ownerUserId, 1122334455667788n);
      assert.equal(updated.discordMessageId, 9988776655443322n);
      assert.equal(updated.appServerGeneration, 42n);
      assert.equal(updated.executionGeneration, 101n);
      assert.equal(updated.turnObservationGeneration, 202n);
      assert.equal(updated.goalWaiting, true);
      assert.equal(
        updated.prompt,
        "meaningful prompt text with \n and ' quotes",
      );
      assert.equal(updated.queued, true);
      assert.equal(updated.ackSent, true);
      assert.equal(updated.state, "Pending");
      assert.equal(updated.turnId, "turn-abc-123");
      assert.deepEqual(updated.baselineTurnIds, ["turn-prev-1", "turn-prev-2"]);
      assert.equal(updated.createdAt, 1699999000.5);

      assert.equal(updated.attemptCount, 16n);
      assert.equal(updated.lastError, "preflight dispatch error");
      assert.equal(updated.updatedAt, 1700000000.123);

      const persisted = selectJob(db, "snapshot-job-1");
      assert.deepEqual(persisted, updated);
    } finally {
      Date.now = originalNow;
    }
  });
});
test("repeated increment and saturating max attempt count at signed i64 max", async () => {
  await fixture(async (path, db) => {
    insertJob(db, {
      jobId: "repeat-job",
      attemptCount: 0n,
      appServerGeneration: 1n,
    });
    insertJob(db, {
      jobId: "sat-job-1",
      attemptCount: I64_MAX - 1n,
      appServerGeneration: 1n,
    });
    insertJob(db, {
      jobId: "sat-job-2",
      attemptCount: I64_MAX,
      appServerGeneration: 1n,
    });

    const rep1 = await recordPreflightFailure(path, "repeat-job", 1n, "e1");
    assert.ok(rep1);
    assert.equal(rep1.attemptCount, 1n);

    const rep2 = await recordPreflightFailure(path, "repeat-job", 1n, "e2");
    assert.ok(rep2);
    assert.equal(rep2.attemptCount, 2n);

    const rep3 = await recordPreflightFailure(path, "repeat-job", 1n, "e3");
    assert.ok(rep3);
    assert.equal(rep3.attemptCount, 3n);

    const sat1 = await recordPreflightFailure(path, "sat-job-1", 1n, "sat-1");
    assert.ok(sat1);
    assert.equal(sat1.attemptCount, I64_MAX);

    const sat2 = await recordPreflightFailure(path, "sat-job-2", 1n, "sat-2");
    assert.ok(sat2);
    assert.equal(sat2.attemptCount, I64_MAX);
  });
});

test("boundary generations: min i64, max i64, negative generation all valid", async () => {
  await fixture(async (path, db) => {
    insertJob(db, {
      jobId: "min-gen-job",
      appServerGeneration: I64_MIN,
      state: "pending",
    });
    insertJob(db, {
      jobId: "max-gen-job",
      appServerGeneration: I64_MAX,
      state: "pending",
    });
    insertJob(db, {
      jobId: "neg-gen-job",
      appServerGeneration: -100n,
      state: "pending",
    });
    insertJob(db, {
      jobId: "zero-gen-job",
      appServerGeneration: 0n,
      state: "pending",
    });

    const minRes = await recordPreflightFailure(
      path,
      "min-gen-job",
      I64_MIN,
      "err",
    );
    assert.ok(minRes);
    assert.equal(minRes.appServerGeneration, I64_MIN);

    const maxRes = await recordPreflightFailure(
      path,
      "max-gen-job",
      I64_MAX,
      "err",
    );
    assert.ok(maxRes);
    assert.equal(maxRes.appServerGeneration, I64_MAX);

    const negRes = await recordPreflightFailure(
      path,
      "neg-gen-job",
      -100n,
      "err",
    );
    assert.ok(negRes);
    assert.equal(negRes.appServerGeneration, -100n);

    const zeroRes = await recordPreflightFailure(
      path,
      "zero-gen-job",
      0n,
      "err",
    );
    assert.ok(zeroRes);
    assert.equal(zeroRes.appServerGeneration, 0n);
  });
});

test("special job ids: empty string, NUL byte, BOM, and supplementary unicode characters", async () => {
  await fixture(async (path, db) => {
    const specialIds = [
      "",
      "job\0with\0nul",
      "\uFEFFjob_bom",
      "job_𐍈_𝄞_🚀",
    ];

    for (const specialId of specialIds) {
      insertJob(db, {
        jobId: specialId,
        state: "pending",
        appServerGeneration: 1n,
      });

      const result = await recordPreflightFailure(
        path,
        specialId,
        1n,
        "failure for special id",
      );
      assert.ok(result);
      assert.equal(result.jobId, specialId);
      assert.equal(result.lastError, "failure for special id");
      assert.equal(result.attemptCount, 1n);
    }
  });
});

test("Date.now sampling: positive 123456 then negative/NaN/±Infinity on second call verifies exactly one call", async () => {
  await fixture(async (path, db) => {
    insertJob(db, {
      jobId: "one-call-job",
      state: "pending",
      appServerGeneration: 1n,
    });

    const hostileSeconds = [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];

    for (const secondVal of hostileSeconds) {
      const originalNow = Date.now;
      let callCount = 0;
      try {
        Date.now = () => {
          callCount++;
          if (callCount === 1) {
            return 123456;
          }
          return secondVal;
        };

        const res = await recordPreflightFailure(
          path,
          "one-call-job",
          1n,
          "err",
        );
        assert.ok(res);
        assert.equal(res.updatedAt, 123.456);
        assert.equal(callCount, 1);
      } finally {
        Date.now = originalNow;
      }
    }
  });
});

test("clock validation: first negative throws SystemTimeError with name, kind, and prefix", async () => {
  await fixture(async (path, db) => {
    insertJob(db, {
      jobId: "clock-job",
      state: "pending",
      appServerGeneration: 1n,
    });

    const originalNow = Date.now;
    try {
      Date.now = () => -1;
      await assert.rejects(
        () => recordPreflightFailure(path, "clock-job", 1n, "err"),
        (err: unknown) => {
          assert.ok(err instanceof SystemTimeError);
          assert.equal(err.name, "SystemTimeError");
          assert.equal(err.kind, "SystemTime");
          assert.ok(
            err.message.startsWith(
              "system clock is before the Unix epoch: time is earlier than 1970-01-01T00:00:00Z",
            ),
          );
          return true;
        },
      );
    } finally {
      Date.now = originalNow;
    }
  });
});

test("clock validation: first non-finite throws TypeError", async () => {
  await fixture(async (path, db) => {
    insertJob(db, {
      jobId: "clock-job",
      state: "pending",
      appServerGeneration: 1n,
    });

    const badTimestamps = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];

    for (const bad of badTimestamps) {
      const originalNow = Date.now;
      try {
        Date.now = () => bad;
        await assert.rejects(
          () => recordPreflightFailure(path, "clock-job", 1n, "err"),
          {
            name: "TypeError",
            message: "system clock must be finite",
          },
        );
      } finally {
        Date.now = originalNow;
      }
    }
  });
});

test("clock validation: clock error wins before UPDATE even on missing, wrong generation, or non-pending job", async () => {
  await fixture(async (path, db) => {
    insertJob(db, {
      jobId: "wrong-gen-job",
      state: "pending",
      appServerGeneration: 10n,
    });
    insertJob(db, {
      jobId: "running-job",
      state: "running",
      appServerGeneration: 1n,
    });

    const testCases: Array<{ id: string; gen: bigint }> = [
      { id: "completely-missing-job", gen: 1n },
      { id: "wrong-gen-job", gen: 99n },
      { id: "running-job", gen: 1n },
    ];

    for (const tc of testCases) {
      const originalNow = Date.now;
      try {
        Date.now = () => -50;
        await assert.rejects(
          () => recordPreflightFailure(path, tc.id, tc.gen, "err"),
          (err: unknown) => {
            assert.ok(err instanceof SystemTimeError);
            assert.equal(err.name, "SystemTimeError");
            assert.equal(err.kind, "SystemTime");
            return true;
          },
        );

        Date.now = () => Number.NaN;
        await assert.rejects(
          () => recordPreflightFailure(path, tc.id, tc.gen, "err"),
          {
            name: "TypeError",
            message: "system clock must be finite",
          },
        );
      } finally {
        Date.now = originalNow;
      }
    }
  });
});

test("missing, wrong generation, and non-pending return null and sample clock without modifying rows", async () => {
  await fixture(async (path, db) => {
    insertJob(db, {
      jobId: "existing-job",
      state: "pending",
      appServerGeneration: 1n,
      attemptCount: 0n,
      lastError: "original",
      updatedAt: 500,
    });
    insertJob(db, {
      jobId: "running-job",
      state: "running",
      appServerGeneration: 1n,
      attemptCount: 2n,
      lastError: "running-err",
      updatedAt: 500,
    });
    insertJob(db, {
      jobId: "starting-job",
      state: "starting",
      appServerGeneration: 1n,
      attemptCount: 3n,
      lastError: "starting-err",
      updatedAt: 500,
    });

    const originalNow = Date.now;
    let clockSamples = 0;
    try {
      Date.now = () => {
        clockSamples++;
        return 1700000000000;
      };

      const missingRes = await recordPreflightFailure(
        path,
        "does-not-exist",
        1n,
        "err",
      );
      assert.equal(missingRes, null);

      const wrongGenRes = await recordPreflightFailure(
        path,
        "existing-job",
        999n,
        "err",
      );
      assert.equal(wrongGenRes, null);

      const runningRes = await recordPreflightFailure(
        path,
        "running-job",
        1n,
        "err",
      );
      assert.equal(runningRes, null);

      const startingRes = await recordPreflightFailure(
        path,
        "starting-job",
        1n,
        "err",
      );
      assert.equal(startingRes, null);

      assert.equal(clockSamples, 4);

      const intactExisting = selectJob(db, "existing-job");
      assert.equal(intactExisting.attemptCount, 0n);
      assert.equal(intactExisting.lastError, "original");
      assert.equal(intactExisting.updatedAt, 500);

      const intactRunning = selectJob(db, "running-job");
      assert.equal(intactRunning.attemptCount, 2n);
      assert.equal(intactRunning.lastError, "running-err");
      assert.equal(intactRunning.updatedAt, 500);
    } finally {
      Date.now = originalNow;
    }
  });
});

test("malformed unrelated row is ignored, while malformed matching baseline throws and rolls back UPDATE", async () => {
  await fixture(async (path, db) => {
    insertJob(db, {
      jobId: "healthy-job",
      state: "pending",
      appServerGeneration: 1n,
      attemptCount: 0n,
      lastError: "",
    });
    insertJob(db, {
      jobId: "unrelated-malformed",
      state: "pending",
      appServerGeneration: 1n,
      baselineTurnIds: "{malformed json",
    });

    const healthyRes = await recordPreflightFailure(
      path,
      "healthy-job",
      1n,
      "healthy error",
    );
    assert.ok(healthyRes);
    assert.equal(healthyRes.jobId, "healthy-job");
    assert.equal(healthyRes.lastError, "healthy error");
    assert.equal(healthyRes.attemptCount, 1n);

    insertJob(db, {
      jobId: "matching-malformed",
      state: "pending",
      appServerGeneration: 1n,
      attemptCount: 5n,
      lastError: "before-failure",
      baselineTurnIds: "{not valid json",
    });

    await assert.rejects(
      () =>
        recordPreflightFailure(
          path,
          "matching-malformed",
          1n,
          "will fail decode",
        ),
      StoreIntegrityError,
    );

    const rawStmt = db.prepare(
      "SELECT attempt_count, last_error FROM codex_turn_queue WHERE job_id = 'matching-malformed'",
    );
    rawStmt.setReadBigInts(true);
    const rawRow = rawStmt.get() as {
      attempt_count: bigint;
      last_error: string;
    };

    assert.equal(rawRow.attempt_count, 5n);
    assert.equal(rawRow.last_error, "before-failure");
  });
});

test("dead generation holds do not gate preflight failure recording and have no side effects", async () => {
  await fixture(async (path, db) => {
    insertJob(db, {
      jobId: "job-held",
      targetThreadId: "dead-thread",
      state: "pending",
      appServerGeneration: 1n,
    });
    db.prepare(
      "INSERT INTO codex_dead_generation_holds (target_thread_id, runtime_id, generation, created_at) VALUES (?, 'runtime', 1, 0)",
    ).run("dead-thread");

    const res = await recordPreflightFailure(
      path,
      "job-held",
      1n,
      "error despite hold",
    );
    assert.ok(res);
    assert.equal(res.jobId, "job-held");
    assert.equal(res.lastError, "error despite hold");
    assert.equal(res.attemptCount, 1n);

    const holdsStmt = db.prepare(
      "SELECT COUNT(*) AS n FROM codex_dead_generation_holds WHERE target_thread_id = 'dead-thread'",
    );
    holdsStmt.setReadBigInts(true);
    const holdsCount = (holdsStmt.get() as { n: bigint }).n;
    assert.equal(holdsCount, 1n);
  });
});

test("native triggers: BEFORE UPDATE IGNORE returns null, ABORT rolls back, AFTER UPDATE audit commits", async () => {
  await fixture(async (path, db) => {
    insertJob(db, {
      jobId: "trig-job",
      state: "pending",
      appServerGeneration: 1n,
      attemptCount: 0n,
      lastError: "initial",
    });

    db.exec(`
      CREATE TRIGGER trig_ignore_update
      BEFORE UPDATE ON codex_turn_queue
      WHEN NEW.last_error = 'trigger-ignore'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);

    const ignoredRes = await recordPreflightFailure(
      path,
      "trig-job",
      1n,
      "trigger-ignore",
    );
    assert.equal(ignoredRes, null);
    const jobAfterIgnore = selectJob(db, "trig-job");
    assert.equal(jobAfterIgnore.attemptCount, 0n);
    assert.equal(jobAfterIgnore.lastError, "initial");

    db.exec(`
      CREATE TRIGGER trig_abort_update
      BEFORE UPDATE ON codex_turn_queue
      WHEN NEW.last_error = 'trigger-abort'
      BEGIN
        SELECT RAISE(ABORT, 'custom trigger abort message');
      END;
    `);

    await assert.rejects(
      () => recordPreflightFailure(path, "trig-job", 1n, "trigger-abort"),
      /custom trigger abort message/,
    );
    const jobAfterAbort = selectJob(db, "trig-job");
    assert.equal(jobAfterAbort.attemptCount, 0n);
    assert.equal(jobAfterAbort.lastError, "initial");

    db.exec(`
      CREATE TABLE preflight_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        audited_job_id TEXT NOT NULL,
        audited_error TEXT NOT NULL,
        audited_attempt INTEGER NOT NULL
      );
      CREATE TRIGGER trig_audit_after_update
      AFTER UPDATE ON codex_turn_queue
      BEGIN
        INSERT INTO preflight_audit_log (audited_job_id, audited_error, audited_attempt)
        VALUES (NEW.job_id, NEW.last_error, NEW.attempt_count);
      END;
    `);

    const auditRes = await recordPreflightFailure(
      path,
      "trig-job",
      1n,
      "trigger-audit-ok",
    );
    assert.ok(auditRes);
    assert.equal(auditRes.attemptCount, 1n);
    assert.equal(auditRes.lastError, "trigger-audit-ok");

    const auditStmt = db.prepare("SELECT * FROM preflight_audit_log");
    auditStmt.setReadBigInts(true);
    const auditRows = auditStmt.all() as Array<{
      id: bigint;
      audited_job_id: string;
      audited_error: string;
      audited_attempt: bigint;
    }>;

    assert.equal(auditRows.length, 1);
    const firstAudit = auditRows[0];
    assert.ok(firstAudit);
    assert.equal(firstAudit.audited_job_id, "trig-job");
    assert.equal(firstAudit.audited_error, "trigger-audit-ok");
    assert.equal(firstAudit.audited_attempt, 1n);
  });
});

test("fresh non-existent database file runs migrations and persists tables", async () => {
  const root = resolve(realpathSync(tmpdir()));
  const dir = mkdtempSync(join(root, "cdr-ts-preflight-fresh-persist-"));
  const freshPath = join(dir, "fresh-store.sqlite");

  try {
    assert.equal(existsSync(freshPath), false);

    const result = await recordPreflightFailure(
      freshPath,
      "missing-in-fresh",
      1n,
      "some error",
    );
    assert.equal(result, null);
    assert.equal(existsSync(freshPath), true);

    const verifyDb = new DatabaseSync(freshPath);
    try {
      const stmt = verifyDb.prepare(
        "SELECT COUNT(*) AS n FROM codex_turn_queue",
      );
      stmt.setReadBigInts(true);
      const countRow = stmt.get() as { n: bigint };
      assert.equal(countRow.n, 0n);
    } finally {
      verifyDb.close();
    }
  } finally {
    const actual = resolve(realpathSync(dir));
    assert.equal(actual.toLowerCase(), resolve(dir).toLowerCase());
    rmSync(actual, { recursive: true, force: true });
  }
});

test("recordPreflightFailure: trims unicode whitespace including NEL, preserves BOM, and truncates to 1000 unicode scalars with surrogate emoji", async () => {
  await fixture(async (path, db) => {
    insertJob(db, {
      jobId: "emoji-bom-job",
      state: "pending",
      appServerGeneration: 1n,
      attemptCount: 0n,
    });

    const errorInput =
      "\u0085\u0020\uFEFF" + "😀".repeat(1001) + "\u0020\u0085";

    const updated = await recordPreflightFailure(
      path,
      "emoji-bom-job",
      1n,
      errorInput,
    );

    assert.ok(updated);
    assert.equal(updated.attemptCount, 1n);

    const expectedError = "\uFEFF" + "😀".repeat(999);
    assert.equal(updated.lastError, expectedError);
    assert.equal(Array.from(updated.lastError).length, 1000);
    assert.equal(updated.lastError.startsWith("\uFEFF"), true);
    assert.equal(updated.lastError.includes("\u0085"), false);

    const persisted = selectJob(db, "emoji-bom-job");
    assert.equal(persisted.lastError, expectedError);
    assert.equal(persisted.attemptCount, 1n);
  });
});

// END_PREFLIGHT_TESTS
