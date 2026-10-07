import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearUnresolvedNoticesIn } from "../../src/store/fork-clear-notices.ts";

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
  state: string,
  extra: { turnId?: string | null; lastError?: string } = {}
): void {
  db.prepare(
    "INSERT INTO codex_turn_queue (job_id, target_thread_id, channel_id, owner_user_id, discord_message_id, prompt, queued, ack_sent, state, attempt_count, turn_id, baseline_turn_ids, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    jobId,
    targetThreadId,
    101,
    201,
    301,
    "prompt text",
    1,
    1,
    state,
    0,
    extra.turnId ?? null,
    "[]",
    extra.lastError ?? "",
    1000.0,
    1000.0
  );
}

function insertOutbox(
  db: DatabaseSync,
  deliveryId: string,
  jobId: string,
  targetThreadId: string,
  content = "notice content"
): void {
  db.prepare(
    "INSERT INTO codex_delivery_outbox (delivery_id, job_id, target_thread_id, turn_id, channel_id, content, attempt_count, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    deliveryId,
    jobId,
    targetThreadId,
    "turn-1",
    101,
    content,
    0,
    "",
    1000.0,
    1000.0
  );
}

function insertIntake(
  db: DatabaseSync,
  jobId: string,
  targetThreadId: string
): void {
  db.prepare(
    "INSERT INTO codex_prompt_intakes (job_id, target_thread_id, channel_id, owner_user_id, discord_message_id, raw_prompt, auto_queue_when_busy, require_current_mirror, attempt_count, last_error, retry_after, claim_token, claim_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    jobId,
    targetThreadId,
    101,
    201,
    301,
    "raw prompt",
    1,
    1,
    0,
    "",
    0.0,
    null,
    0.0,
    1000.0,
    1000.0
  );
}

test("deletes exact unresolved notice IDs for selected source across pending, starting, and intake", () => {
  withDb((db) => {
    initTables(db);
    insertQueueJob(db, "job-p", "thread-1", "pending");
    insertQueueJob(db, "job-s", "thread-1", "starting");
    insertIntake(db, "job-i", "thread-1");

    insertOutbox(db, "fork-unresolved:job-p", "job-p", "thread-1");
    insertOutbox(db, "fork-unresolved-starting:job-s", "job-s", "thread-1");
    insertOutbox(db, "fork-unresolved-intake:job-i", "job-i", "thread-1");

    clearUnresolvedNoticesIn(db, "thread-1");

    const remaining = db.prepare("SELECT delivery_id FROM codex_delivery_outbox").all();
    assert.equal(remaining.length, 0);
  });
});

test("preserves running, completed, other thread, definite, quarantine, and lookalike prefix outbox rows", () => {
  withDb((db) => {
    initTables(db);
    insertQueueJob(db, "job-run", "thread-1", "running");
    insertQueueJob(db, "job-comp", "thread-1", "completed");
    insertOutbox(db, "fork-unresolved:job-run", "job-run", "thread-1");
    insertOutbox(db, "fork-unresolved:job-comp", "job-comp", "thread-1");

    insertQueueJob(db, "job-oth-p", "thread-2", "pending");
    insertQueueJob(db, "job-oth-s", "thread-2", "starting");
    insertIntake(db, "job-oth-i", "thread-2");
    insertOutbox(db, "fork-unresolved:job-oth-p", "job-oth-p", "thread-2");
    insertOutbox(db, "fork-unresolved-starting:job-oth-s", "job-oth-s", "thread-2");
    insertOutbox(db, "fork-unresolved-intake:job-oth-i", "job-oth-i", "thread-2");

    insertOutbox(db, "msg:delivery-100", "job-def", "thread-1");
    insertOutbox(db, "quarantine:job-q", "job-q", "thread-1");

    insertOutbox(db, "fork-unresolved:orphan", "job-orph-1", "thread-1");
    insertOutbox(db, "fork-unresolved-starting:orphan", "job-orph-2", "thread-1");
    insertOutbox(db, "fork-unresolved-intake:orphan", "job-orph-3", "thread-1");
    insertOutbox(db, "fork-unresolved-other:prefix", "job-lookalike", "thread-1");

    insertQueueJob(db, "job-target-p", "thread-1", "pending");
    insertOutbox(db, "fork-unresolved:job-target-p", "job-target-p", "thread-1");

    clearUnresolvedNoticesIn(db, "thread-1");

    const rows = db.prepare("SELECT delivery_id FROM codex_delivery_outbox ORDER BY delivery_id").all() as Array<{ delivery_id: string }>;
    const ids = rows.map((r) => r.delivery_id);

    assert.equal(ids.includes("fork-unresolved:job-target-p"), false);
    assert.equal(ids.includes("fork-unresolved:job-run"), true);
    assert.equal(ids.includes("fork-unresolved:job-comp"), true);
    assert.equal(ids.includes("fork-unresolved:job-oth-p"), true);
    assert.equal(ids.includes("fork-unresolved-starting:job-oth-s"), true);
    assert.equal(ids.includes("fork-unresolved-intake:job-oth-i"), true);
    assert.equal(ids.includes("msg:delivery-100"), true);
    assert.equal(ids.includes("quarantine:job-q"), true);
    assert.equal(ids.includes("fork-unresolved:orphan"), true);
    assert.equal(ids.includes("fork-unresolved-starting:orphan"), true);
    assert.equal(ids.includes("fork-unresolved-intake:orphan"), true);
    assert.equal(ids.includes("fork-unresolved-other:prefix"), true);
    assert.equal(ids.length, 11);
  });
});

test("queue and intake table rows and markers remain completely unchanged", () => {
  withDb((db) => {
    initTables(db);
    insertQueueJob(db, "job-p", "thread-1", "pending");
    insertQueueJob(db, "job-s", "thread-1", "starting");
    insertIntake(db, "job-i", "thread-1");
    insertOutbox(db, "fork-unresolved:job-p", "job-p", "thread-1");

    const queueBefore = db.prepare("SELECT * FROM codex_turn_queue ORDER BY job_id").all();
    const intakesBefore = db.prepare("SELECT * FROM codex_prompt_intakes ORDER BY job_id").all();

    clearUnresolvedNoticesIn(db, "thread-1");

    const queueAfter = db.prepare("SELECT * FROM codex_turn_queue ORDER BY job_id").all();
    const intakesAfter = db.prepare("SELECT * FROM codex_prompt_intakes ORDER BY job_id").all();

    assert.deepEqual(queueAfter, queueBefore);
    assert.deepEqual(intakesAfter, intakesBefore);
  });
});

test("caller BEGIN and ROLLBACK restores deleted outbox including all fields; caller COMMIT persists with db handle alive", () => {
  withDb((db) => {
    initTables(db);
    insertQueueJob(db, "job-p", "thread-1", "pending");
    insertIntake(db, "job-i", "thread-1");
    insertOutbox(db, "fork-unresolved:job-p", "job-p", "thread-1", "content-queue");
    insertOutbox(db, "fork-unresolved-intake:job-i", "job-i", "thread-1", "content-intake");

    const beforeRows = db.prepare("SELECT * FROM codex_delivery_outbox ORDER BY delivery_id").all();

    db.exec("BEGIN");
    clearUnresolvedNoticesIn(db, "thread-1");
    const inTxCount = (db.prepare("SELECT count(*) as count FROM codex_delivery_outbox").get() as { count: number | bigint }).count;
    assert.equal(Number(inTxCount), 0);
    db.exec("ROLLBACK");

    const afterRollbackRows = db.prepare("SELECT * FROM codex_delivery_outbox ORDER BY delivery_id").all();
    assert.deepEqual(afterRollbackRows, beforeRows);

    db.exec("BEGIN");
    clearUnresolvedNoticesIn(db, "thread-1");
    db.exec("COMMIT");

    const afterCommitCount = (db.prepare("SELECT count(*) as count FROM codex_delivery_outbox").get() as { count: number | bigint }).count;
    assert.equal(Number(afterCommitCount), 0);

    const aliveCheck = db.prepare("SELECT 1 as alive").get() as { alive: number };
    assert.equal(aliveCheck.alive, 1);
  });
});

test("missing tables throw native SQLite error without DDL side effects or schema ensure", () => {
  withDb((db) => {
    assert.throws(
      () => clearUnresolvedNoticesIn(db, "thread-1"),
      /no such table/i
    );

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    assert.equal(tables.length, 0);
  });
});

test("second missing intake table error occurs after queue deletion and caller ROLLBACK restores it", () => {
  withDb((db) => {
    db.exec(QUEUE_DDL);
    db.exec(OUTBOX_DDL);

    insertQueueJob(db, "job-p", "thread-1", "pending");
    insertOutbox(db, "fork-unresolved:job-p", "job-p", "thread-1");

    db.exec("BEGIN");
    assert.throws(
      () => clearUnresolvedNoticesIn(db, "thread-1"),
      /no such table: codex_prompt_intakes/i
    );

    const inTxRows = db.prepare("SELECT delivery_id FROM codex_delivery_outbox").all();
    assert.equal(inTxRows.length, 0);

    db.exec("ROLLBACK");
    const restoredRows = db.prepare("SELECT delivery_id FROM codex_delivery_outbox").all() as Array<{ delivery_id: string }>;
    assert.equal(restoredRows.length, 1);
    assert.equal(restoredRows[0]?.delivery_id, "fork-unresolved:job-p");
  });
});

test("legacy NOCASE state column variant handles uppercase PENDING and STARTING with proper prefixes", () => {
  withDb((db) => {
    const QUEUE_NOCASE_DDL =
      "CREATE TABLE IF NOT EXISTS codex_turn_queue (job_id TEXT PRIMARY KEY, target_thread_id TEXT NOT NULL, channel_id INTEGER NOT NULL, owner_user_id INTEGER, discord_message_id INTEGER, prompt TEXT NOT NULL, queued INTEGER NOT NULL, ack_sent INTEGER NOT NULL, state TEXT COLLATE NOCASE NOT NULL, attempt_count INTEGER NOT NULL, turn_id TEXT, baseline_turn_ids TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL)";

    db.exec(QUEUE_NOCASE_DDL);
    db.exec(OUTBOX_DDL);
    db.exec(INTAKES_DDL);

    insertQueueJob(db, "job-upper-s", "thread-1", "STARTING");
    insertQueueJob(db, "job-upper-p", "thread-1", "PENDING");
    insertQueueJob(db, "job-upper-r", "thread-1", "RUNNING");

    insertOutbox(db, "fork-unresolved-starting:job-upper-s", "job-upper-s", "thread-1");
    insertOutbox(db, "fork-unresolved:job-upper-p", "job-upper-p", "thread-1");
    insertOutbox(db, "fork-unresolved:job-upper-r", "job-upper-r", "thread-1");

    clearUnresolvedNoticesIn(db, "thread-1");

    const remaining = db.prepare("SELECT delivery_id FROM codex_delivery_outbox").all() as Array<{ delivery_id: string }>;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.delivery_id, "fork-unresolved:job-upper-r");
  });
});

test("preserves NUL byte in job_id without truncating or accidental prefix matching", () => {
  withDb((db) => {
    initTables(db);
    const nulJobId = "job\0with\0nul";
    insertQueueJob(db, nulJobId, "thread-1", "pending");
    insertOutbox(db, `fork-unresolved:${nulJobId}`, nulJobId, "thread-1");
    insertOutbox(db, "fork-unresolved:job", "job", "thread-1");

    clearUnresolvedNoticesIn(db, "thread-1");

    const remaining = db.prepare("SELECT delivery_id FROM codex_delivery_outbox").all() as Array<{ delivery_id: string }>;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.delivery_id, "fork-unresolved:job");
  });
});

test("exact source matching preserves whitespace, BOM, empty string, and unicode without trimming", () => {
  withDb((db) => {
    initTables(db);
    const wsSource = "  padded-thread  ";
    const bomSource = "\uFEFFbom-thread";
    const unicodeSource = "한국어-스레드-🧵";
    const emptySource = "";

    insertQueueJob(db, "j-ws", wsSource, "pending");
    insertQueueJob(db, "j-trim", "padded-thread", "pending");
    insertOutbox(db, "fork-unresolved:j-ws", "j-ws", wsSource);
    insertOutbox(db, "fork-unresolved:j-trim", "j-trim", "padded-thread");

    insertQueueJob(db, "j-bom", bomSource, "pending");
    insertQueueJob(db, "j-nobom", "bom-thread", "pending");
    insertOutbox(db, "fork-unresolved:j-bom", "j-bom", bomSource);
    insertOutbox(db, "fork-unresolved:j-nobom", "j-nobom", "bom-thread");

    insertQueueJob(db, "j-uni", unicodeSource, "pending");
    insertOutbox(db, "fork-unresolved:j-uni", "j-uni", unicodeSource);

    insertQueueJob(db, "j-empty", emptySource, "pending");
    insertOutbox(db, "fork-unresolved:j-empty", "j-empty", emptySource);

    clearUnresolvedNoticesIn(db, wsSource);
    let rows = db.prepare("SELECT delivery_id FROM codex_delivery_outbox ORDER BY delivery_id").all() as Array<{ delivery_id: string }>;
    let ids = rows.map((r) => r.delivery_id);
    assert.equal(ids.includes("fork-unresolved:j-ws"), false);
    assert.equal(ids.includes("fork-unresolved:j-trim"), true);

    clearUnresolvedNoticesIn(db, bomSource);
    rows = db.prepare("SELECT delivery_id FROM codex_delivery_outbox ORDER BY delivery_id").all() as Array<{ delivery_id: string }>;
    ids = rows.map((r) => r.delivery_id);
    assert.equal(ids.includes("fork-unresolved:j-bom"), false);
    assert.equal(ids.includes("fork-unresolved:j-nobom"), true);

    clearUnresolvedNoticesIn(db, unicodeSource);
    rows = db.prepare("SELECT delivery_id FROM codex_delivery_outbox ORDER BY delivery_id").all() as Array<{ delivery_id: string }>;
    ids = rows.map((r) => r.delivery_id);
    assert.equal(ids.includes("fork-unresolved:j-uni"), false);

    clearUnresolvedNoticesIn(db, emptySource);
    rows = db.prepare("SELECT delivery_id FROM codex_delivery_outbox ORDER BY delivery_id").all() as Array<{ delivery_id: string }>;
    ids = rows.map((r) => r.delivery_id);
    assert.equal(ids.includes("fork-unresolved:j-empty"), false);
  });
});

test("input validation throws TypeError before database effects on malformed or lone surrogate sources even with closed db", () => {
  withDb((db) => {
    db.close();

    const nonStrings = [null, undefined, 123, {}, [], true, Symbol("source")];
    for (const val of nonStrings) {
      assert.throws(
        () => clearUnresolvedNoticesIn(db, val as unknown as string),
        { name: "TypeError", message: "source must be a string" }
      );
    }

    const loneSurrogates = [
      "\uD800",
      "\uD800abc",
      "\uDC00",
      "abc\uDC00",
      "\uDC00\uD800",
      "test\uD800mid",
    ];
    for (const val of loneSurrogates) {
      assert.throws(
        () => clearUnresolvedNoticesIn(db, val),
        { name: "TypeError", message: "source must not contain lone surrogates" }
      );
    }
  });
});

test("native SQLite delete triggers log proves queue notices are deleted before intake notices", () => {
  withDb((db) => {
    initTables(db);

    db.exec(
      "CREATE TABLE delete_execution_log (" +
      "seq INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "delivery_id TEXT NOT NULL, " +
      "source_phase TEXT NOT NULL" +
      ")"
    );

    db.exec(
      "CREATE TRIGGER trg_log_outbox_delete AFTER DELETE ON codex_delivery_outbox " +
      "BEGIN " +
      "INSERT INTO delete_execution_log (delivery_id, source_phase) " +
      "VALUES (OLD.delivery_id, CASE " +
      "WHEN OLD.delivery_id LIKE 'fork-unresolved-intake:%' THEN 'intake' " +
      "ELSE 'queue' END); " +
      "END"
    );

    insertQueueJob(db, "job-q", "thread-log", "pending");
    insertIntake(db, "job-i", "thread-log");
    insertOutbox(db, "fork-unresolved:job-q", "job-q", "thread-log");
    insertOutbox(db, "fork-unresolved-intake:job-i", "job-i", "thread-log");

    clearUnresolvedNoticesIn(db, "thread-log");

    const logs = db.prepare("SELECT delivery_id, source_phase FROM delete_execution_log ORDER BY seq ASC").all() as Array<{
      delivery_id: string;
      source_phase: string;
    }>;

    assert.equal(logs.length, 2);
    assert.equal(logs[0]?.delivery_id, "fork-unresolved:job-q");
    assert.equal(logs[0]?.source_phase, "queue");
    assert.equal(logs[1]?.delivery_id, "fork-unresolved-intake:job-i");
    assert.equal(logs[1]?.source_phase, "intake");
  });
});
