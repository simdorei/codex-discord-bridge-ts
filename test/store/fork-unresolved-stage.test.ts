import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { I64_MAX, I64_MIN } from "../../src/protocol/ids.ts";
import {
  FailurePhase,
  ForkHandoffConflictingIntentError,
  now,
  stageUnresolvedNoticesIn,
} from "../../src/store/fork-unresolved-stage.ts";
import { SystemTimeError } from "../../src/store/queue-attach-goal.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";

const QUEUE_DDL =
  "CREATE TABLE IF NOT EXISTS codex_turn_queue (job_id TEXT PRIMARY KEY, target_thread_id TEXT NOT NULL, channel_id INTEGER NOT NULL, owner_user_id INTEGER, discord_message_id INTEGER, prompt TEXT NOT NULL, queued INTEGER NOT NULL, ack_sent INTEGER NOT NULL, state TEXT NOT NULL, attempt_count INTEGER NOT NULL, turn_id TEXT, baseline_turn_ids TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL)";

const OUTBOX_DDL =
  "CREATE TABLE IF NOT EXISTS codex_delivery_outbox (delivery_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, target_thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, channel_id INTEGER NOT NULL, content TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL)";

const INTAKES_DDL =
  "CREATE TABLE IF NOT EXISTS codex_prompt_intakes (job_id TEXT PRIMARY KEY, target_thread_id TEXT NOT NULL, channel_id INTEGER NOT NULL, owner_user_id INTEGER, discord_message_id INTEGER, raw_prompt TEXT NOT NULL, auto_queue_when_busy INTEGER NOT NULL, require_current_mirror INTEGER NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', retry_after REAL NOT NULL DEFAULT 0, claim_token TEXT, claim_expires_at REAL NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL, CHECK (auto_queue_when_busy IN (0, 1)), CHECK (require_current_mirror IN (0, 1)))";

const PREFIX = "[cdr-rust:app-server-fork-unresolved:v1] ";
const PREV_LABEL = "\nPrevious error: ";
const FORK_OUTCOME_PREFIX =
  "The Codex ownership fork result is uncertain. This request remains queued and will not run until recovery, preventing a duplicate response.\nFork error: ";
const FINALIZE_PREFIX =
  "The Codex ownership fork target was created, but local routing finalization failed. This request remains queued and will not run until recovery, preventing a duplicate response.\nFinalize error: ";
const CANCELLATION_PREFIX =
  "The Codex ownership fork failed and its cancellation could not be confirmed. This request remains queued and will not run until recovery, preventing a duplicate response.\nFailure details: ";

function withTestDb<T>(fn: (db: DatabaseSync) => T): T {
  const tempRoot = realpathSync(tmpdir());
  const dir = mkdtempSync(join(tempRoot, "fork-unres-stage-test-"));
  const realDir = realpathSync(dir);
  if (!realDir.startsWith(tempRoot)) {
    throw new Error(`Temp directory escaped root: ${realDir}`);
  }
  const dbPath = join(realDir, "test.db");
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    db.exec(QUEUE_DDL);
    db.exec(OUTBOX_DDL);
    db.exec(INTAKES_DDL);
    return fn(db);
  } finally {
    try {
      db?.close();
    } finally {
      const checkReal = realpathSync(dir);
      if (dirname(checkReal) === tempRoot) {
        assert(checkReal === realDir);
        rmSync(checkReal, { recursive: true, force: true });
      }
    }
  }
}

function insertQueueRow(
  db: DatabaseSync,
  row: {
    jobId: string;
    targetThreadId: string;
    channelId: bigint | number | string;
    state: string;
    lastError?: string;
    createdAt?: number;
    updatedAt?: number;
  },
): void {
  db.prepare(
    "INSERT INTO codex_turn_queue (" +
      "job_id, target_thread_id, channel_id, owner_user_id, discord_message_id, " +
      "prompt, queued, ack_sent, state, attempt_count, turn_id, baseline_turn_ids, " +
      "last_error, created_at, updated_at" +
    ") VALUES (?, ?, ?, NULL, NULL, 'prompt', 1, 1, ?, 0, NULL, '[]', ?, ?, ?)",
  ).run(
    row.jobId,
    row.targetThreadId,
    row.channelId,
    row.state,
    row.lastError ?? "",
    row.createdAt ?? 1000.0,
    row.updatedAt ?? 1000.0,
  );
}

function insertIntakeRow(
  db: DatabaseSync,
  row: {
    jobId: string;
    targetThreadId: string;
    channelId: bigint | number | string;
    lastError?: string;
    createdAt?: number;
    updatedAt?: number;
  },
): void {
  db.prepare(
    "INSERT INTO codex_prompt_intakes (" +
      "job_id, target_thread_id, channel_id, owner_user_id, discord_message_id, " +
      "raw_prompt, auto_queue_when_busy, require_current_mirror, attempt_count, " +
      "last_error, retry_after, claim_token, claim_expires_at, created_at, updated_at" +
    ") VALUES (?, ?, ?, NULL, NULL, 'raw-prompt', 1, 0, 0, ?, 0.0, NULL, 0.0, ?, ?)",
  ).run(
    row.jobId,
    row.targetThreadId,
    row.channelId,
    row.lastError ?? "",
    row.createdAt ?? 1000.0,
    row.updatedAt ?? 1000.0,
  );
}

function getOutboxRow(
  db: DatabaseSync,
  deliveryId: string,
): Record<string, unknown> | undefined {
  const stmt = db.prepare(
    "SELECT delivery_id, job_id, target_thread_id, turn_id, channel_id, " +
      "content, attempt_count, last_error, created_at, updated_at " +
      "FROM codex_delivery_outbox WHERE delivery_id = ?",
  );
  if (typeof stmt.setReadBigInts === "function") {
    stmt.setReadBigInts(true);
  }
  return stmt.get(deliveryId) as Record<string, unknown> | undefined;
}

function getQueueRow(
  db: DatabaseSync,
  jobId: string,
): Record<string, unknown> | undefined {
  const stmt = db.prepare(
    "SELECT job_id, target_thread_id, channel_id, state, last_error, created_at, updated_at " +
      "FROM codex_turn_queue WHERE job_id = ?",
  );
  if (typeof stmt.setReadBigInts === "function") {
    stmt.setReadBigInts(true);
  }
  return stmt.get(jobId) as Record<string, unknown> | undefined;
}

function getIntakeRow(
  db: DatabaseSync,
  jobId: string,
): Record<string, unknown> | undefined {
  const stmt = db.prepare(
    "SELECT job_id, target_thread_id, channel_id, last_error, created_at, updated_at " +
      "FROM codex_prompt_intakes WHERE job_id = ?",
  );
  if (typeof stmt.setReadBigInts === "function") {
    stmt.setReadBigInts(true);
  }
  return stmt.get(jobId) as Record<string, unknown> | undefined;
}

describe("store/fork-unresolved-stage", () => {
  it("validates strict string inputs and hostile phase before any DB effects", () => {
    withTestDb((db) => {
      assert.throws(
        () => stageUnresolvedNoticesIn(db, null as unknown as string, "src", "prev", "fork", FailurePhase.ForkOutcome),
        TypeError,
      );
      assert.throws(
        () => stageUnresolvedNoticesIn(db, "h1", 123 as unknown as string, "prev", "fork", FailurePhase.ForkOutcome),
        TypeError,
      );
      assert.throws(
        () => stageUnresolvedNoticesIn(db, "h1", `src${String.fromCharCode(0xd800)}`, "prev", "fork", FailurePhase.ForkOutcome),
        TypeError,
      );
      assert.throws(
        () => stageUnresolvedNoticesIn(db, "h1", "src", "prev", "fork", "InvalidPhase" as unknown as FailurePhase),
        TypeError,
      );
      const sentinel = `fork-sentinel-\u{1F600}-${String.fromCodePoint(0x1f680)}`;
      insertQueueRow(db, { jobId: "j-sentinel", targetThreadId: "src-sentinel", channelId: 10n, state: "pending" });
      stageUnresolvedNoticesIn(db, "h-valid", "src-sentinel", "prev-clean", sentinel, FailurePhase.ForkOutcome);
      const outbox = getOutboxRow(db, "fork-unresolved:j-sentinel");
      assert.ok(outbox);
      assert.equal(outbox.content, `${FORK_OUTCOME_PREFIX}${sentinel}`);
    });
  });

  it("eagerly decodes all queue rows before any mutation, preventing first-row mutation on corrupt second row", () => {
    withTestDb((db) => {
      insertQueueRow(db, {
        jobId: "j-valid-1",
        targetThreadId: "src-eager",
        channelId: 100n,
        state: "pending",
        createdAt: 10.0,
      });
      db.prepare(
        "INSERT INTO codex_turn_queue (" +
          "job_id, target_thread_id, channel_id, owner_user_id, discord_message_id, " +
          "prompt, queued, ack_sent, state, attempt_count, turn_id, baseline_turn_ids, " +
          "last_error, created_at, updated_at" +
        ") VALUES ('j-corrupt-2', 'src-eager', 101, NULL, NULL, 'p', 1, 1, 'pending', 0, NULL, '[]', CAST(X'FF' AS TEXT), 20.0, 20.0)",
      ).run();
      assert.throws(
        () => {
          stageUnresolvedNoticesIn(db, "h-eager", "src-eager", "prev", "fork-err", FailurePhase.ForkOutcome);
        },
        StoreIntegrityError,
      );
      const firstRow = getQueueRow(db, "j-valid-1");
      assert.ok(firstRow);
      assert.equal(firstRow.last_error, "");
      const outboxCount = db.prepare("SELECT COUNT(*) AS count FROM codex_delivery_outbox").get() as { count: bigint | number };
      assert.equal(BigInt(outboxCount.count), 0n);
    });
  });

  it("rejects REAL and TEXT channel_id and preserves exact i64 extrema", () => {
    withTestDb((db) => {
      insertQueueRow(db, {
        jobId: "j-real",
        targetThreadId: "src-types",
        channelId: 12.34 as unknown as bigint,
        state: "pending",
      });
      assert.throws(
        () => stageUnresolvedNoticesIn(db, "h1", "src-types", "", "err", FailurePhase.ForkOutcome),
        StoreIntegrityError,
      );
      db.exec("DELETE FROM codex_turn_queue");
      insertQueueRow(db, {
        jobId: "j-text",
        targetThreadId: "src-types",
        channelId: "not-an-int" as unknown as bigint,
        state: "pending",
      });
      assert.throws(
        () => stageUnresolvedNoticesIn(db, "h2", "src-types", "", "err", FailurePhase.ForkOutcome),
        StoreIntegrityError,
      );
      db.exec("DELETE FROM codex_turn_queue");
      insertQueueRow(db, { jobId: "j-min", targetThreadId: "src-types", channelId: I64_MIN, state: "pending", createdAt: 1.0 });
      insertQueueRow(db, { jobId: "j-max", targetThreadId: "src-types", channelId: I64_MAX, state: "starting", createdAt: 2.0 });
      stageUnresolvedNoticesIn(db, "h-extrema", "src-types", "", "fork-extrema", FailurePhase.ForkOutcome);
      const outMin = getOutboxRow(db, "fork-unresolved:j-min");
      const outMax = getOutboxRow(db, "fork-unresolved-starting:j-max");
      assert.ok(outMin && outMax);
      assert.equal(outMin.channel_id, -9223372036854775808n);
      assert.equal(outMax.channel_id, 9223372036854775807n);
    });
  });

  it("stages pending and starting queue items with exact notices, turn IDs, and marker texts", () => {
    withTestDb((db) => {
      insertQueueRow(db, {
        jobId: "job-p",
        targetThreadId: "src-exact",
        channelId: 101n,
        state: "pending",
        lastError: "",
        createdAt: 10.0,
      });
      insertQueueRow(db, {
        jobId: "job-s",
        targetThreadId: "src-exact",
        channelId: 102n,
        state: "starting",
        lastError: "prior starting failure",
        createdAt: 20.0,
      });
      db.exec("BEGIN");
      stageUnresolvedNoticesIn(db, "handoff-99", "src-exact", "", "disk write timeout", FailurePhase.ForkOutcome);
      db.exec("COMMIT");
      const qPending = getQueueRow(db, "job-p");
      const qStarting = getQueueRow(db, "job-s");
      assert.ok(qPending && qStarting);
      assert.equal(qPending.last_error, `${PREFIX}disk write timeout`);
      assert.equal(qStarting.last_error, `${PREFIX}disk write timeout${PREV_LABEL}prior starting failure`);
      const outPending = getOutboxRow(db, "fork-unresolved:job-p");
      assert.ok(outPending);
      assert.equal(outPending.job_id, "job-p");
      assert.equal(outPending.turn_id, "fork-unresolved:handoff-99");
      assert.equal(outPending.channel_id, 101n);
      assert.equal(outPending.content, `${FORK_OUTCOME_PREFIX}disk write timeout`);
      const outStarting = getOutboxRow(db, "fork-unresolved-starting:job-s");
      assert.ok(outStarting);
      assert.equal(outStarting.job_id, "fork-unresolved-starting:job-s");
      assert.equal(outStarting.turn_id, "fork-unresolved:handoff-99");
      assert.equal(outStarting.channel_id, 102n);
      assert.equal(outStarting.content, `${FORK_OUTCOME_PREFIX}disk write timeout${PREV_LABEL}prior starting failure`);
    });
  });

  it("stages intakes with exact notice IDs and formats Finalize and Cancellation phase texts", () => {
    withTestDb((db) => {
      insertIntakeRow(db, {
        jobId: "intake-fin",
        targetThreadId: "src-phases",
        channelId: 201n,
        lastError: "",
        createdAt: 10.0,
      });
      stageUnresolvedNoticesIn(db, "h-fin", "src-phases", "", "target link failed", FailurePhase.Finalize);
      const inFin = getIntakeRow(db, "intake-fin");
      const outFin = getOutboxRow(db, "fork-unresolved-intake:intake-fin");
      assert.ok(inFin && outFin);
      assert.equal(inFin.last_error, `${PREFIX}target link failed`);
      assert.equal(outFin.delivery_id, "fork-unresolved-intake:intake-fin");
      assert.equal(outFin.job_id, "fork-unresolved-intake:intake-fin");
      assert.equal(outFin.turn_id, "fork-unresolved-intake:h-fin");
      assert.equal(outFin.content, `${FINALIZE_PREFIX}target link failed`);
      insertIntakeRow(db, {
        jobId: "intake-cancel",
        targetThreadId: "src-phases-2",
        channelId: 202n,
        lastError: "network drop",
        createdAt: 20.0,
      });
      stageUnresolvedNoticesIn(db, "h-cancel", "src-phases-2", "", "abort rejected", FailurePhase.Cancellation);
      const inCancel = getIntakeRow(db, "intake-cancel");
      const outCancel = getOutboxRow(db, "fork-unresolved-intake:intake-cancel");
      assert.ok(inCancel && outCancel);
      assert.equal(inCancel.last_error, `${PREFIX}abort rejected${PREV_LABEL}network drop`);
      assert.equal(outCancel.content, `${CANCELLATION_PREFIX}abort rejected${PREV_LABEL}network drop`);
    });
  });

  it("filters strictly by source thread and only targets pending/starting states", () => {
    withTestDb((db) => {
      insertQueueRow(db, { jobId: "q-pending", targetThreadId: "src-target", channelId: 1n, state: "pending" });
      insertQueueRow(db, { jobId: "q-starting", targetThreadId: "src-target", channelId: 2n, state: "starting" });
      insertQueueRow(db, { jobId: "q-running", targetThreadId: "src-target", channelId: 3n, state: "running", lastError: "orig-run" });
      insertQueueRow(db, { jobId: "q-completed", targetThreadId: "src-target", channelId: 4n, state: "completed", lastError: "orig-done" });
      insertQueueRow(db, { jobId: "q-other-p", targetThreadId: "other-thread", channelId: 5n, state: "pending", lastError: "orig-other" });
      insertIntakeRow(db, { jobId: "in-other", targetThreadId: "other-thread", channelId: 6n, lastError: "orig-in" });
      stageUnresolvedNoticesIn(db, "h-filter", "src-target", "", "scoped error", FailurePhase.ForkOutcome);
      assert.equal(getQueueRow(db, "q-running")?.last_error, "orig-run");
      assert.equal(getQueueRow(db, "q-completed")?.last_error, "orig-done");
      assert.equal(getQueueRow(db, "q-other-p")?.last_error, "orig-other");
      assert.equal(getIntakeRow(db, "in-other")?.last_error, "orig-in");
      const outboxCount = db.prepare("SELECT COUNT(*) AS count FROM codex_delivery_outbox").get() as { count: bigint | number };
      assert.equal(BigInt(outboxCount.count), 2n);
    });
  });

  it("executes queue mutations in created_at, job_id order before intake mutations via triggers", () => {
    withTestDb((db) => {
      db.exec("CREATE TABLE mutation_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, job_id TEXT NOT NULL)");
      db.exec(
        "CREATE TRIGGER trg_queue_order AFTER UPDATE OF last_error ON codex_turn_queue " +
          "BEGIN INSERT INTO mutation_log (tbl, job_id) VALUES ('queue', NEW.job_id); END;",
      );
      db.exec(
        "CREATE TRIGGER trg_intake_order AFTER UPDATE OF last_error ON codex_prompt_intakes " +
          "BEGIN INSERT INTO mutation_log (tbl, job_id) VALUES ('intake', NEW.job_id); END;",
      );
      insertQueueRow(db, { jobId: "q-late", targetThreadId: "src-order", channelId: 1n, state: "pending", createdAt: 30.0 });
      insertQueueRow(db, { jobId: "q-early-b", targetThreadId: "src-order", channelId: 2n, state: "pending", createdAt: 10.0 });
      insertQueueRow(db, { jobId: "q-early-a", targetThreadId: "src-order", channelId: 3n, state: "starting", createdAt: 10.0 });
      insertIntakeRow(db, { jobId: "in-early", targetThreadId: "src-order", channelId: 4n, createdAt: 5.0 });
      stageUnresolvedNoticesIn(db, "h-order", "src-order", "", "ordered error", FailurePhase.ForkOutcome);
      const logs = db.prepare("SELECT tbl, job_id FROM mutation_log ORDER BY seq").all() as Array<{ tbl: string; job_id: string }>;
      assert.deepEqual(
        logs.map((row) => ({ tbl: row.tbl, job_id: row.job_id })),
        [
          { tbl: "queue", job_id: "q-early-a" },
          { tbl: "queue", job_id: "q-early-b" },
          { tbl: "queue", job_id: "q-late" },
          { tbl: "intake", job_id: "in-early" },
        ],
      );
    });
  });

  it("preserves existing outbox row fields on first stage via INSERT ON CONFLICT DO NOTHING", () => {
    withTestDb((db) => {
      db.prepare(
        "INSERT INTO codex_delivery_outbox (" +
          "delivery_id, job_id, target_thread_id, turn_id, channel_id, content, " +
          "attempt_count, last_error, created_at, updated_at" +
        ") VALUES ('fork-unresolved:j-preserve', 'custom-job', 'src-preserve', 'turn-old', 777, 'original-content', 4, 'prior-err', 500.0, 500.0)",
      ).run();
      insertQueueRow(db, {
        jobId: "j-preserve",
        targetThreadId: "src-preserve",
        channelId: 999n,
        state: "pending",
        lastError: "",
      });
      stageUnresolvedNoticesIn(db, "h-preserve", "src-preserve", "", "new error", FailurePhase.ForkOutcome);
      const outbox = getOutboxRow(db, "fork-unresolved:j-preserve");
      assert.ok(outbox);
      assert.equal(outbox.job_id, "custom-job");
      assert.equal(outbox.target_thread_id, "src-preserve");
      assert.equal(outbox.turn_id, "turn-old");
      assert.equal(outbox.channel_id, 777n);
      assert.equal(outbox.content, "original-content");
      assert.equal(outbox.attempt_count, 4n);
      assert.equal(outbox.last_error, "prior-err");
      assert.equal(outbox.created_at, 500.0);
      assert.equal(outbox.updated_at, 500.0);
    });
  });

  it("updates only content for prior staged, never inserts missing outbox, and skips identical content timestamp update", () => {
    withTestDb((db) => {
      insertQueueRow(db, {
        jobId: "j-update",
        targetThreadId: "src-prior",
        channelId: 1n,
        state: "pending",
        lastError: `${PREFIX}same error${PREV_LABEL}initial error`,
      });
      db.prepare(
        "INSERT INTO codex_delivery_outbox (" +
          "delivery_id, job_id, target_thread_id, turn_id, channel_id, content, created_at, updated_at" +
        ") VALUES ('fork-unresolved:j-update', 'j-update', 'src-prior', 't0', 1, 'old-content', 100.0, 100.0)",
      ).run();
      insertQueueRow(db, {
        jobId: "j-missing-outbox",
        targetThreadId: "src-prior",
        channelId: 2n,
        state: "pending",
        lastError: `${PREFIX}orphan marker`,
      });
      const expectedIdenticalNotice = `${FORK_OUTCOME_PREFIX}same error`;
      insertQueueRow(db, {
        jobId: "j-identical",
        targetThreadId: "src-prior",
        channelId: 3n,
        state: "pending",
        lastError: `${PREFIX}same error`,
      });
      db.prepare(
        "INSERT INTO codex_delivery_outbox (" +
          "delivery_id, job_id, target_thread_id, turn_id, channel_id, content, created_at, updated_at" +
        ") VALUES ('fork-unresolved:j-identical', 'j-identical', 'src-prior', 't0', 3, ?, 200.0, 200.0)",
      ).run(expectedIdenticalNotice);
      stageUnresolvedNoticesIn(db, "h-prior", "src-prior", "same error", "same error", FailurePhase.ForkOutcome);
      const updatedRow = getOutboxRow(db, "fork-unresolved:j-update");
      assert.ok(updatedRow);
      assert.equal(updatedRow.content, `${FORK_OUTCOME_PREFIX}same error${PREV_LABEL}initial error`);
      assert.notEqual(updatedRow.updated_at, 100.0);
      assert.equal(getOutboxRow(db, "fork-unresolved:j-missing-outbox"), undefined);
      const identicalRow = getOutboxRow(db, "fork-unresolved:j-identical");
      assert.ok(identicalRow);
      assert.equal(identicalRow.content, expectedIdenticalNotice);
      assert.equal(identicalRow.updated_at, 200.0);
    });
  });

  it("raises ForkHandoffConflictingIntentError with exact properties on queue CAS conflict trigger", () => {
    withTestDb((db) => {
      db.exec(
        "CREATE TRIGGER trg_block_queue BEFORE UPDATE ON codex_turn_queue " +
          "BEGIN SELECT RAISE(IGNORE); END;",
      );
      insertQueueRow(db, { jobId: "q-conflict", targetThreadId: "src-conflict", channelId: 1n, state: "pending" });
      assert.throws(
        () => {
          stageUnresolvedNoticesIn(db, "h-conf", "src-conflict", "", "fork-err", FailurePhase.ForkOutcome);
        },
        (err: unknown) => {
          assert.ok(err instanceof ForkHandoffConflictingIntentError);
          assert.equal(err.kind, "ConflictingIntent");
          assert.equal(err.name, "ForkHandoffConflictingIntentError");
          assert.equal(err.sourceThreadId, "src-conflict");
          assert.equal(err.message, "a different fork handoff already fences source thread src-conflict");
          return true;
        },
      );
    });
  });

  it("aborts when intake CAS conflict occurs after queue update and caller rollback restores all rows", () => {
    withTestDb((db) => {
      db.exec(
        "CREATE TRIGGER trg_block_intake BEFORE UPDATE ON codex_prompt_intakes " +
          "BEGIN SELECT RAISE(IGNORE); END;",
      );
      insertQueueRow(db, {
        jobId: "q-before-intake",
        targetThreadId: "src-rollback-cas",
        channelId: 10n,
        state: "pending",
        lastError: "initial-q",
      });
      insertIntakeRow(db, {
        jobId: "in-cas-blocked",
        targetThreadId: "src-rollback-cas",
        channelId: 11n,
        lastError: "initial-in",
      });
      db.exec("BEGIN");
      assert.throws(
        () => {
          stageUnresolvedNoticesIn(db, "h-cas", "src-rollback-cas", "", "abort-test", FailurePhase.ForkOutcome);
        },
        (err: unknown) => {
          assert.ok(err instanceof ForkHandoffConflictingIntentError);
          assert.equal(err.sourceThreadId, "src-rollback-cas");
          return true;
        },
      );
      db.exec("ROLLBACK");
      assert.equal(getQueueRow(db, "q-before-intake")?.last_error, "initial-q");
      assert.equal(getIntakeRow(db, "in-cas-blocked")?.last_error, "initial-in");
      const outboxCount = db.prepare("SELECT COUNT(*) AS count FROM codex_delivery_outbox").get() as { count: bigint | number };
      assert.equal(BigInt(outboxCount.count), 0n);
    });
  });

  it("rolls back all queue mutations and outbox entries when intake row decoding fails", () => {
    withTestDb((db) => {
      insertQueueRow(db, {
        jobId: "q-succ-before-fail",
        targetThreadId: "src-intake-fail",
        channelId: 10n,
        state: "pending",
        lastError: "q-orig",
      });
      insertIntakeRow(db, {
        jobId: "in-corrupt-type",
        targetThreadId: "src-intake-fail",
        channelId: "invalid-chan-type" as unknown as bigint,
        lastError: "in-orig",
      });
      db.exec("BEGIN");
      assert.throws(
        () => {
          stageUnresolvedNoticesIn(db, "h-corrupt", "src-intake-fail", "", "fail-err", FailurePhase.ForkOutcome);
        },
        StoreIntegrityError,
      );
      db.exec("ROLLBACK");
      assert.equal(getQueueRow(db, "q-succ-before-fail")?.last_error, "q-orig");
      assert.equal(getIntakeRow(db, "in-corrupt-type")?.last_error, "in-orig");
      const outboxCount = db.prepare("SELECT COUNT(*) AS count FROM codex_delivery_outbox").get() as { count: bigint | number };
      assert.equal(BigInt(outboxCount.count), 0n);
    });
  });

  it("handles Date.now mocking deterministically, rejects negative/non-finite clock, and avoids clock calls when empty", () => {
    withTestDb((db) => {
      const origDateNow = Date.now;
      try {
        let clockCalled = 0;
        Date.now = () => {
          clockCalled++;
          return 1000;
        };
        stageUnresolvedNoticesIn(db, "h-empty", "src-empty", "", "err", FailurePhase.ForkOutcome);
        assert.equal(clockCalled, 0);
        insertQueueRow(db, { jobId: "j-clock", targetThreadId: "src-clock", channelId: 1n, state: "pending" });
        Date.now = () => -1;
        assert.throws(
          () => stageUnresolvedNoticesIn(db, "h-neg", "src-clock", "", "err", FailurePhase.ForkOutcome),
          SystemTimeError,
        );
        Date.now = () => Number.NaN;
        assert.throws(
          () => stageUnresolvedNoticesIn(db, "h-nan", "src-clock", "", "err", FailurePhase.ForkOutcome),
          TypeError,
        );
        Date.now = () => 1700000000500;
        stageUnresolvedNoticesIn(db, "h-fixed", "src-clock", "", "clock ok", FailurePhase.ForkOutcome);
        const out = getOutboxRow(db, "fork-unresolved:j-clock");
        assert.ok(out);
        assert.equal(out.created_at, 1700000000.5);
        assert.equal(out.updated_at, 1700000000.5);
      } finally {
        Date.now = origDateNow;
      }
      assert.equal(typeof now(), "number");
    });
  });

  it("ensures caller transaction controls atomicity and helper never owns transaction", () => {
    withTestDb((db) => {
      insertQueueRow(db, { jobId: "j-atom-1", targetThreadId: "src-atom", channelId: 1n, state: "pending" });
      db.exec("BEGIN");
      stageUnresolvedNoticesIn(db, "h-atom", "src-atom", "", "atom-err", FailurePhase.ForkOutcome);
      db.exec("ROLLBACK");
      assert.equal(getQueueRow(db, "j-atom-1")?.last_error, "");
      assert.equal(getOutboxRow(db, "fork-unresolved:j-atom-1"), undefined);
      db.exec("BEGIN");
      stageUnresolvedNoticesIn(db, "h-atom", "src-atom", "", "atom-err", FailurePhase.ForkOutcome);
      db.exec("COMMIT");
      assert.equal(getQueueRow(db, "j-atom-1")?.last_error, `${PREFIX}atom-err`);
      assert.ok(getOutboxRow(db, "fork-unresolved:j-atom-1"));
    });
  });

  it("legacy NOCASE PENDING follows Rust non-starting notice branch", () => {
    withTestDb((db) => {
      db.exec("DROP TABLE codex_turn_queue");
      db.exec(
        "CREATE TABLE IF NOT EXISTS codex_turn_queue (job_id TEXT PRIMARY KEY, target_thread_id TEXT NOT NULL, channel_id INTEGER NOT NULL, owner_user_id INTEGER, discord_message_id INTEGER, prompt TEXT NOT NULL, queued INTEGER NOT NULL, ack_sent INTEGER NOT NULL, state TEXT COLLATE NOCASE NOT NULL, attempt_count INTEGER NOT NULL, turn_id TEXT, baseline_turn_ids TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL)",
      );
      insertQueueRow(db, {
        jobId: "job-legacy-p",
        targetThreadId: "src-legacy",
        channelId: 101n,
        state: "PENDING",
      });
      const beforeRows = db.prepare(
        "SELECT job_id, state FROM codex_turn_queue WHERE state IN ('pending', 'starting')",
      ).all() as Array<{ job_id: string; state: string }>;
      assert.equal(beforeRows.length, 1);
      const first = beforeRows[0];
      assert.ok(first);
      assert.equal(first.job_id, "job-legacy-p");
      assert.equal(first.state, "PENDING");

      db.exec("BEGIN");
      stageUnresolvedNoticesIn(
        db,
        "h-legacy",
        "src-legacy",
        "",
        "legacy-fork-error",
        FailurePhase.ForkOutcome,
      );

      const qRow = getQueueRow(db, "job-legacy-p");
      assert.ok(qRow);
      assert.equal(qRow.state, "PENDING");
      assert.equal(qRow.last_error, `${PREFIX}legacy-fork-error`);

      const pendingNotice = getOutboxRow(db, "fork-unresolved:job-legacy-p");
      assert.ok(pendingNotice);
      assert.equal(pendingNotice.delivery_id, "fork-unresolved:job-legacy-p");
      assert.equal(pendingNotice.job_id, "job-legacy-p");
      assert.equal(pendingNotice.turn_id, "fork-unresolved:h-legacy");
      assert.equal(pendingNotice.channel_id, 101n);
      assert.equal(
        pendingNotice.content,
        `${FORK_OUTCOME_PREFIX}legacy-fork-error`,
      );

      const startingNotice = getOutboxRow(
        db,
        "fork-unresolved-starting:job-legacy-p",
      );
      assert.equal(startingNotice, undefined);

      db.exec("ROLLBACK");
      const qRollback = getQueueRow(db, "job-legacy-p");
      assert.ok(qRollback);
      assert.equal(qRollback.state, "PENDING");
      assert.equal(qRollback.last_error, "");
      assert.equal(getOutboxRow(db, "fork-unresolved:job-legacy-p"), undefined);
      const outboxCount = db.prepare(
        "SELECT COUNT(*) AS count FROM codex_delivery_outbox",
      ).get() as { count: bigint | number };
      assert.equal(BigInt(outboxCount.count), 0n);
    });
  });
});
