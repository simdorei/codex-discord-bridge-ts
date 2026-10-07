import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  DEFINITE_FORK_ERROR_PREFIX,
  definiteNotice,
} from "../../src/store/fork-definite-format.ts";
import {
  ForkHandoffConflictingIntentError,
  stageDefiniteNoticesIn,
} from "../../src/store/fork-definite-stage.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";

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
  channelId: bigint | number,
  state: string,
  createdAt: number,
  lastError: string | Uint8Array = "",
): void {
  db.prepare(
    "INSERT INTO codex_turn_queue (job_id, target_thread_id, channel_id, owner_user_id, " +
      "discord_message_id, prompt, queued, ack_sent, state, attempt_count, turn_id, " +
      "baseline_turn_ids, last_error, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    jobId,
    targetThreadId,
    channelId,
    1n,
    2n,
    "p",
    1,
    1,
    state,
    0,
    "turn-" + jobId,
    "[]",
    lastError,
    createdAt,
    createdAt,
  );
}

test("1: i64 extrema native BigInt, count, order, and unrelated fields preservation", () => {
  withDb((db) => {
    initTables(db);
    const i64Max = 9223372036854775807n;
    const i64Min = -9223372036854775808n;

    insertQueueJob(db, "job-2", "th-1", i64Min, "starting", 10.0, "prev-err");
    insertQueueJob(db, "job-1", "th-1", i64Max, "pending", 20.0, "");
    insertQueueJob(db, "job-running", "th-1", 100n, "running", 5.0, "keep-run");
    insertQueueJob(db, "job-other", "th-other", 200n, "pending", 6.0, "keep-other");

    db.exec(
      "CREATE TABLE order_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT);" +
        "CREATE TRIGGER log_order AFTER UPDATE ON codex_turn_queue BEGIN " +
        "INSERT INTO order_audit (job_id) VALUES (NEW.job_id); END;",
    );

    const count = stageDefiniteNoticesIn(db, "h-1", "th-1", "fork-err");
    assert.equal(count, 2n);

    const audit = db.prepare("SELECT job_id FROM order_audit ORDER BY seq").all() as Array<{ job_id: string }>;
    assert.deepEqual(audit.map((r) => r.job_id), ["job-2", "job-1"]);

    const qRows = db.prepare(
      "SELECT job_id, last_error, updated_at FROM codex_turn_queue ORDER BY created_at",
    ).all() as Array<{ job_id: string; last_error: string; updated_at: number }>;
    assert.equal(qRows.length, 4);

    assert.equal(qRows[0]?.job_id, "job-running");
    assert.equal(qRows[0]?.last_error, "keep-run");
    assert.equal(qRows[0]?.updated_at, 5.0);

    assert.equal(qRows[1]?.job_id, "job-other");
    assert.equal(qRows[1]?.last_error, "keep-other");
    assert.equal(qRows[1]?.updated_at, 6.0);

    assert.equal(qRows[2]?.job_id, "job-2");
    assert.equal(
      qRows[2]?.last_error,
      `${DEFINITE_FORK_ERROR_PREFIX}fork-err\nPrevious error: prev-err`,
    );

    assert.equal(qRows[3]?.job_id, "job-1");
    assert.equal(qRows[3]?.last_error, `${DEFINITE_FORK_ERROR_PREFIX}fork-err`);

    const outboxStmt = db.prepare(
      "SELECT delivery_id, job_id, channel_id, content FROM codex_delivery_outbox ORDER BY rowid",
    );
    outboxStmt.setReadBigInts(true);
    const outbox = outboxStmt.all() as Array<{ delivery_id: string; job_id: string; channel_id: bigint; content: string }>;
    assert.equal(outbox.length, 2);
    assert.equal(outbox[0]?.delivery_id, "fork-definite:h-1:job-2");
    assert.equal(outbox[0]?.channel_id, i64Min);
    assert.equal(outbox[1]?.delivery_id, "fork-definite:h-1:job-1");
    assert.equal(outbox[1]?.channel_id, i64Max);
  });
});

test("2: eager second row decode failure before any writes or clock reads", () => {
  const cases: Array<{
    name: string;
    insertBadRow: (db: DatabaseSync) => void;
    expectedMsg: string;
  }> = [
    {
      name: "REAL channel_id",
      insertBadRow: (db) => {
        insertQueueJob(db, "j-bad-real", "th-2", 123.45, "pending", 20.0);
      },
      expectedMsg: "Expected integer bigint for column channel_id, received number",
    },
    {
      name: "invalid TEXT type in last_error",
      insertBadRow: (db) => {
        insertQueueJob(db, "j-bad-text", "th-2", 2n, "pending", 20.0, new Uint8Array([1]));
      },
      expectedMsg: "Expected string for column last_error, received object",
    },
  ];

  for (const c of cases) {
    withDb((db) => {
      initTables(db);
      insertQueueJob(db, "j-good", "th-2", 1n, "pending", 10.0, "orig-err");
      c.insertBadRow(db);
      if (c.name === "invalid TEXT type in last_error") {
        const stored = db.prepare(
          "SELECT typeof(last_error) AS stored_type, last_error FROM codex_turn_queue WHERE job_id = 'j-bad-text'",
        ).get() as { stored_type: string; last_error: Uint8Array };
        assert.equal(stored.stored_type, "blob");
        assert.ok(stored.last_error instanceof Uint8Array);
        assert.deepEqual(stored.last_error, new Uint8Array([1]));
      }

      db.exec(
        "CREATE TRIGGER no_queue_update BEFORE UPDATE ON codex_turn_queue BEGIN " +
          "SELECT RAISE(ABORT, 'unexpected queue update'); END;" +
        "CREATE TRIGGER no_outbox_insert BEFORE INSERT ON codex_delivery_outbox BEGIN " +
          "SELECT RAISE(ABORT, 'unexpected outbox insert'); END;",
      );

      let clockReads = 0;
      const origDateNow = Date.now;
      Date.now = () => {
        clockReads++;
        return 1700000000000;
      };

      try {
        assert.throws(
          () => stageDefiniteNoticesIn(db, "h-2", "th-2", "fork-err"),
          (err: unknown) => {
            assert.ok(err instanceof StoreIntegrityError);
            assert.equal(err.result, c.expectedMsg);
            return true;
          },
        );
      } finally {
        Date.now = origDateNow;
      }

      assert.equal(clockReads, 0, `no clock reads on ${c.name}`);
      const goodRow = db.prepare(
        "SELECT last_error, updated_at FROM codex_turn_queue WHERE job_id = 'j-good'",
      ).get() as { last_error: string; updated_at: number } | undefined;
      assert.ok(goodRow);
      assert.equal(goodRow.last_error, "orig-err");
      assert.equal(goodRow.updated_at, 10.0);
      const outboxCount = db.prepare("SELECT COUNT(*) AS c FROM codex_delivery_outbox").get() as { c: bigint | number };
      assert.equal(Number(outboxCount.c), 0);
    });
  }
});

test("3: CAS changes 0 (RAISE IGNORE) and changes > 1 both throw ConflictingIntent before second clock and outbox write", () => {
  const cases = [
    {
      name: "CAS 0 via BEFORE UPDATE RAISE(IGNORE)",
      setup: (db: DatabaseSync) => {
        initTables(db);
        insertQueueJob(db, "job-cas-0", "th-cas", 1n, "pending", 10.0);
        db.exec(
          "CREATE TRIGGER cas_ignore BEFORE UPDATE ON codex_turn_queue BEGIN " +
            "SELECT RAISE(IGNORE); END;",
        );
      },
    },
    {
      name: "CAS > 1 via duplicate job_id schema variant",
      setup: (db: DatabaseSync) => {
        db.exec(
          "CREATE TABLE codex_turn_queue (job_id TEXT, target_thread_id TEXT NOT NULL, " +
            "channel_id INTEGER NOT NULL, owner_user_id INTEGER, discord_message_id INTEGER, " +
            "prompt TEXT NOT NULL, queued INTEGER NOT NULL, ack_sent INTEGER NOT NULL, " +
            "state TEXT NOT NULL, attempt_count INTEGER NOT NULL, turn_id TEXT, " +
            "baseline_turn_ids TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '', " +
            "created_at REAL NOT NULL, updated_at REAL NOT NULL)",
        );
        db.exec(OUTBOX_DDL);
        db.exec(INTAKES_DDL);
        insertQueueJob(db, "job-dup", "th-cas", 1n, "pending", 10.0);
        insertQueueJob(db, "job-dup", "th-cas", 1n, "pending", 10.0);
      },
    },
  ];

  for (const c of cases) {
    withDb((db) => {
      c.setup(db);

      let clockReads = 0;
      const origDateNow = Date.now;
      Date.now = () => {
        clockReads++;
        return 1700000000000 + clockReads * 1000;
      };

      try {
        assert.throws(
          () => stageDefiniteNoticesIn(db, "h-cas", "th-cas", "cas-err"),
          (err: unknown) => {
            assert.ok(err instanceof ForkHandoffConflictingIntentError);
            assert.equal(err.kind, "ConflictingIntent");
            assert.equal(err.sourceThreadId, "th-cas");
            assert.equal(
              err.message,
              "a different fork handoff already fences source thread th-cas",
            );
            return true;
          },
        );
      } finally {
        Date.now = origDateNow;
      }

      assert.equal(clockReads, 1, `only 1 clock read before abort on ${c.name}`);
      const outboxCount = db.prepare("SELECT COUNT(*) AS c FROM codex_delivery_outbox").get() as { c: bigint | number };
      assert.equal(Number(outboxCount.c), 0);
    });
  }
});

test("4: NOCASE uppercase raw state preserved across queue decode and update", () => {
  for (const rawState of ["PENDING", "STARTING"]) {
    withDb((db) => {
      db.exec(
        QUEUE_DDL.replace(
          "state TEXT NOT NULL",
          "state TEXT COLLATE NOCASE NOT NULL",
        ),
      );
      db.exec(OUTBOX_DDL);
      db.exec(INTAKES_DDL);

      insertQueueJob(db, `job-${rawState}`, "th-nocase", 10n, rawState, 15.0);

      const affected = stageDefiniteNoticesIn(
        db,
        "h-nocase",
        "th-nocase",
        "state-err",
      );
      assert.equal(affected, 1n);

      const row = db.prepare(
        "SELECT state, last_error FROM codex_turn_queue WHERE job_id = ?",
      ).get(`job-${rawState}`) as { state: string; last_error: string } | undefined;
      assert.ok(row);
      assert.equal(row.state, rawState, "uppercase raw state must be preserved exactly");
      assert.ok(row.last_error.startsWith(DEFINITE_FORK_ERROR_PREFIX));

      const outboxStmt = db.prepare(
        "SELECT delivery_id, channel_id FROM codex_delivery_outbox",
      );
      outboxStmt.setReadBigInts(true);
      const outbox = outboxStmt.all() as Array<{ delivery_id: string; channel_id: bigint }>;
      assert.equal(outbox.length, 1);
      assert.equal(outbox[0]?.delivery_id, `fork-definite:h-nocase:job-${rawState}`);
      assert.equal(outbox[0]?.channel_id, 10n);
    });
  }
});

test("5: input validation, valid Unicode identities, and closed handle rejects valid input", () => {
  withDb((db) => {
    initTables(db);

    db.exec(
      "CREATE TRIGGER fail_hook BEFORE UPDATE ON codex_turn_queue BEGIN " +
        "SELECT RAISE(ABORT, 'hook should not run'); END;",
    );

    const invalidInputs: Array<{
      name: string;
      call: () => void;
      expectedError: RegExp;
    }> = [
      {
        name: "null handoffId",
        call: () => stageDefiniteNoticesIn(db, null as unknown as string, "th", "err"),
        expectedError: /Expected string for handoffId, received null/,
      },
      {
        name: "number source",
        call: () => stageDefiniteNoticesIn(db, "h", 123 as unknown as string, "err"),
        expectedError: /Expected string for source, received number/,
      },
      {
        name: "surrogate in handoffId",
        call: () => stageDefiniteNoticesIn(db, "h" + String.fromCharCode(0xd800) + "id", "th", "err"),
        expectedError: /Invalid Unicode surrogate in handoffId/,
      },
      {
        name: "surrogate in source",
        call: () => stageDefiniteNoticesIn(db, "h", "th" + String.fromCharCode(0xdfff) + "s", "err"),
        expectedError: /Invalid Unicode surrogate in source/,
      },
      {
        name: "surrogate in forkError",
        call: () => stageDefiniteNoticesIn(db, "h", "th", "err" + String.fromCharCode(0xd834)),
        expectedError: /Invalid Unicode surrogate in forkError/,
      },
      {
        name: "invalid db type",
        call: () => stageDefiniteNoticesIn(null as unknown as DatabaseSync, "h", "th", "err"),
        expectedError: /Expected DatabaseSync instance for db/,
      },
    ];

    for (const inv of invalidInputs) {
      assert.throws(inv.call, inv.expectedError, `failed for ${inv.name}`);
    }

    const validHandoff = "handoff" + String.fromCharCode(0, 0xfeff) + "🎉";
    const validSource = "thread" + String.fromCharCode(0, 0xfeff) + "🦀";
    const validError = "err" + String.fromCharCode(0, 0xfeff) + "🔥";

    insertQueueJob(db, "job-unicode", validSource, 777n, "pending", 50.0);
    db.exec("DROP TRIGGER fail_hook;");

    const count = stageDefiniteNoticesIn(db, validHandoff, validSource, validError);
    assert.equal(count, 1n);

    const q = db.prepare("SELECT last_error FROM codex_turn_queue WHERE job_id = 'job-unicode'").get() as { last_error: string } | undefined;
    assert.ok(q);
    assert.equal(q.last_error, `${DEFINITE_FORK_ERROR_PREFIX}${validError}`);

    const out = db.prepare("SELECT delivery_id, content FROM codex_delivery_outbox").get() as { delivery_id: string; content: string } | undefined;
    assert.ok(out);
    assert.equal(out.delivery_id, `fork-definite:${validHandoff}:job-unicode`);
    assert.ok(out.content.includes(validError));
  });

  withDb((preclosed) => {
    preclosed.close();
    assert.throws(
      () => stageDefiniteNoticesIn(preclosed, "h", "th", "err"),
      /database is (not open|closed)/i,
    );
  });
});

test("6: UTF-16le native encoding under test-owned fixture", () => {
  withDb((db) => {
    db.exec("PRAGMA encoding = 'UTF-16le';");
    initTables(db);

    const pragmaRow = db.prepare("PRAGMA encoding;").get() as Record<string, unknown> | undefined;
    assert.ok(pragmaRow);
    assert.equal(Object.values(pragmaRow)[0], "UTF-16le");

    const utf16Source = "th-utf16-가나다";
    const utf16Error = "오류-폭탄-💥";
    insertQueueJob(db, "job-utf16", utf16Source, 888n, "pending", 30.0, "이전오류");

    const count = stageDefiniteNoticesIn(db, "h-utf16", utf16Source, utf16Error);
    assert.equal(count, 1n);

    const q = db.prepare(
      "SELECT last_error FROM codex_turn_queue WHERE job_id = 'job-utf16'",
    ).get() as { last_error: string } | undefined;
    assert.ok(q);
    assert.equal(
      q.last_error,
      `${DEFINITE_FORK_ERROR_PREFIX}${utf16Error}\nPrevious error: 이전오류`,
    );

    const outStmt = db.prepare(
      "SELECT delivery_id, channel_id, content FROM codex_delivery_outbox",
    );
    outStmt.setReadBigInts(true);
    const out = outStmt.get() as { delivery_id: string; channel_id: bigint; content: string } | undefined;
    assert.ok(out);
    assert.equal(out.delivery_id, "fork-definite:h-utf16:job-utf16");
    assert.equal(out.channel_id, 888n);
    assert.equal(out.content, definiteNotice(utf16Error, "이전오류"));
  });
});
