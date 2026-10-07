import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DEFINITE_FORK_ERROR_PREFIX,
  definiteMessage,
  definiteNotice,
} from "../../src/store/fork-definite-format.ts";
import { stageDefiniteNoticesIn } from "../../src/store/fork-definite-stage.ts";
import { SystemTimeError } from "../../src/store/queue-attach-goal.ts";

const QUEUE_DDL =
  "CREATE TABLE IF NOT EXISTS codex_turn_queue (job_id TEXT PRIMARY KEY, target_thread_id TEXT NOT NULL, channel_id INTEGER NOT NULL, owner_user_id INTEGER, discord_message_id INTEGER, prompt TEXT NOT NULL, queued INTEGER NOT NULL, ack_sent INTEGER NOT NULL, state TEXT NOT NULL, attempt_count INTEGER NOT NULL, turn_id TEXT, baseline_turn_ids TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL)";

const OUTBOX_DDL =
  "CREATE TABLE IF NOT EXISTS codex_delivery_outbox (delivery_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, target_thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, channel_id INTEGER NOT NULL, content TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL)";

const INTAKES_DDL =
  "CREATE TABLE IF NOT EXISTS codex_prompt_intakes (job_id TEXT PRIMARY KEY, target_thread_id TEXT NOT NULL, channel_id INTEGER NOT NULL, owner_user_id INTEGER, discord_message_id INTEGER, raw_prompt TEXT NOT NULL, auto_queue_when_busy INTEGER NOT NULL, require_current_mirror INTEGER NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', retry_after REAL NOT NULL DEFAULT 0, claim_token TEXT, claim_expires_at REAL NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL, CHECK (auto_queue_when_busy IN (0, 1)), CHECK (require_current_mirror IN (0, 1)))";

function withDb(fn: (db: DatabaseSync, dbPath: string) => void): void {
  const actualTmp = fs.realpathSync(os.tmpdir());
  const ownedDir = fs.realpathSync(fs.mkdtempSync(path.join(actualTmp, "fcn-test-")));
  const dbPath = path.join(ownedDir, "test.db");
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    fn(db, dbPath);
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // closed inside test
      }
    }
    for (const extra of ["test.db-wal", "test.db-shm", "test.db-journal"]) {
      const extraPath = path.join(ownedDir, extra);
      if (fs.existsSync(extraPath)) {
        const realExtra = fs.realpathSync(extraPath);
        assert.equal(realExtra, extraPath);
        assert.equal(path.dirname(realExtra), ownedDir);
        fs.unlinkSync(extraPath);
      }
    }
    if (fs.existsSync(dbPath)) {
      const realDb = fs.realpathSync(dbPath);
      assert.equal(realDb, dbPath);
      assert.equal(path.dirname(realDb), ownedDir);
      fs.unlinkSync(dbPath);
    }
    if (fs.existsSync(ownedDir)) {
      const realDir = fs.realpathSync(ownedDir);
      assert.equal(realDir, ownedDir);
      assert.equal(path.dirname(realDir), actualTmp);
      fs.rmdirSync(ownedDir);
    }
  }
}

function initTables(db: DatabaseSync): void {
  db.exec(QUEUE_DDL);
  db.exec(OUTBOX_DDL);
  db.exec(INTAKES_DDL);
}

function insertQueueJob(
  db: DatabaseSync,
  jobId: string,
  targetThreadId: string,
  state: "pending" | "starting" | "completed" | "failed",
  channelId: bigint = 12345n,
  lastError = "",
  createdAt = 1000.0,
): void {
  db.prepare(
    "INSERT INTO codex_turn_queue (job_id, target_thread_id, channel_id, owner_user_id, discord_message_id, prompt, queued, ack_sent, state, attempt_count, turn_id, baseline_turn_ids, last_error, created_at, updated_at) " +
      "VALUES (?, ?, ?, 1, 1, 'prompt', 1, 1, ?, 0, NULL, '[]', ?, ?, ?)",
  ).run(jobId, targetThreadId, channelId, state, lastError, createdAt, createdAt);
}

test("1: empty selection yields 0n, leaves outbox absent, and makes zero Date.now calls", () => {
  withDb((db) => {
    db.exec(QUEUE_DDL);

    const origDateNow = Date.now;
    let clockCalls = 0;
    Date.now = () => {
      clockCalls++;
      return 1000;
    };
    try {
      assert.equal(stageDefiniteNoticesIn(db, "h-empty-init", "thread-empty", "fork error"), 0n);

      insertQueueJob(db, "job-other", "other-thread", "pending");
      insertQueueJob(db, "job-completed", "thread-1", "completed");
      insertQueueJob(db, "job-failed", "thread-1", "failed");

      const count = stageDefiniteNoticesIn(db, "h-empty", "thread-1", "fork error");
      assert.equal(count, 0n);
      assert.equal(clockCalls, 0);
      assert.equal(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_delivery_outbox'",
          )
          .all().length,
        0,
      );
      assert.throws(
        () => db.prepare("SELECT delivery_id FROM codex_delivery_outbox").all(),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes("no such table: codex_delivery_outbox"),
      );
    } finally {
      Date.now = origDateNow;
    }
  });
});

test("2: pending and starting jobs consume two clocks per row with exact IDs and literal newlines", () => {
  withDb((db) => {
    initTables(db);
    const priorErr = "prior error\nwith newline";
    insertQueueJob(db, "job-p", "thread-2", "pending", 11111n, priorErr, 100.0);
    insertQueueJob(db, "job-s", "thread-2", "starting", 22222n, "", 200.0);

    const rawForkError = "raw fork error\nsecond line\n" + "Z".repeat(1200);
    const timestamps = [1001000, 1002000, 1003000, 1004000];
    let clkIdx = 0;
    const origDateNow = Date.now;
    Date.now = () => {
      const ts = timestamps[clkIdx++];
      if (ts === undefined) throw new Error("unexpected Date.now call");
      return ts;
    };

    try {
      const count = stageDefiniteNoticesIn(db, "handoff-2", "thread-2", rawForkError);
      assert.equal(count, 2n);
      assert.equal(clkIdx, 4);

      const qStmt = db.prepare(
        "SELECT job_id, last_error, updated_at FROM codex_turn_queue WHERE target_thread_id = 'thread-2' ORDER BY created_at, job_id",
      );
      const qRows = qStmt.all() as Array<{ job_id: string; last_error: string; updated_at: number }>;
      assert.equal(qRows.length, 2);
      assert.equal(qRows[0]!.job_id, "job-p");
      assert.equal(qRows[0]!.updated_at, 1001.0);
      assert.equal(qRows[0]!.last_error, definiteMessage(rawForkError, priorErr));
      assert.equal(qRows[1]!.job_id, "job-s");
      assert.equal(qRows[1]!.updated_at, 1003.0);
      assert.equal(qRows[1]!.last_error, definiteMessage(rawForkError, ""));

      const outStmt = db.prepare(
        "SELECT delivery_id, job_id, target_thread_id, turn_id, channel_id, content, created_at, updated_at FROM codex_delivery_outbox ORDER BY created_at, delivery_id",
      );
      outStmt.setReadBigInts(true);
      const outRows = outStmt.all() as Array<Record<string, unknown>>;
      assert.equal(outRows.length, 2);

      const o0 = outRows[0]!;
      assert.equal(o0["delivery_id"], "fork-definite:handoff-2:job-p");
      assert.equal(o0["job_id"], "fork-definite:handoff-2:job-p");
      assert.equal(o0["turn_id"], "fork-definite:handoff-2");
      assert.equal(o0["target_thread_id"], "thread-2");
      assert.equal(o0["channel_id"], 11111n);
      assert.equal(o0["created_at"], 1002.0);
      assert.equal(o0["updated_at"], 1002.0);
      assert.equal(o0["content"], definiteNotice(rawForkError, priorErr));
      assert.ok(typeof o0["content"] === "string" && o0["content"].includes("\n") && !o0["content"].includes("\\n"));

      const o1 = outRows[1]!;
      assert.equal(o1["delivery_id"], "fork-definite:handoff-2:job-s");
      assert.equal(o1["job_id"], "fork-definite:handoff-2:job-s");
      assert.equal(o1["turn_id"], "fork-definite:handoff-2");
      assert.equal(o1["target_thread_id"], "thread-2");
      assert.equal(o1["channel_id"], 22222n);
      assert.equal(o1["created_at"], 1004.0);
      assert.equal(o1["updated_at"], 1004.0);
      assert.equal(o1["content"], definiteNotice(rawForkError, ""));
    } finally {
      Date.now = origDateNow;
    }
  });
});

test("3: delivery_id collision preserves existing row while unrelated job_id UNIQUE collision throws after marker", () => {
  withDb((db) => {
    initTables(db);
    insertQueueJob(db, "job-c1", "thread-c1", "pending", 33333n);
    const delivId = "fork-definite:h-c:job-c1";
    db.prepare(
      "INSERT INTO codex_delivery_outbox (delivery_id, job_id, target_thread_id, turn_id, channel_id, content, attempt_count, last_error, created_at, updated_at) " +
        "VALUES (?, ?, 'old-thread', 'old-turn', 77777, 'ORIGINAL_CONTENT', 3, 'old-err', 50.0, 50.0)",
    ).run(delivId, delivId);

    const outStmt = db.prepare("SELECT * FROM codex_delivery_outbox WHERE delivery_id = ?");
    outStmt.setReadBigInts(true);
    const beforeRow = outStmt.get(delivId) as Record<string, unknown>;

    const countA = stageDefiniteNoticesIn(db, "h-c", "thread-c1", "fork error A");
    assert.equal(countA, 1n);

    const existing = outStmt.get(delivId) as Record<string, unknown>;
    assert.deepEqual(existing, beforeRow);
    assert.equal(existing["delivery_id"], delivId);
    assert.equal(existing["job_id"], delivId);
    assert.equal(existing["content"], "ORIGINAL_CONTENT");
    assert.equal(existing["channel_id"], 77777n);
    assert.equal(existing["target_thread_id"], "old-thread");
    assert.equal(existing["attempt_count"], 3n);
    assert.equal(existing["created_at"], 50.0);

    insertQueueJob(db, "job-c2", "thread-c2", "pending", 44444n, "prior-error-c2");
    const targetJobId = "fork-definite:h-c:job-c2";
    db.prepare(
      "INSERT INTO codex_delivery_outbox (delivery_id, job_id, target_thread_id, turn_id, channel_id, content, created_at, updated_at) " +
        "VALUES ('unrelated-delivery-id', ?, 'other-thread', 'other-turn', 88888, 'OTHER_CONTENT', 60.0, 60.0)",
    ).run(targetJobId);

    assert.throws(
      () => stageDefiniteNoticesIn(db, "h-c", "thread-c2", "fork error B"),
      (err: unknown) => err instanceof Error && err.message.includes("UNIQUE constraint failed"),
    );

    const qRow = db.prepare("SELECT last_error FROM codex_turn_queue WHERE job_id = 'job-c2'").get() as {
      last_error: string;
    };
    assert.ok(qRow.last_error.startsWith(DEFINITE_FORK_ERROR_PREFIX));
    assert.ok(qRow.last_error.includes("fork error B"));
  });
});

test("4: second clock negative error leaves marker visible in caller BEGIN until ROLLBACK restores", () => {
  withDb((db) => {
    initTables(db);
    insertQueueJob(db, "job-clk", "thread-clk", "pending", 55555n, "orig-err", 100.0);

    const origDateNow = Date.now;
    let callCount = 0;
    Date.now = () => {
      callCount++;
      return callCount === 1 ? 1005000 : -1;
    };

    try {
      db.exec("BEGIN");

      assert.throws(
        () => stageDefiniteNoticesIn(db, "h-clk", "thread-clk", "clock error"),
        (err: unknown) => err instanceof SystemTimeError,
      );

      assert.equal(db.prepare("SELECT delivery_id FROM codex_delivery_outbox").all().length, 0);

      const qRow = db.prepare(
        "SELECT last_error, updated_at FROM codex_turn_queue WHERE job_id = 'job-clk'",
      ).get() as {
        last_error: string;
        updated_at: number;
      };
      assert.ok(qRow.last_error.startsWith(DEFINITE_FORK_ERROR_PREFIX));
      assert.equal(qRow.updated_at, 1005.0);

      db.exec("ROLLBACK");

      const restored = db.prepare(
        "SELECT last_error, updated_at FROM codex_turn_queue WHERE job_id = 'job-clk'",
      ).get() as {
        last_error: string;
        updated_at: number;
      };
      assert.equal(restored.last_error, "orig-err");
      assert.equal(restored.updated_at, 100.0);
    } finally {
      Date.now = origDateNow;
    }
  });
});

test("5: later row failure leaves earlier marker and outbox inside caller transaction, caller rollback restores", () => {
  withDb((db) => {
    initTables(db);
    insertQueueJob(db, "job-5a", "thread-5", "pending", 61111n, "orig-5a", 100.0);
    insertQueueJob(db, "job-5b", "thread-5", "pending", 62222n, "orig-5b", 200.0);

    const origDateNow = Date.now;
    let clkCount = 0;
    Date.now = () => {
      clkCount++;
      if (clkCount === 1) return 1010000;
      if (clkCount === 2) return 1011000;
      return -1;
    };

    try {
      db.exec("BEGIN");

      assert.throws(
        () => stageDefiniteNoticesIn(db, "h-5", "thread-5", "fork err 5"),
        (err: unknown) => err instanceof SystemTimeError,
      );

      const q5a = db.prepare(
        "SELECT last_error, updated_at FROM codex_turn_queue WHERE job_id = 'job-5a'",
      ).get() as {
        last_error: string;
        updated_at: number;
      };
      assert.ok(q5a.last_error.startsWith(DEFINITE_FORK_ERROR_PREFIX));
      assert.equal(q5a.updated_at, 1010.0);

      const q5b = db.prepare(
        "SELECT last_error, updated_at FROM codex_turn_queue WHERE job_id = 'job-5b'",
      ).get() as {
        last_error: string;
        updated_at: number;
      };
      assert.equal(q5b.last_error, "orig-5b");

      const partialOutboxRows = db.prepare("SELECT delivery_id FROM codex_delivery_outbox").all() as Array<{
        delivery_id: string;
      }>;
      assert.equal(partialOutboxRows.length, 1);
      assert.equal(partialOutboxRows[0]!.delivery_id, "fork-definite:h-5:job-5a");

      db.exec("ROLLBACK");

      const rest5a = db.prepare(
        "SELECT last_error, updated_at FROM codex_turn_queue WHERE job_id = 'job-5a'",
      ).get() as {
        last_error: string;
        updated_at: number;
      };
      assert.equal(rest5a.last_error, "orig-5a");
      assert.equal(rest5a.updated_at, 100.0);
      assert.equal(db.prepare("SELECT delivery_id FROM codex_delivery_outbox").all().length, 0);

      const commitTimestamps = [1020000, 1021000, 1022000, 1023000];
      let commitClkIdx = 0;
      Date.now = () => {
        const ts = commitTimestamps[commitClkIdx++];
        if (ts === undefined) throw new Error("unexpected Date.now call");
        return ts;
      };

      db.exec("BEGIN");
      const stagedCount = stageDefiniteNoticesIn(db, "h-5-ok", "thread-5", "persisted fork err");
      assert.equal(stagedCount, 2n);
      assert.equal(commitClkIdx, 4);
      db.exec("COMMIT");

      const qStmt = db.prepare(
        "SELECT job_id, target_thread_id, channel_id, state, last_error, updated_at FROM codex_turn_queue WHERE target_thread_id = 'thread-5' ORDER BY created_at, job_id",
      );
      qStmt.setReadBigInts(true);
      const qRows = qStmt.all() as Array<Record<string, unknown>>;
      assert.equal(qRows.length, 2);
      assert.equal(qRows[0]!["job_id"], "job-5a");
      assert.equal(qRows[0]!["target_thread_id"], "thread-5");
      assert.equal(qRows[0]!["channel_id"], 61111n);
      assert.equal(qRows[0]!["state"], "pending");
      assert.equal(qRows[0]!["updated_at"], 1020.0);
      assert.equal(qRows[0]!["last_error"], definiteMessage("persisted fork err", "orig-5a"));
      assert.equal(qRows[1]!["job_id"], "job-5b");
      assert.equal(qRows[1]!["target_thread_id"], "thread-5");
      assert.equal(qRows[1]!["channel_id"], 62222n);
      assert.equal(qRows[1]!["state"], "pending");
      assert.equal(qRows[1]!["updated_at"], 1022.0);
      assert.equal(qRows[1]!["last_error"], definiteMessage("persisted fork err", "orig-5b"));

      const outStmt = db.prepare(
        "SELECT delivery_id, job_id, target_thread_id, turn_id, channel_id, content, attempt_count, last_error, created_at, updated_at FROM codex_delivery_outbox ORDER BY created_at, delivery_id",
      );
      outStmt.setReadBigInts(true);
      const outRows = outStmt.all() as Array<Record<string, unknown>>;
      assert.equal(outRows.length, 2);

      const o0 = outRows[0]!;
      assert.equal(o0["delivery_id"], "fork-definite:h-5-ok:job-5a");
      assert.equal(o0["job_id"], "fork-definite:h-5-ok:job-5a");
      assert.equal(o0["target_thread_id"], "thread-5");
      assert.equal(o0["turn_id"], "fork-definite:h-5-ok");
      assert.equal(o0["channel_id"], 61111n);
      assert.equal(o0["content"], definiteNotice("persisted fork err", "orig-5a"));
      assert.equal(o0["attempt_count"], 0n);
      assert.equal(o0["last_error"], "");
      assert.equal(o0["created_at"], 1021.0);
      assert.equal(o0["updated_at"], 1021.0);

      const o1 = outRows[1]!;
      assert.equal(o1["delivery_id"], "fork-definite:h-5-ok:job-5b");
      assert.equal(o1["job_id"], "fork-definite:h-5-ok:job-5b");
      assert.equal(o1["target_thread_id"], "thread-5");
      assert.equal(o1["turn_id"], "fork-definite:h-5-ok");
      assert.equal(o1["channel_id"], 62222n);
      assert.equal(o1["content"], definiteNotice("persisted fork err", "orig-5b"));
      assert.equal(o1["attempt_count"], 0n);
      assert.equal(o1["last_error"], "");
      assert.equal(o1["created_at"], 1023.0);
      assert.equal(o1["updated_at"], 1023.0);
    } finally {
      Date.now = origDateNow;
    }
  });
});

test("6: previous error format preserves literal newlines without backslash-n across formats", () => {
  withDb((db) => {
    initTables(db);
    const cases = [
      {
        id: "case-def",
        stored: "[cdr-rust:app-server-fork-definite:v1] old fail\nPrevious error: deep root\nline2",
        expectedPrev: "deep root\nline2",
      },
      {
        id: "case-unres",
        stored: "[cdr-rust:app-server-fork-unresolved:v1] unres fail\nPrevious error: unres root\nline2",
        expectedPrev: "unres root\nline2",
      },
      {
        id: "case-plain",
        stored: "plain root\nline2",
        expectedPrev: "plain root\nline2",
      },
      {
        id: "case-none",
        stored: "[cdr-rust:app-server-fork-definite:v1] solitary fail",
        expectedPrev: "",
      },
    ];

    for (const [i, c] of cases.entries()) {
      const thread = `thread-fmt-${i}`;
      insertQueueJob(db, c.id, thread, "pending", 70000n + BigInt(i), c.stored);

      const count = stageDefiniteNoticesIn(db, `h-fmt-${i}`, thread, "fork failure\nwith detail");
      assert.equal(count, 1n);

      const qRow = db.prepare("SELECT last_error FROM codex_turn_queue WHERE job_id = ?").get(c.id) as {
        last_error: string;
      };
      const outRow = db.prepare("SELECT content FROM codex_delivery_outbox WHERE job_id = ?").get(
        `fork-definite:h-fmt-${i}:${c.id}`,
      ) as { content: string };

      assert.ok(!qRow.last_error.includes("\\n"));
      assert.ok(!outRow.content.includes("\\n"));
      assert.ok(qRow.last_error.includes("\n"));
      assert.ok(outRow.content.includes("\n"));

      if (c.expectedPrev.length > 0) {
        assert.ok(qRow.last_error.includes(c.expectedPrev));
        assert.ok(outRow.content.includes(c.expectedPrev));
      }
    }
  });
});

test("7: populated queue with missing outbox table throws native error after marker update, caller retains transaction until rollback", () => {
  withDb((db) => {
    db.exec(QUEUE_DDL);
    insertQueueJob(db, "job-native", "thread-native", "pending", 88888n, "orig-err", 100.0);

    const qStmt = db.prepare("SELECT * FROM codex_turn_queue ORDER BY job_id");
    qStmt.setReadBigInts(true);
    const initialSnapshot = qStmt.all();

    const origDateNow = Date.now;
    const timestamps = [1030000, 1031000];
    let clockCalls = 0;
    Date.now = () => {
      const ts = timestamps[clockCalls++];
      if (ts === undefined) throw new Error("unexpected Date.now call");
      return ts;
    };

    try {
      db.exec("BEGIN");

      assert.throws(
        () => stageDefiniteNoticesIn(db, "h-native", "thread-native", "native fork failure"),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes("no such table: codex_delivery_outbox"),
      );
      assert.equal(clockCalls, 2);

      const markedRow = db
        .prepare(
          "SELECT last_error, updated_at FROM codex_turn_queue WHERE job_id = 'job-native'",
        )
        .get() as { last_error: string; updated_at: number };
      assert.equal(
        markedRow.last_error,
        definiteMessage("native fork failure", "orig-err"),
      );
      assert.equal(markedRow.updated_at, 1030.0);

      assert.throws(
        () => db.exec("BEGIN"),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes("cannot start a transaction within a transaction"),
      );

      db.exec("ROLLBACK");

      const restoredSnapshot = qStmt.all();
      assert.deepEqual(restoredSnapshot, initialSnapshot);

      const readrow = db.prepare("SELECT 1 AS alive").get() as { alive: number };
      assert.equal(readrow.alive, 1);
      assert.equal(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_delivery_outbox'",
          )
          .all().length,
        0,
      );
      assert.throws(
        () => db.prepare("SELECT delivery_id FROM codex_delivery_outbox").all(),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes("no such table: codex_delivery_outbox"),
      );
    } finally {
      Date.now = origDateNow;
    }
  });
});

test("8: second clock negative error throws SystemTimeError over missing outbox table, caller rollback restores queue", () => {
  withDb((db) => {
    db.exec(QUEUE_DDL);
    insertQueueJob(db, "job-clk-absent", "thread-clk-absent", "pending", 99999n, "orig-err", 100.0);

    const qStmt = db.prepare("SELECT * FROM codex_turn_queue ORDER BY job_id");
    qStmt.setReadBigInts(true);
    const initialSnapshot = qStmt.all();

    const origDateNow = Date.now;
    let clockCalls = 0;
    Date.now = () => {
      clockCalls++;
      return clockCalls === 1 ? 1040000 : -1;
    };

    try {
      assert.equal(db.isTransaction, false);
      db.exec("BEGIN");
      assert.equal(db.isTransaction, true);

      assert.throws(
        () =>
          stageDefiniteNoticesIn(
            db,
            "h-clk-absent",
            "thread-clk-absent",
            "clock error absent outbox",
          ),
        (err: unknown) => err instanceof SystemTimeError,
      );
      assert.equal(clockCalls, 2);

      const markedRow = db
        .prepare(
          "SELECT last_error, updated_at FROM codex_turn_queue WHERE job_id = 'job-clk-absent'",
        )
        .get() as { last_error: string; updated_at: number };
      assert.equal(
        markedRow.last_error,
        definiteMessage("clock error absent outbox", "orig-err"),
      );
      assert.equal(markedRow.updated_at, 1040.0);

      assert.equal(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_delivery_outbox'",
          )
          .all().length,
        0,
      );
      assert.throws(
        () => db.prepare("SELECT delivery_id FROM codex_delivery_outbox").all(),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes("no such table: codex_delivery_outbox"),
      );

      assert.equal(db.isTransaction, true);
      db.exec("ROLLBACK");
      assert.equal(db.isTransaction, false);

      const restoredSnapshot = qStmt.all();
      assert.deepEqual(restoredSnapshot, initialSnapshot);

      const readrow = db.prepare("SELECT 1 AS alive").get() as { alive: number };
      assert.equal(readrow.alive, 1);
    } finally {
      Date.now = origDateNow;
    }
  });
});
