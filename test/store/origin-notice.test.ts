import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { types } from "node:util";

import { I64_MAX, I64_MIN } from "../../src/protocol/ids.ts";
import {
  isWellFormedUnicode as isWellFormedOrigin,
  recordJobOrigin,
  recordOrigin,
  recordUserOrigin,
  userOriginMarker,
} from "../../src/store/mirror-origin.ts";
import { openInitialized } from "../../src/store/owned-driver.ts";
import type { QueueJobState, StoredQueueJob } from "../../src/store/queue-read.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";
import {
  AUTO_RESERVE_HOLD_PREFIX,
  DOMAIN,
  EXECUTION_HOLD_PREFIX,
  HOLD_PREFIX,
  isWellFormedUnicode as isWellFormedNotice,
  stageIn,
  stageStartNoticeIn,
} from "../../src/store/start-notice-stage.ts";

function createMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_session_mirror_events (
      event_digest TEXT PRIMARY KEY,
      codex_thread_id TEXT NOT NULL,
      created_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS codex_reserve_start_notices (
      job_id TEXT PRIMARY KEY,
      target_thread_id TEXT NOT NULL,
      channel_id INTEGER NOT NULL,
      app_server_generation INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at REAL NOT NULL DEFAULT(unixepoch())
    );
  `);
  return db;
}

function createStoredQueueJob(overrides: Partial<StoredQueueJob> = {}): StoredQueueJob {
  const job: StoredQueueJob = {
    jobId: "job-test-001",
    targetThreadId: "thread-test-100",
    channelId: 9876543210123n,
    ownerUserId: 1234567890123n,
    discordMessageId: 5554443332221n,
    appServerGeneration: 1n,
    executionGeneration: 1n,
    turnObservationGeneration: 1n,
    goalWaiting: false,
    prompt: "Default test prompt string",
    queued: true,
    ackSent: true,
    state: "Pending",
    attemptCount: 0n,
    turnId: "turn-test-555",
    baselineTurnIds: ["turn-base-0"],
    lastError: "",
    createdAt: 1700000000.0,
    updatedAt: 1700000001.5,
  };
  return Object.assign(job, overrides);
}

function safeCleanupTempDir(tmpDir: string): void {
  const realTmp = fs.realpathSync(tmpDir);
  const realOsTmp = fs.realpathSync(os.tmpdir());
  const isWindows = process.platform === "win32";
  const normTmp = isWindows ? realTmp.toLowerCase() : realTmp;
  const normOsTmp = isWindows ? realOsTmp.toLowerCase() : realOsTmp;
  const baseName = path.basename(realTmp);

  if (!normTmp.startsWith(normOsTmp) || !baseName.startsWith("cdr-ts-origin-")) {
    throw new Error(`Refusing to remove directory outside expected temp prefix: ${tmpDir}`);
  }
  fs.rmSync(realTmp, { recursive: true, force: true });
}

describe("mirror origin contracts", () => {
  it("computes exact discord-user:v1 marker with lowercase SHA256 of trimmed UTF8", () => {
    const thread = "thread-alpha-1";
    const turn = "turn-omega-2";
    const prompt = "   Hello, Rust mirror contract!   \n\t";
    const trimmed = "Hello, Rust mirror contract!";
    const expectedHash = createHash("sha256").update(trimmed, "utf8").digest("hex");
    const expectedMarker = `discord-user:v1:${thread}:${turn}:${expectedHash}`;

    const actual = userOriginMarker(thread, turn, prompt);
    assert.equal(actual, expectedMarker);
    assert.match(expectedHash, /^[0-9a-f]{64}$/);
    assert.equal(expectedHash, expectedHash.toLowerCase());
  });

  it("handles Korean and supplementary emoji correctly in origin marker digest", () => {
    const thread = "스레드-101";
    const turn = "턴-202";
    const prompt = "  안녕하세요 🚀 세계 ✨  ";
    const trimmed = "안녕하세요 🚀 세계 ✨";
    const expectedHash = createHash("sha256").update(trimmed, "utf8").digest("hex");
    const expectedMarker = `discord-user:v1:${thread}:${turn}:${expectedHash}`;

    const actual = userOriginMarker(thread, turn, prompt);
    assert.equal(actual, expectedMarker);
  });

  it("trims Unicode NEL (U+0085) like Rust str::trim", () => {
    const thread = "th-nel";
    const turn = "tu-nel";
    const withNel = "\u0085\u0085핵심 질의 내용\u0085";
    const clean = "핵심 질의 내용";

    const markerNel = userOriginMarker(thread, turn, withNel);
    const markerClean = userOriginMarker(thread, turn, clean);
    assert.equal(markerNel, markerClean);
  });

  it("preserves BOM (U+FEFF) without trimming, producing distinct digest", () => {
    const thread = "th-bom";
    const turn = "tu-bom";
    const withBom = "\uFEFFBOM-prefixed prompt";
    const clean = "BOM-prefixed prompt";

    const markerBom = userOriginMarker(thread, turn, withBom);
    const markerClean = userOriginMarker(thread, turn, clean);
    assert.notEqual(markerBom, markerClean);
  });

  it("trims whitespace-only prompt to empty string with exact empty SHA256 digest", () => {
    const thread = "th-empty";
    const turn = "tu-empty";
    const emptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const expected = `discord-user:v1:${thread}:${turn}:${emptySha256}`;

    assert.equal(userOriginMarker(thread, turn, "   \t\r\n  "), expected);
    assert.equal(userOriginMarker(thread, turn, ""), expected);
  });

  it("rejects malformed UTF-16 in userOriginMarker with StoreIntegrityError", () => {
    const malformed = "bad-\uD800-unpaired";
    assert.throws(
      () => userOriginMarker(malformed, "turn-1", "prompt"),
      (err: unknown) => {
        assert.ok(err instanceof StoreIntegrityError);
        assert.equal(err.name, "StoreIntegrityError");
        return true;
      },
    );
    assert.throws(
      () => userOriginMarker("thread-1", malformed, "prompt"),
      (err: unknown) => {
        assert.ok(err instanceof StoreIntegrityError);
        return true;
      },
    );
    assert.throws(
      () => userOriginMarker("thread-1", "turn-1", malformed),
      (err: unknown) => {
        assert.ok(err instanceof StoreIntegrityError);
        return true;
      },
    );
  });

  it("recordOrigin retains first timestamp on duplicate insert (INSERT OR IGNORE)", () => {
    const db = createMemoryDb();
    try {
      const thread = "thread-repeat";
      const turn = "turn-repeat";
      const prompt = "test repeat insert";
      const firstTime = 1700000010.0;
      const secondTime = 1700000999.0;

      recordOrigin(db, thread, turn, prompt, firstTime);
      recordOrigin(db, thread, turn, prompt, secondTime);

      const marker = userOriginMarker(thread, turn, prompt);
      const row = db
        .prepare("SELECT event_digest, codex_thread_id, created_at FROM codex_session_mirror_events WHERE event_digest = ?")
        .get(marker) as { event_digest: string; codex_thread_id: string; created_at: number } | undefined;

      assert.ok(row);
      assert.equal(row.event_digest, marker);
      assert.equal(row.codex_thread_id, thread);
      assert.equal(row.created_at, firstTime);
    } finally {
      db.close();
    }
  });

  it("recordOrigin creates different marker and row when prompt changes", () => {
    const db = createMemoryDb();
    try {
      const thread = "thread-diff";
      const turn = "turn-diff";
      recordOrigin(db, thread, turn, "Prompt Version A", 1700000000.0);
      recordOrigin(db, thread, turn, "Prompt Version B", 1700000001.0);

      const rows = db
        .prepare("SELECT event_digest FROM codex_session_mirror_events WHERE codex_thread_id = ? ORDER BY event_digest")
        .all(thread) as Array<{ event_digest: string }>;

      assert.equal(rows.length, 2);
      assert.notEqual(rows[0]!.event_digest, rows[1]!.event_digest);
    } finally {
      db.close();
    }
  });

  it("recordOrigin respects borrowed caller BEGIN and ROLLBACK ownership", () => {
    const db = createMemoryDb();
    try {
      db.exec("BEGIN IMMEDIATE;");
      recordOrigin(db, "th-roll", "tu-roll", "Prompt to rollback", 1700000000.0);
      db.exec("ROLLBACK;");

      const countRow = db.prepare("SELECT COUNT(*) as c FROM codex_session_mirror_events").get() as { c: number };
      assert.equal(countRow.c, 0);
    } finally {
      db.close();
    }
  });

  it("recordOrigin rejects non-numeric now values with StoreIntegrityError", () => {
    const db = createMemoryDb();
    try {
      for (const invalidNow of [
        "1700000000" as unknown as number,
        null as unknown as number,
        undefined as unknown as number,
        true as unknown as number,
        1700000000n as unknown as number,
        {} as unknown as number,
      ]) {
        assert.throws(
          () => recordOrigin(db, "th", "tu", "pr", invalidNow),
          (err: unknown) => {
            assert.ok(err instanceof StoreIntegrityError);
            return true;
          },
        );
      }
    } finally {
      db.close();
    }
  });
});

describe("recordJobOrigin contracts", () => {
  it("recordJobOrigin with null turnId does no query, works on closed connection, and does not read unused getter fields", () => {
    let unusedGetterReadCount = 0;
    const job = createStoredQueueJob({
      turnId: null,
    });
    Object.defineProperty(job, "prompt", {
      get() {
        unusedGetterReadCount++;
        return "unused prompt getter";
      },
      enumerable: true,
      configurable: true,
    });

    const db = createMemoryDb();
    db.close(); // Intentionally closed connection

    assert.doesNotThrow(() => {
      recordJobOrigin(db, job);
    });
    assert.equal(unusedGetterReadCount, 0, "unused getter fields must not be read when turnId is null");
  });

  it("recordJobOrigin with Some('') (empty string turn) and non-empty turn records origin across all 4 queue states", () => {
    const states: QueueJobState[] = ["Pending", "Starting", "Running", "Quarantined"];
    const db = createMemoryDb();
    try {
      for (const state of states) {
        const jobEmptyTurn = createStoredQueueJob({
          jobId: `job-empty-${state}`,
          targetThreadId: `thread-empty-${state}`,
          turnId: "",
          state,
          updatedAt: 1700000100.0,
        });
        recordJobOrigin(db, jobEmptyTurn);

        const markerEmpty = userOriginMarker(jobEmptyTurn.targetThreadId, "", jobEmptyTurn.prompt);
        const rowEmpty = db
          .prepare("SELECT event_digest FROM codex_session_mirror_events WHERE event_digest = ?")
          .get(markerEmpty) as { event_digest: string } | undefined;
        assert.ok(rowEmpty, `expected event for empty turn in state ${state}`);

        const jobNamedTurn = createStoredQueueJob({
          jobId: `job-named-${state}`,
          targetThreadId: `thread-named-${state}`,
          turnId: `turn-${state}`,
          state,
          updatedAt: 1700000200.0,
        });
        recordJobOrigin(db, jobNamedTurn);

        const markerNamed = userOriginMarker(jobNamedTurn.targetThreadId, jobNamedTurn.turnId!, jobNamedTurn.prompt);
        const rowNamed = db
          .prepare("SELECT event_digest FROM codex_session_mirror_events WHERE event_digest = ?")
          .get(markerNamed) as { event_digest: string } | undefined;
        assert.ok(rowNamed, `expected event for named turn in state ${state}`);
      }
    } finally {
      db.close();
    }
  });

  it("recordJobOrigin rejects Proxy job with zero getter invocations", () => {
    let proxyGetCalls = 0;
    const baseJob = createStoredQueueJob();
    const proxyJob = new Proxy(baseJob, {
      get(target, prop, receiver) {
        proxyGetCalls++;
        return Reflect.get(target, prop, receiver);
      },
    });

    const db = createMemoryDb();
    try {
      assert.throws(
        () => recordJobOrigin(db, proxyJob),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          return true;
        },
      );
      assert.equal(proxyGetCalls, 0, "proxy get traps must not be invoked on rejected proxy job");
    } finally {
      db.close();
    }
  });

  it("recordJobOrigin rejects accessor descriptor on turnId with zero getter invocations", () => {
    let getterInvocations = 0;
    const baseJob = createStoredQueueJob();
    Object.defineProperty(baseJob, "turnId", {
      get() {
        getterInvocations++;
        return "turn-trap";
      },
      enumerable: true,
      configurable: true,
    });

    const db = createMemoryDb();
    try {
      assert.throws(
        () => recordJobOrigin(db, baseJob),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          return true;
        },
      );
      assert.equal(getterInvocations, 0, "accessor getter function must not be executed");
    } finally {
      db.close();
    }
  });
});

describe("start notice stage contracts", () => {
  it("DOMAIN and prefix constants match Rust authority bound 001", () => {
    assert.equal(DOMAIN, "reserve/start-failure/v1");
    assert.equal(EXECUTION_HOLD_PREFIX, "[cdr-rust:execution-held:v1] ");
    assert.equal(HOLD_PREFIX, "[cdr-rust:auto-reserve-hold:v1] ");
    assert.equal(AUTO_RESERVE_HOLD_PREFIX, HOLD_PREFIX);
  });

  it("stages notice with EXACT Korean text from full Rust literal without translation", () => {
    const db = createMemoryDb();
    try {
      const job = createStoredQueueJob({
        jobId: "job-korean-literal-001",
      });
      const reason = "자원 부족으로 인한 거절 사유";
      stageStartNoticeIn(db, job, reason);

      const row = db
        .prepare("SELECT content FROM codex_reserve_start_notices WHERE job_id = ?")
        .get(job.jobId) as { content: string } | undefined;
      assert.ok(row);

      const expectedContent =
        `Failed\n사용량 한도로 요청 시작이 거절됐습니다.\njob: ${job.jobId}\n${reason}\n이 요청은 자동 재실행하지 않습니다. 필요하면 모델을 수동으로 변경한 뒤 새 요청을 보내세요.`;
      assert.equal(row.content, expectedContent);
    } finally {
      db.close();
    }
  });

  it("strips current prefix ([cdr-rust:execution-held:v1] ) once only", () => {
    const db = createMemoryDb();
    try {
      const job = createStoredQueueJob({ jobId: "job-exec-strip" });
      const reason = `${EXECUTION_HOLD_PREFIX}Quota threshold exceeded.`;
      stageStartNoticeIn(db, job, reason);

      const row = db.prepare("SELECT content FROM codex_reserve_start_notices WHERE job_id = ?").get(job.jobId) as {
        content: string;
      };
      assert.ok(row.content.includes("Quota threshold exceeded."));
      assert.ok(!row.content.includes(EXECUTION_HOLD_PREFIX));
    } finally {
      db.close();
    }
  });

  it("strips legacy prefix ([cdr-rust:auto-reserve-hold:v1] ) once only", () => {
    const db = createMemoryDb();
    try {
      const job = createStoredQueueJob({ jobId: "job-hold-strip" });
      const reason = `${HOLD_PREFIX}Legacy reserve hold active.`;
      stageStartNoticeIn(db, job, reason);

      const row = db.prepare("SELECT content FROM codex_reserve_start_notices WHERE job_id = ?").get(job.jobId) as {
        content: string;
      };
      assert.ok(row.content.includes("Legacy reserve hold active."));
      assert.ok(!row.content.includes(HOLD_PREFIX));
    } finally {
      db.close();
    }
  });

  it("leaves nested prefix intact when prefixes are stacked", () => {
    const db = createMemoryDb();
    try {
      const job = createStoredQueueJob({ jobId: "job-stacked-prefix" });
      const reason = `${EXECUTION_HOLD_PREFIX}${HOLD_PREFIX}nested payload message`;
      stageStartNoticeIn(db, job, reason);

      const row = db.prepare("SELECT content FROM codex_reserve_start_notices WHERE job_id = ?").get(job.jobId) as {
        content: string;
      };
      assert.ok(row.content.includes(`${HOLD_PREFIX}nested payload message`));
      assert.ok(!row.content.includes(EXECUTION_HOLD_PREFIX));
    } finally {
      db.close();
    }
  });

  it("does not strip prefix when preceded by whitespace", () => {
    const db = createMemoryDb();
    try {
      const job = createStoredQueueJob({ jobId: "job-space-prefix" });
      const reason = ` ${EXECUTION_HOLD_PREFIX}reason with space before prefix`;
      stageStartNoticeIn(db, job, reason);

      const row = db.prepare("SELECT content FROM codex_reserve_start_notices WHERE job_id = ?").get(job.jobId) as {
        content: string;
      };
      assert.ok(row.content.includes(` ${EXECUTION_HOLD_PREFIX}reason with space before prefix`));
    } finally {
      db.close();
    }
  });

  it("does not trim reason, preserving leading/trailing spaces, NEL, and BOM", () => {
    const db = createMemoryDb();
    try {
      const job = createStoredQueueJob({ jobId: "job-preserve-whitespace" });
      const rawReason = " \u0085  untrimmed message \uFEFF \t ";
      stageStartNoticeIn(db, job, rawReason);

      const row = db.prepare("SELECT content FROM codex_reserve_start_notices WHERE job_id = ?").get(job.jobId) as {
        content: string;
      };
      assert.ok(row.content.includes(`\n${rawReason}\n`));
    } finally {
      db.close();
    }
  });

  it("cuts off reason at exactly 700 Unicode scalars for supplementary emoji at boundary 701", () => {
    const db = createMemoryDb();
    try {
      const job700 = createStoredQueueJob({ jobId: "job-emoji-700" });
      const emoji700 = "🎉".repeat(700);
      stageStartNoticeIn(db, job700, emoji700);

      const row700 = db.prepare("SELECT content FROM codex_reserve_start_notices WHERE job_id = ?").get(job700.jobId) as {
        content: string;
      };
      assert.ok(row700.content.includes(`\n${emoji700}\n`));

      const job701 = createStoredQueueJob({ jobId: "job-emoji-701" });
      const emoji701 = "🎉".repeat(701);
      stageStartNoticeIn(db, job701, emoji701);

      const row701 = db.prepare("SELECT content FROM codex_reserve_start_notices WHERE job_id = ?").get(job701.jobId) as {
        content: string;
      };
      assert.ok(row701.content.includes(`\n${emoji700}\n`));
      assert.ok(!row701.content.includes(emoji701));
    } finally {
      db.close();
    }
  });

  it("cuts off reason at exactly 700 Unicode scalars for Korean text at boundary 701", () => {
    const db = createMemoryDb();
    try {
      const job = createStoredQueueJob({ jobId: "job-korean-701" });
      const korean700 = "가".repeat(700);
      const korean701 = `${korean700}나`;
      stageStartNoticeIn(db, job, korean701);

      const row = db.prepare("SELECT content FROM codex_reserve_start_notices WHERE job_id = ?").get(job.jobId) as {
        content: string;
      };
      assert.ok(row.content.includes(`\n${korean700}\n`));
      assert.ok(!row.content.includes(korean701));
    } finally {
      db.close();
    }
  });

  it("preserves exact signed i64 bindings for extremes and 9007199254740993n", () => {
    const db = createMemoryDb();
    try {
      const wireExceedingSafeInt = 9007199254740993n; // 2^53 + 1
      const job = createStoredQueueJob({
        jobId: "job-i64-extremes",
        channelId: wireExceedingSafeInt,
        appServerGeneration: I64_MAX,
        attemptCount: I64_MIN,
      });
      stageStartNoticeIn(db, job, "extreme bindings test");

      const stmt = db.prepare(
        "SELECT channel_id, app_server_generation, attempt_count FROM codex_reserve_start_notices WHERE job_id = ?",
      );
      stmt.setReadBigInts(true);
      const row = stmt.get(job.jobId) as {
        channel_id: bigint;
        app_server_generation: bigint;
        attempt_count: bigint;
      };
      assert.ok(row);
      assert.equal(row.channel_id, wireExceedingSafeInt);
      assert.equal(row.app_server_generation, I64_MAX);
      assert.equal(row.attempt_count, I64_MIN);
    } finally {
      db.close();
    }
  });

  it("rejects invalid types and out-of-range signed i64 values with StoreIntegrityError", () => {
    const db = createMemoryDb();
    try {
      const invalidValues = [
        0 as unknown as bigint,
        -0 as unknown as bigint,
        9007199254740993 as unknown as bigint,
        "9007199254740993" as unknown as bigint,
        I64_MAX + 1n,
        I64_MIN - 1n,
        null as unknown as bigint,
        undefined as unknown as bigint,
      ];

      for (const val of invalidValues) {
        const jobBadChannel = createStoredQueueJob({ jobId: "job-bad-ch", channelId: val });
        assert.throws(
          () => stageStartNoticeIn(db, jobBadChannel, "reason"),
          (err: unknown) => {
            assert.ok(err instanceof StoreIntegrityError);
            return true;
          },
        );

        const jobBadGen = createStoredQueueJob({ jobId: "job-bad-gen", appServerGeneration: val });
        assert.throws(
          () => stageStartNoticeIn(db, jobBadGen, "reason"),
          (err: unknown) => {
            assert.ok(err instanceof StoreIntegrityError);
            return true;
          },
        );

        const jobBadAttempt = createStoredQueueJob({ jobId: "job-bad-att", attemptCount: val });
        assert.throws(
          () => stageStartNoticeIn(db, jobBadAttempt, "reason"),
          (err: unknown) => {
            assert.ok(err instanceof StoreIntegrityError);
            return true;
          },
        );
      }
    } finally {
      db.close();
    }
  });

  it("retains first notice under INSERT OR IGNORE, keeping original target/channel/gen/attempt/content", () => {
    const db = createMemoryDb();
    try {
      const firstJob = createStoredQueueJob({
        jobId: "job-immutable-first",
        targetThreadId: "thread-orig-1",
        channelId: 111111n,
        appServerGeneration: 10n,
        attemptCount: 1n,
      });
      stageStartNoticeIn(db, firstJob, "first failure reason");

      const secondJob = createStoredQueueJob({
        jobId: "job-immutable-first",
        targetThreadId: "thread-switched-2",
        channelId: 222222n,
        appServerGeneration: 20n,
        attemptCount: 2n,
      });
      stageStartNoticeIn(db, secondJob, "second failure reason");

      const row = db
        .prepare("SELECT target_thread_id, channel_id, app_server_generation, attempt_count, content FROM codex_reserve_start_notices WHERE job_id = ?")
        .get("job-immutable-first") as {
          target_thread_id: string;
          channel_id: bigint | number;
          app_server_generation: bigint | number;
          attempt_count: bigint | number;
          content: string;
        };
      assert.ok(row);
      assert.equal(row.target_thread_id, "thread-orig-1");
      assert.equal(BigInt(row.channel_id), 111111n);
      assert.equal(BigInt(row.app_server_generation), 10n);
      assert.equal(BigInt(row.attempt_count), 1n);
      assert.ok(row.content.includes("first failure reason"));
      assert.ok(!row.content.includes("second failure reason"));
    } finally {
      db.close();
    }
  });

  it("stageStartNoticeIn respects caller BEGIN and ROLLBACK ownership", () => {
    const db = createMemoryDb();
    try {
      const job = createStoredQueueJob({ jobId: "job-rollback-notice" });
      db.exec("BEGIN IMMEDIATE;");
      stageStartNoticeIn(db, job, "transaction rollback test");
      db.exec("ROLLBACK;");

      const countRow = db.prepare("SELECT COUNT(*) as c FROM codex_reserve_start_notices").get() as { c: number };
      assert.equal(countRow.c, 0);
    } finally {
      db.close();
    }
  });

  it("stageStartNoticeIn rejects Proxy job with zero getter invocations", () => {
    let proxyGetCalls = 0;
    const baseJob = createStoredQueueJob();
    const proxyJob = new Proxy(baseJob, {
      get(target, prop, receiver) {
        proxyGetCalls++;
        return Reflect.get(target, prop, receiver);
      },
    });

    const db = createMemoryDb();
    try {
      assert.throws(
        () => stageStartNoticeIn(db, proxyJob, "reason"),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          return true;
        },
      );
      assert.equal(proxyGetCalls, 0, "proxy get traps must not be invoked");
    } finally {
      db.close();
    }
  });

  it("stageStartNoticeIn rejects accessor property on jobId with zero getter invocations", () => {
    let getterCalls = 0;
    const baseJob = createStoredQueueJob();
    Object.defineProperty(baseJob, "jobId", {
      get() {
        getterCalls++;
        return "job-trap";
      },
      enumerable: true,
      configurable: true,
    });

    const db = createMemoryDb();
    try {
      assert.throws(
        () => stageStartNoticeIn(db, baseJob, "reason"),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          return true;
        },
      );
      assert.equal(getterCalls, 0, "accessor getter function must not be executed");
    } finally {
      db.close();
    }
  });

  it("stageStartNoticeIn rejects malformed UTF-16 in reason and identifiers", () => {
    const db = createMemoryDb();
    try {
      const malformed = "bad-\uD800-unpaired";
      const validJob = createStoredQueueJob();

      assert.throws(
        () => stageStartNoticeIn(db, validJob, malformed),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          return true;
        },
      );

      const badJobId = createStoredQueueJob({ jobId: malformed });
      assert.throws(
        () => stageStartNoticeIn(db, badJobId, "valid reason"),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          return true;
        },
      );

      const badThreadId = createStoredQueueJob({ targetThreadId: malformed });
      assert.throws(
        () => stageStartNoticeIn(db, badThreadId, "valid reason"),
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          return true;
        },
      );
    } finally {
      db.close();
    }
  });

  it("verifies stageIn alias is identical to stageStartNoticeIn", () => {
    assert.equal(stageIn, stageStartNoticeIn);
  });
});

describe("owned tempdb recordUserOrigin contracts", () => {
  it("persists marker in real testowned tempdb and allows reopening with verified content", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdr-ts-origin-"));
    try {
      const dbPath = path.join(tmpDir, "owned-store.sqlite");
      const thread = "th-temp-persist";
      const turn = "tu-temp-persist";
      const prompt = "real tempdb prompt verification";
      const now = 1700000088.0;

      await recordUserOrigin(dbPath, thread, turn, prompt, now);

      // Reopen with openInitialized to confirm persistence and schema integrity
      const db = await openInitialized(dbPath);
      try {
        const marker = userOriginMarker(thread, turn, prompt);
        const row = db
          .prepare("SELECT event_digest, codex_thread_id, created_at FROM codex_session_mirror_events WHERE event_digest = ?")
          .get(marker) as { event_digest: string; codex_thread_id: string; created_at: number } | undefined;

        assert.ok(row);
        assert.equal(row.event_digest, marker);
        assert.equal(row.codex_thread_id, thread);
        assert.equal(row.created_at, now);
      } finally {
        db.close();
      }
    } finally {
      safeCleanupTempDir(tmpDir);
    }
  });

  it("rejects malformed inputs before creating or affecting database file on disk", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdr-ts-origin-"));
    try {
      const nonExistentDbPath = path.join(tmpDir, "uncreated-store.sqlite");
      const malformedThread = "th-\uD800-bad";

      await assert.rejects(
        async () => {
          await recordUserOrigin(nonExistentDbPath, malformedThread, "turn-1", "prompt", 1700000000.0);
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          return true;
        },
      );

      assert.equal(fs.existsSync(nonExistentDbPath), false, "malformed input must reject before file effect");

      const malformedPath = `C:\\bad\\\uD800path.sqlite`;
      await assert.rejects(
        async () => {
          await recordUserOrigin(malformedPath, "thread-1", "turn-1", "prompt", 1700000000.0);
        },
        (err: unknown) => {
          assert.ok(err instanceof StoreIntegrityError);
          return true;
        },
      );
    } finally {
      safeCleanupTempDir(tmpDir);
    }
  });
});

describe("well-formed Unicode boundary assertions", () => {
  it("validates code points correctly in both modules", () => {
    assert.equal(isWellFormedOrigin("valid string"), true);
    assert.equal(isWellFormedNotice("valid string"), true);
    assert.equal(isWellFormedOrigin("한글과 이모지 🚀"), true);
    assert.equal(isWellFormedNotice("한글과 이모지 🚀"), true);

    assert.equal(isWellFormedOrigin("unpaired high \uD800"), false);
    assert.equal(isWellFormedNotice("unpaired high \uD800"), false);
    assert.equal(isWellFormedOrigin("unpaired low \uDC00"), false);
    assert.equal(isWellFormedNotice("unpaired low \uDC00"), false);
    assert.equal(isWellFormedOrigin("\uDFFF isolated"), false);
    assert.equal(isWellFormedNotice("\uDFFF isolated"), false);

    assert.equal(isWellFormedOrigin(123 as unknown as string), false);
    assert.equal(isWellFormedNotice(123 as unknown as string), false);
  });
});
