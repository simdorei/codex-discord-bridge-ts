import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { I64_MAX, I64_MIN } from "../../src/protocol/ids.ts";
import { holdIn, reasonIn } from "../../src/store/execution-hold.ts";
import { userOriginMarker } from "../../src/store/mirror-origin.ts";
import { getIn, type Identity } from "../../src/store/new-reply-read.ts";
import { openInitialized } from "../../src/store/owned-driver.ts";
import {
  DeadGenerationTargetHeldError,
  markRunning,
  QueueJobNotFoundError,
  SystemTimeError,
} from "../../src/store/queue-mark-running.ts";
import { selectJob } from "../../src/store/queue-read.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";

const NEW_REPLY_SQL = `CREATE TABLE IF NOT EXISTS codex_new_first_replies (
            job_id TEXT PRIMARY KEY, ingress_id TEXT NOT NULL UNIQUE,
            identity_json TEXT NOT NULL, turn_id TEXT, accepted_at REAL,
            state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','verified','review_required')),
            version INTEGER NOT NULL DEFAULT 1, scan_json TEXT NOT NULL DEFAULT '{}',
            last_error TEXT NOT NULL DEFAULT '', confirmation_delivered INTEGER NOT NULL DEFAULT 0,
            warning_due INTEGER NOT NULL DEFAULT 0, checked_at REAL NOT NULL DEFAULT 0,
            ack_recovery_allowed INTEGER NOT NULL DEFAULT 0);
         CREATE INDEX IF NOT EXISTS codex_new_first_replies_pending
            ON codex_new_first_replies(checked_at,job_id);`;

function serializeIdentity(overrides: Partial<Identity> = {}): string {
  const full = {
    ingress_id: "ing-default",
    job_id: "job-default",
    thread_id: "thread-default",
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

async function fixture(
  run: (path: string, db: DatabaseSync) => Promise<void>,
): Promise<void> {
  const root = resolve(realpathSync(tmpdir()));
  const dir = mkdtempSync(join(root, "cdr-ts-queue-mark-running-"));
  const path = join(dir, "store.sqlite");
  const db = await openInitialized(path);
  db.exec(NEW_REPLY_SQL);
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

function insertJob(
  db: DatabaseSync,
  jobId: string,
  options: {
    targetThreadId?: string;
    channelId?: bigint;
    ownerUserId?: bigint | null;
    discordMessageId?: bigint | null;
    appServerGeneration?: bigint;
    executionGeneration?: bigint | null;
    turnObservationGeneration?: bigint | null;
    goalWaiting?: number | boolean;
    prompt?: string;
    queued?: number | boolean;
    ackSent?: number | boolean;
    state?: string;
    attemptCount?: bigint;
    turnId?: string | null;
    baselineTurnIds?: string;
    lastError?: string;
    createdAt?: number;
    updatedAt?: number;
  } = {},
): void {
  const stmt = db.prepare(`
    INSERT INTO codex_turn_queue (
      job_id, target_thread_id, channel_id, owner_user_id, discord_message_id,
      app_server_generation, execution_generation, turn_observation_generation,
      goal_waiting, prompt, queued, ack_sent, state, attempt_count,
      turn_id, baseline_turn_ids, last_error, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )
  `);
  stmt.run(
    jobId,
    options.targetThreadId ?? "target-default",
    options.channelId ?? 5n,
    options.ownerUserId !== undefined ? options.ownerUserId : 7n,
    options.discordMessageId !== undefined ? options.discordMessageId : null,
    options.appServerGeneration ?? 1n,
    options.executionGeneration !== undefined ? options.executionGeneration : null,
    options.turnObservationGeneration !== undefined
      ? options.turnObservationGeneration
      : null,
    options.goalWaiting !== undefined ? (options.goalWaiting ? 1 : 0) : 1,
    options.prompt ?? "test prompt",
    options.queued !== undefined ? (options.queued ? 1 : 0) : 1,
    options.ackSent !== undefined ? (options.ackSent ? 1 : 0) : 0,
    options.state ?? "pending",
    options.attemptCount ?? 0n,
    options.turnId !== undefined ? options.turnId : null,
    options.baselineTurnIds ?? "[]",
    options.lastError ?? "",
    options.createdAt ?? 100,
    options.updatedAt ?? 100,
  );
}

function insertNewReply(
  db: DatabaseSync,
  jobId: string,
  ingressId: string,
  identityJson: string,
  turnId: string | null = null,
  version = 1n,
  acceptedAt: number | null = null,
): void {
  const stmt = db.prepare(`
    INSERT INTO codex_new_first_replies (
      job_id, ingress_id, identity_json, turn_id, accepted_at, version
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(jobId, ingressId, identityJson, turnId, acceptedAt, version);
}

test("strict input types, lone surrogates, and i64 bounds validated before accessing database file", async () => {
  const root = resolve(realpathSync(tmpdir()));
  const dir = mkdtempSync(join(root, "cdr-ts-queue-mark-running-"));
  const loneSurrogate = String.fromCharCode(0xd800);

  try {
    await assert.rejects(
      () => markRunning(123 as unknown as string, "job", "turn", 1n),
      { name: "TypeError", message: "Invalid database path: expected well-formed string" },
    );
    await assert.rejects(
      () => markRunning(join(dir, `bad-path-${loneSurrogate}`), "job", "turn", 1n),
      { name: "TypeError", message: "Invalid database path: expected well-formed string" },
    );

    await assert.rejects(
      () => markRunning(join(dir, "test.sqlite"), null as unknown as string, "turn", 1n),
      { name: "TypeError", message: "Invalid job id: expected well-formed string" },
    );
    await assert.rejects(
      () => markRunning(join(dir, "test.sqlite"), `bad-job-${loneSurrogate}`, "turn", 1n),
      { name: "TypeError", message: "Invalid job id: expected well-formed string" },
    );

    await assert.rejects(
      () => markRunning(join(dir, "test.sqlite"), "job", undefined as unknown as string, 1n),
      { name: "TypeError", message: "Invalid turn id: expected well-formed string" },
    );
    await assert.rejects(
      () => markRunning(join(dir, "test.sqlite"), "job", `bad-turn-${loneSurrogate}`, 1n),
      { name: "TypeError", message: "Invalid turn id: expected well-formed string" },
    );

    await assert.rejects(
      () => markRunning(join(dir, "test.sqlite"), "job", "turn", 1 as unknown as bigint),
      { name: "TypeError", message: "Invalid generation: expected bigint" },
    );
    await assert.rejects(
      () => markRunning(join(dir, "test.sqlite"), "job", "turn", "1" as unknown as bigint),
      { name: "TypeError", message: "Invalid generation: expected bigint" },
    );

    await assert.rejects(
      () => markRunning(join(dir, "test.sqlite"), "job", "turn", I64_MAX + 1n),
      { name: "RangeError" },
    );
    await assert.rejects(
      () => markRunning(join(dir, "test.sqlite"), "job", "turn", I64_MIN - 1n),
      { name: "RangeError" },
    );

    assert.equal(existsSync(join(dir, "test.sqlite")), false);
    assert.equal(existsSync(join(dir, `bad-path-${loneSurrogate}`)), false);
  } finally {
    const actual = resolve(realpathSync(dir));
    assert.equal(actual.toLowerCase(), resolve(dir).toLowerCase());
    assert.equal(dirname(actual).toLowerCase(), root.toLowerCase());
    rmSync(actual, { recursive: true, force: true });
  }
});

test("full snapshot: transitions pending job to running and preserves attempt, error, baseline, and historical execution", async () => {
  await fixture(async (path, db) => {
    insertJob(db, "job-pending", {
      targetThreadId: "thread-pending",
      channelId: 10n,
      ownerUserId: 20n,
      discordMessageId: null,
      appServerGeneration: 7n,
      executionGeneration: 99n,
      turnObservationGeneration: 2n,
      goalWaiting: 1,
      prompt: "preserve prompt content",
      queued: 1,
      ackSent: 1,
      state: "pending",
      attemptCount: 3n,
      turnId: null,
      baselineTurnIds: JSON.stringify(["base-1", "base-2"]),
      lastError: "prior historical error",
      createdAt: 50,
      updatedAt: 50,
    });

    const job = await markRunning(path, "job-pending", "turn-new-1", 7n);

    assert.equal(job.jobId, "job-pending");
    assert.equal(job.targetThreadId, "thread-pending");
    assert.equal(job.channelId, 10n);
    assert.equal(job.ownerUserId, 20n);
    assert.equal(job.discordMessageId, null);
    assert.equal(job.appServerGeneration, 7n);
    assert.equal(job.executionGeneration, 99n);
    assert.equal(job.turnObservationGeneration, 7n);
    assert.equal(job.goalWaiting, false);
    assert.equal(job.prompt, "preserve prompt content");
    assert.equal(job.queued, true);
    assert.equal(job.ackSent, true);
    assert.equal(job.state, "Running");
    assert.equal(job.attemptCount, 3n);
    assert.equal(job.turnId, "turn-new-1");
    assert.deepEqual(job.baselineTurnIds, ["base-1", "base-2"]);
    assert.equal(job.lastError, "prior historical error");
    assert.equal(job.createdAt, 50);
    assert.ok(job.updatedAt > 50);

    const persisted = selectJob(db, "job-pending");
    assert.deepEqual(persisted, job);
  });
});

test("full snapshot: transitions starting and already running jobs into running compatibly", async () => {
  await fixture(async (path, db) => {
    insertJob(db, "job-starting", {
      state: "starting",
      appServerGeneration: 4n,
      executionGeneration: 12n,
      turnObservationGeneration: 1n,
      goalWaiting: 1,
      attemptCount: 1n,
      lastError: "starting error",
      baselineTurnIds: JSON.stringify(["prev-t"]),
      turnId: "starting-turn",
      createdAt: 10,
      updatedAt: 20,
    });

    const resStarting = await markRunning(path, "job-starting", "turn-start-next", 4n);
    assert.equal(resStarting.state, "Running");
    assert.equal(resStarting.turnId, "turn-start-next");
    assert.equal(resStarting.turnObservationGeneration, 4n);
    assert.equal(resStarting.goalWaiting, false);
    assert.equal(resStarting.executionGeneration, 12n);
    assert.equal(resStarting.attemptCount, 1n);
    assert.equal(resStarting.lastError, "starting error");
    assert.deepEqual(resStarting.baselineTurnIds, ["prev-t"]);

    insertJob(db, "job-running", {
      state: "running",
      appServerGeneration: 9n,
      turnObservationGeneration: 3n,
      goalWaiting: 1,
      turnId: "prior-turn",
      createdAt: 10,
      updatedAt: 20,
    });

    const resRunning = await markRunning(path, "job-running", "turn-run-next", 9n);
    assert.equal(resRunning.state, "Running");
    assert.equal(resRunning.turnId, "turn-run-next");
    assert.equal(resRunning.turnObservationGeneration, 9n);
    assert.equal(resRunning.goalWaiting, false);
  });
});

test("guard order: execution hold check executes FIRST vs missing job and clock is never called", async () => {
  await fixture(async (path, db) => {
    holdIn(db, "held-missing", "thread-x", "manual hold reason", "{}");
    assert.equal(reasonIn(db, "held-missing"), "manual hold reason");

    let clockCalls = 0;
    const origNow = Date.now;
    Date.now = () => {
      clockCalls++;
      return 1700000000000;
    };
    try {
      await assert.rejects(
        () => markRunning(path, "held-missing", "turn-1", 1n),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.ok((err as Error).message.includes("manual hold reason"));
          return true;
        },
      );
      assert.equal(clockCalls, 0);
    } finally {
      Date.now = origNow;
    }
  });
});

test("guard order: execution hold check executes FIRST vs dead-generation hold and clock is never called", async () => {
  await fixture(async (path, db) => {
    insertJob(db, "job-held-and-dead", {
      targetThreadId: "thread-dead",
      appServerGeneration: 1n,
    });
    db.prepare(
      "INSERT INTO codex_dead_generation_holds (target_thread_id, runtime_id, generation, created_at) VALUES ('thread-dead', 'rt-1', 1, 0)",
    ).run();
    holdIn(db, "job-held-and-dead", "thread-dead", "supervening execution hold", "{}");

    let clockCalls = 0;
    const origNow = Date.now;
    Date.now = () => {
      clockCalls++;
      return 1700000000000;
    };
    try {
      await assert.rejects(
        () => markRunning(path, "job-held-and-dead", "turn-1", 1n),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          assert.ok((err as Error).message.includes("supervening execution hold"));
          return true;
        },
      );
      assert.equal(clockCalls, 0);
    } finally {
      Date.now = origNow;
    }
  });
});

test("guard order: missing job throws QueueJobNotFoundError with clock call count 0", async () => {
  await fixture(async (path) => {
    let clockCalls = 0;
    const origNow = Date.now;
    Date.now = () => {
      clockCalls++;
      return 1700000000000;
    };
    try {
      await assert.rejects(
        () => markRunning(path, "nonexistent-job", "turn-1", 1n),
        (err: unknown) => {
          assert.ok(err instanceof QueueJobNotFoundError);
          assert.equal(
            (err as QueueJobNotFoundError).message,
            "durable queue job not found: nonexistent-job",
          );
          return true;
        },
      );
      assert.equal(clockCalls, 0);
    } finally {
      Date.now = origNow;
    }
  });
});

test("guard order: held target or sealed runtime for original gen 7 requested 8 throws DeadGenerationTargetHeldError with clock call count 0", async () => {
  await fixture(async (path, db) => {
    insertJob(db, "job-gen7-target-held", {
      targetThreadId: "thread-target-held",
      appServerGeneration: 7n,
    });
    db.prepare(
      "INSERT INTO codex_dead_generation_holds (target_thread_id, runtime_id, generation, created_at) VALUES ('thread-target-held', 'rt-1', 7, 0)",
    ).run();

    let clockCalls = 0;
    const origNow = Date.now;
    Date.now = () => {
      clockCalls++;
      return 1700000000000;
    };
    try {
      await assert.rejects(
        () => markRunning(path, "job-gen7-target-held", "turn-1", 8n),
        (err: unknown) => {
          assert.ok(err instanceof DeadGenerationTargetHeldError);
          assert.equal((err as DeadGenerationTargetHeldError).targetThreadId, "thread-target-held");
          assert.equal((err as DeadGenerationTargetHeldError).kind, "DeadGenerationTargetHeld");
          return true;
        },
      );
      assert.equal(clockCalls, 0);
    } finally {
      Date.now = origNow;
    }

    insertJob(db, "job-gen7-runtime-sealed", {
      targetThreadId: "thread-runtime-sealed",
      appServerGeneration: 7n,
    });
    db.prepare(
      "INSERT OR REPLACE INTO codex_app_server_runtime (singleton, runtime_id) VALUES (1, 'rt-singleton')",
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO codex_dead_generation_incidents (runtime_id, generation, snapshot_json, queue_jobs_json, created_at) VALUES ('rt-singleton', 7, '{}', '[]', 0)",
    ).run();

    clockCalls = 0;
    Date.now = () => {
      clockCalls++;
      return 1700000000000;
    };
    try {
      await assert.rejects(
        () => markRunning(path, "job-gen7-runtime-sealed", "turn-1", 8n),
        (err: unknown) => {
          assert.ok(err instanceof DeadGenerationTargetHeldError);
          assert.equal((err as DeadGenerationTargetHeldError).targetThreadId, "thread-runtime-sealed");
          return true;
        },
      );
      assert.equal(clockCalls, 0);
    } finally {
      Date.now = origNow;
    }
  });
});

test("guard order: sealed requested 8 only (not original 7) progresses past dead check to UPDATE and throws QueueJobNotFoundError with clock call count 1", async () => {
  await fixture(async (path, db) => {
    insertJob(db, "job-orig7-unsealed", {
      targetThreadId: "thread-unsealed",
      appServerGeneration: 7n,
    });
    db.prepare(
      "INSERT OR REPLACE INTO codex_app_server_runtime (singleton, runtime_id) VALUES (1, 'rt-singleton')",
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO codex_dead_generation_incidents (runtime_id, generation, snapshot_json, queue_jobs_json, created_at) VALUES ('rt-singleton', 8, '{}', '[]', 0)",
    ).run();

    let clockCalls = 0;
    const origNow = Date.now;
    Date.now = () => {
      clockCalls++;
      return 1700000000000;
    };
    try {
      await assert.rejects(
        () => markRunning(path, "job-orig7-unsealed", "turn-1", 8n),
        (err: unknown) => {
          assert.ok(err instanceof QueueJobNotFoundError);
          assert.equal(
            (err as QueueJobNotFoundError).message,
            "durable queue job not found: job-orig7-unsealed",
          );
          return true;
        },
      );
      assert.equal(clockCalls, 1);
    } finally {
      Date.now = origNow;
    }
  });
});

test("clock: single finite capture sets updatedAt and negative / non-finite timestamps roll back snapshot", async () => {
  await fixture(async (path, db) => {
    insertJob(db, "job-single-capture", { appServerGeneration: 1n });
    let clockCalls = 0;
    const origNow = Date.now;
    Date.now = () => {
      clockCalls++;
      return 1650000000000;
    };
    try {
      const res = await markRunning(path, "job-single-capture", "turn-sc", 1n);
      assert.equal(clockCalls, 1);
      assert.equal(res.updatedAt, 1650000000);
    } finally {
      Date.now = origNow;
    }

    insertJob(db, "job-neg-clock", {
      appServerGeneration: 1n,
      state: "pending",
      updatedAt: 100,
    });
    Date.now = () => -650;
    try {
      await assert.rejects(
        () => markRunning(path, "job-neg-clock", "turn-neg", 1n),
        (err: unknown) => {
          assert.ok(err instanceof SystemTimeError);
          assert.equal((err as SystemTimeError).kind, "SystemTime");
          assert.equal((err as SystemTimeError).gapMs, 650);
          assert.equal((err as SystemTimeError).message, "system clock is before the Unix epoch: 650ms");
          return true;
        },
      );
      const persisted = selectJob(db, "job-neg-clock");
      assert.equal(persisted.state, "Pending");
      assert.equal(persisted.turnId, null);
      assert.equal(persisted.updatedAt, 100);
    } finally {
      Date.now = origNow;
    }

    insertJob(db, "job-nan-clock", {
      appServerGeneration: 1n,
      state: "pending",
      updatedAt: 100,
    });
    Date.now = () => NaN;
    try {
      await assert.rejects(
        () => markRunning(path, "job-nan-clock", "turn-nan", 1n),
        {
          name: "TypeError",
          message: "system clock must be finite",
        },
      );
      const persisted = selectJob(db, "job-nan-clock");
      assert.equal(persisted.state, "Pending");
      assert.equal(persisted.turnId, null);
      assert.equal(persisted.updatedAt, 100);
    } finally {
      Date.now = origNow;
    }
  });
});

test("clock: mismatch generation clock error wins over UPDATE mismatch", async () => {
  await fixture(async (path, db) => {
    insertJob(db, "job-gen-mismatch-clock", { appServerGeneration: 1n });
    const origNow = Date.now;
    Date.now = () => -1234;
    try {
      await assert.rejects(
        () => markRunning(path, "job-gen-mismatch-clock", "turn-1", 2n),
        (err: unknown) => {
          assert.ok(err instanceof SystemTimeError);
          assert.equal((err as SystemTimeError).gapMs, 1234);
          return true;
        },
      );
    } finally {
      Date.now = origNow;
    }
  });
});

test("native boundaries: empty, NUL, BOM, supplementary Unicode, and signed i64 boundaries", async () => {
  await fixture(async (path, db) => {
    insertJob(db, "", { appServerGeneration: 1n });
    const emptyRes = await markRunning(path, "", "", 1n);
    assert.equal(emptyRes.jobId, "");
    assert.equal(emptyRes.turnId, "");

    insertJob(db, "job\0nul", { appServerGeneration: 1n });
    const nulRes = await markRunning(path, "job\0nul", "turn\0nul", 1n);
    assert.equal(nulRes.jobId, "job\0nul");
    assert.equal(nulRes.turnId, "turn\0nul");

    insertJob(db, "\uFEFFjob-bom", { appServerGeneration: 1n });
    const bomRes = await markRunning(path, "\uFEFFjob-bom", "\uFEFFturn-bom", 1n);
    assert.equal(bomRes.jobId, "\uFEFFjob-bom");
    assert.equal(bomRes.turnId, "\uFEFFturn-bom");

    insertJob(db, "job-🚀-🌟", { appServerGeneration: 1n });
    const astroRes = await markRunning(path, "job-🚀-🌟", "turn-💬-🎯", 1n);
    assert.equal(astroRes.jobId, "job-🚀-🌟");
    assert.equal(astroRes.turnId, "turn-💬-🎯");

    insertJob(db, "job-neg-gen", { appServerGeneration: -50n });
    const negGenRes = await markRunning(path, "job-neg-gen", "turn-neg", -50n);
    assert.equal(negGenRes.appServerGeneration, -50n);
    assert.equal(negGenRes.turnObservationGeneration, -50n);

    insertJob(db, "job-i64-min", { appServerGeneration: I64_MIN });
    const minRes = await markRunning(path, "job-i64-min", "turn-min", I64_MIN);
    assert.equal(minRes.appServerGeneration, I64_MIN);
    assert.equal(minRes.turnObservationGeneration, I64_MIN);

    insertJob(db, "job-i64-max", { appServerGeneration: I64_MAX });
    const maxRes = await markRunning(path, "job-i64-max", "turn-max", I64_MAX);
    assert.equal(maxRes.appServerGeneration, I64_MAX);
    assert.equal(maxRes.turnObservationGeneration, I64_MAX);
  });
});

test("reply binding and mirror origin: binds valid new reply and records mirror origin independently", async () => {
  await fixture(async (path, db) => {
    insertJob(db, "job-reply-valid", {
      targetThreadId: "thread-valid",
      channelId: 1000n,
      prompt: "test mirror prompt",
      appServerGeneration: 1n,
    });
    const identityJson = serializeIdentity({
      job_id: "job-reply-valid",
      thread_id: "thread-valid",
      channel_id: 1000n,
    });
    insertNewReply(db, "job-reply-valid", "ing-valid", identityJson, null, 1n);

    const job = await markRunning(path, "job-reply-valid", "turn-v1", 1n);

    const reply = getIn(db, "job-reply-valid");
    assert.ok(reply !== null);
    assert.equal(reply.turnId, "turn-v1");
    assert.equal(reply.acceptedAt, job.updatedAt);
    assert.equal(reply.version, 2n);

    const stmt = db.prepare(
      "SELECT event_digest, codex_thread_id, created_at FROM codex_session_mirror_events WHERE codex_thread_id = ?",
    );
    stmt.setReadBigInts(true);
    const rows = stmt.all("thread-valid") as Array<{
      event_digest: string;
      codex_thread_id: string;
      created_at: number;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0]!.event_digest,
      userOriginMarker("thread-valid", "turn-v1", "test mirror prompt"),
    );
    assert.equal(rows[0]!.created_at, job.updatedAt);
  });
});

test("reply binding and mirror origin: missing reply still records origin, already bound reply is nop while origin recorded", async () => {
  await fixture(async (path, db) => {
    insertJob(db, "job-missing-reply", {
      targetThreadId: "thread-missing-reply",
      channelId: 1000n,
      prompt: "missing reply prompt",
      appServerGeneration: 1n,
    });
    const resMissing = await markRunning(path, "job-missing-reply", "turn-m1", 1n);
    assert.equal(getIn(db, "job-missing-reply"), null);

    const stmtMissing = db.prepare(
      "SELECT event_digest FROM codex_session_mirror_events WHERE codex_thread_id = ?",
    );
    stmtMissing.setReadBigInts(true);
    const rowsMissing = stmtMissing.all("thread-missing-reply") as Array<{ event_digest: string }>;
    assert.equal(rowsMissing.length, 1);
    assert.equal(
      rowsMissing[0]!.event_digest,
      userOriginMarker("thread-missing-reply", "turn-m1", "missing reply prompt"),
    );

    insertJob(db, "job-already-bound", {
      targetThreadId: "thread-already-bound",
      channelId: 1000n,
      prompt: "already bound prompt",
      appServerGeneration: 1n,
    });
    const boundIdentity = serializeIdentity({
      job_id: "job-already-bound",
      thread_id: "thread-already-bound",
      channel_id: 1000n,
    });
    insertNewReply(
      db,
      "job-already-bound",
      "ing-bound",
      boundIdentity,
      "prebound-turn",
      5n,
      88.5,
    );

    await markRunning(path, "job-already-bound", "turn-b2", 1n);
    const replyBound = getIn(db, "job-already-bound");
    assert.ok(replyBound !== null);
    assert.equal(replyBound.turnId, "prebound-turn");
    assert.equal(replyBound.version, 5n);
    assert.equal(replyBound.acceptedAt, 88.5);

    const stmtBound = db.prepare(
      "SELECT event_digest FROM codex_session_mirror_events WHERE codex_thread_id = ?",
    );
    stmtBound.setReadBigInts(true);
    const rowsBound = stmtBound.all("thread-already-bound") as Array<{ event_digest: string }>;
    assert.equal(rowsBound.length, 1);
    assert.equal(
      rowsBound[0]!.event_digest,
      userOriginMarker("thread-already-bound", "turn-b2", "already bound prompt"),
    );
  });
});

test("reply binding: identity destination mismatch rolls back queue, reply, and mirror tables", async () => {
  await fixture(async (path, db) => {
    insertJob(db, "job-dest-mismatch", {
      targetThreadId: "thread-queue-actual",
      channelId: 1000n,
      prompt: "mismatch prompt",
      appServerGeneration: 1n,
      state: "pending",
    });
    const mismatchIdentity = serializeIdentity({
      job_id: "job-dest-mismatch",
      thread_id: "thread-foreign-destination",
      channel_id: 1000n,
    });
    insertNewReply(db, "job-dest-mismatch", "ing-mis", mismatchIdentity, null, 1n);

    await assert.rejects(
      () => markRunning(path, "job-dest-mismatch", "turn-mis", 1n),
      (err: unknown) => {
        assert.ok(err instanceof StoreIntegrityError);
        assert.equal(
          (err as Error).message,
          "SQLite integrity check failed: new first-turn binding changed its destination",
        );
        return true;
      },
    );

    const queueJob = selectJob(db, "job-dest-mismatch");
    assert.equal(queueJob.state, "Pending");
    assert.equal(queueJob.turnId, null);

    const reply = getIn(db, "job-dest-mismatch");
    assert.ok(reply !== null);
    assert.equal(reply.turnId, null);
    assert.equal(reply.version, 1n);

    const stmtMirror = db.prepare("SELECT COUNT(*) AS count FROM codex_session_mirror_events");
    stmtMirror.setReadBigInts(true);
    const mirrorCount = stmtMirror.get() as { count: bigint };
    assert.equal(mirrorCount.count, 0n);
  });
});

test("triggers: reply UPDATE abort and mirror INSERT abort preserve all 3 tables", async () => {
  await fixture(async (path, db) => {
    db.exec(`
      CREATE TRIGGER abort_reply_update BEFORE UPDATE ON codex_new_first_replies
      BEGIN
        SELECT RAISE(ABORT, 'reply update prohibited');
      END;
    `);

    insertJob(db, "job-abort-reply", {
      targetThreadId: "thread-abort-reply",
      channelId: 1000n,
      appServerGeneration: 1n,
      state: "pending",
    });
    const idJson1 = serializeIdentity({
      job_id: "job-abort-reply",
      thread_id: "thread-abort-reply",
      channel_id: 1000n,
    });
    insertNewReply(db, "job-abort-reply", "ing-ar", idJson1, null, 1n);

    await assert.rejects(
      () => markRunning(path, "job-abort-reply", "turn-ar", 1n),
      /reply update prohibited/,
    );

    assert.equal(selectJob(db, "job-abort-reply").state, "Pending");
    assert.equal(selectJob(db, "job-abort-reply").turnId, null);
    assert.equal(getIn(db, "job-abort-reply")!.turnId, null);
    assert.equal(getIn(db, "job-abort-reply")!.version, 1n);

    db.exec("DROP TRIGGER abort_reply_update;");
    db.exec(`
      CREATE TRIGGER abort_mirror_insert BEFORE INSERT ON codex_session_mirror_events
      BEGIN
        SELECT RAISE(ABORT, 'mirror insert prohibited');
      END;
    `);

    insertJob(db, "job-abort-mirror", {
      targetThreadId: "thread-abort-mirror",
      channelId: 1000n,
      appServerGeneration: 1n,
      state: "pending",
    });
    const idJson2 = serializeIdentity({
      job_id: "job-abort-mirror",
      thread_id: "thread-abort-mirror",
      channel_id: 1000n,
    });
    insertNewReply(db, "job-abort-mirror", "ing-am", idJson2, null, 1n);

    await assert.rejects(
      () => markRunning(path, "job-abort-mirror", "turn-am", 1n),
      /mirror insert prohibited/,
    );

    assert.equal(selectJob(db, "job-abort-mirror").state, "Pending");
    assert.equal(selectJob(db, "job-abort-mirror").turnId, null);
    assert.equal(getIn(db, "job-abort-mirror")!.turnId, null);
    assert.equal(getIn(db, "job-abort-mirror")!.version, 1n);

    const stmtMirror = db.prepare("SELECT COUNT(*) AS count FROM codex_session_mirror_events");
    stmtMirror.setReadBigInts(true);
    assert.equal((stmtMirror.get() as { count: bigint }).count, 0n);
  });
});

test("triggers: AFTER UPDATE trigger makes job Starting with nonnull turn -> bind nop but origin still called", async () => {
  await fixture(async (path, db) => {
    db.exec(`
      CREATE TRIGGER trigger_make_starting AFTER UPDATE ON codex_turn_queue
      BEGIN
        UPDATE codex_turn_queue SET state = 'starting' WHERE job_id = NEW.job_id;
      END;
    `);

    insertJob(db, "job-trig-starting", {
      targetThreadId: "thread-trig-start",
      channelId: 1000n,
      prompt: "trig start prompt",
      appServerGeneration: 1n,
      state: "pending",
    });
    const idJson = serializeIdentity({
      job_id: "job-trig-starting",
      thread_id: "thread-trig-start",
      channel_id: 1000n,
    });
    insertNewReply(db, "job-trig-starting", "ing-ts", idJson, null, 1n);

    const job = await markRunning(path, "job-trig-starting", "turn-ts-1", 1n);
    assert.equal(job.state, "Starting");

    const reply = getIn(db, "job-trig-starting");
    assert.ok(reply !== null);
    assert.equal(reply.turnId, null);
    assert.equal(reply.version, 1n);

    const stmt = db.prepare(
      "SELECT event_digest FROM codex_session_mirror_events WHERE codex_thread_id = ?",
    );
    stmt.setReadBigInts(true);
    const rows = stmt.all("thread-trig-start") as Array<{ event_digest: string }>;
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0]!.event_digest,
      userOriginMarker("thread-trig-start", job.turnId!, "trig start prompt"),
    );
  });
});

test("native triggers and decoding: IGNORE causes QueueNotFound, ABORT passes native error, and corrupted baseline rolls back", async () => {
  await fixture(async (path, db) => {
    db.exec(`
      CREATE TRIGGER trigger_ignore BEFORE UPDATE ON codex_turn_queue
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    insertJob(db, "job-ignore-upd", { appServerGeneration: 1n });
    await assert.rejects(
      () => markRunning(path, "job-ignore-upd", "turn-ign", 1n),
      (err: unknown) => {
        assert.ok(err instanceof QueueJobNotFoundError);
        assert.equal(
          (err as QueueJobNotFoundError).message,
          "durable queue job not found: job-ignore-upd",
        );
        return true;
      },
    );

    db.exec("DROP TRIGGER trigger_ignore;");
    db.exec(`
      CREATE TRIGGER trigger_abort BEFORE UPDATE ON codex_turn_queue
      BEGIN
        SELECT RAISE(ABORT, 'native update aborted by trigger');
      END;
    `);
    insertJob(db, "job-abort-native", { appServerGeneration: 1n });
    await assert.rejects(
      () => markRunning(path, "job-abort-native", "turn-ab", 1n),
      /native update aborted by trigger/,
    );

    db.exec("DROP TRIGGER trigger_abort;");
    db.exec(`
      CREATE TRIGGER trigger_corrupt_baseline AFTER UPDATE ON codex_turn_queue
      BEGIN
        UPDATE codex_turn_queue SET baseline_turn_ids = '{invalid_json' WHERE job_id = NEW.job_id;
      END;
    `);
    insertJob(db, "job-corrupt-baseline", {
      appServerGeneration: 1n,
      state: "pending",
      baselineTurnIds: "[]",
    });
    await assert.rejects(() => markRunning(path, "job-corrupt-baseline", "turn-cb", 1n));

    const persisted = selectJob(db, "job-corrupt-baseline");
    assert.equal(persisted.state, "Pending");
    assert.deepEqual(persisted.baselineTurnIds, []);
  });
});
