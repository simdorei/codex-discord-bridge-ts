import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  migrateClaims,
  schemaCurrentClaims,
  migrateDeliveryReceipt,
  schemaCurrentDeliveryReceipt,
  migrateCommentaryOutbox,
  schemaCurrentCommentaryOutbox,
  migrateMirrorContext,
  schemaCurrentMirrorContext,
  migratePromptIntake,
  schemaCurrentPromptIntake,
  migrateDeadGeneration,
  schemaCurrentDeadGeneration,
} from "../../src/store/schema-extensions-b1.ts";

describe("Claims migration and schema_current", () => {
  it("claims - fresh migration and current detection on V1 fixture", () => {
    const db = new DatabaseSync(":memory:");
    try {
      assert.equal(schemaCurrentClaims(db), false);
      db.exec(
        "CREATE TABLE IF NOT EXISTS busy_choices (choice_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, channel_id INTEGER NOT NULL, target_thread_id TEXT, prompt TEXT NOT NULL, allow_steer INTEGER NOT NULL, created_at REAL NOT NULL, expires_at REAL NOT NULL, claimed_at REAL)",
      );
      assert.equal(schemaCurrentClaims(db), false);
      migrateClaims(db);
      assert.equal(schemaCurrentClaims(db), true);
    } finally {
      db.close();
    }
  });

  it("claims - legacy NULL require_current_mirror, repeat migration, and CHECK constraint", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE IF NOT EXISTS busy_choices (choice_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, channel_id INTEGER NOT NULL, target_thread_id TEXT, prompt TEXT NOT NULL, allow_steer INTEGER NOT NULL, created_at REAL NOT NULL, expires_at REAL NOT NULL, claimed_at REAL)",
      );
      db.exec(
        "INSERT INTO busy_choices VALUES ('c1', 1, 2, 'th1', 'prompt', 1, 100.0, 200.0, NULL)",
      );
      migrateClaims(db);
      assert.equal(schemaCurrentClaims(db), true);

      // Repeat migration is idempotent and leaves catalog/data stable
      migrateClaims(db);
      assert.equal(schemaCurrentClaims(db), true);

      const row = db
        .prepare("SELECT require_current_mirror FROM busy_choices WHERE choice_id = 'c1'")
        .get() as { require_current_mirror: unknown } | undefined;
      assert.ok(row);
      assert.equal(row.require_current_mirror, null);

      // CHECK NULL passes SQLite not implicitly NOT NULL
      db.exec(
        "INSERT INTO busy_choices VALUES ('c2', 1, 2, 'th1', 'prompt', 1, 100.0, 200.0, NULL, NULL)",
      );

      // CHECK constraint IN (0, 1) rejects invalid values
      assert.throws(() => {
        db.exec(
          "INSERT INTO busy_choices VALUES ('c3', 1, 2, 'th1', 'prompt', 1, 100.0, 200.0, NULL, 2)",
        );
      });
    } finally {
      db.close();
    }
  });
});

describe("DeliveryReceipt migration and schema_current", () => {
  it("delivery_receipt - fresh migration and schema current detection", () => {
    const db = new DatabaseSync(":memory:");
    try {
      assert.equal(schemaCurrentDeliveryReceipt(db), false);
      migrateDeliveryReceipt(db);
      assert.equal(schemaCurrentDeliveryReceipt(db), true);
      // repeat migration stable
      migrateDeliveryReceipt(db);
      assert.equal(schemaCurrentDeliveryReceipt(db), true);
    } finally {
      db.close();
    }
  });

  it("delivery_receipt - legacy migration preserves existing rows with defaults (retryable=0, blocked_reason=NULL)", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE codex_delivery_receipts (receipt_key TEXT PRIMARY KEY, content_hash TEXT NOT NULL, message_id TEXT);",
      );
      db.exec("INSERT INTO codex_delivery_receipts VALUES ('k-unknown', 'hash1', NULL)");
      db.exec("INSERT INTO codex_delivery_receipts VALUES ('k-msg', 'hash2', 'msg-999')");

      assert.equal(schemaCurrentDeliveryReceipt(db), false);
      migrateDeliveryReceipt(db);
      assert.equal(schemaCurrentDeliveryReceipt(db), true);

      const rowUnknown = db
        .prepare(
          "SELECT receipt_key, content_hash, message_id, retryable, blocked_reason FROM codex_delivery_receipts WHERE receipt_key = 'k-unknown'",
        )
        .get() as {
        receipt_key: string;
        content_hash: string;
        message_id: string | null;
        retryable: number;
        blocked_reason: string | null;
      };
      assert.equal(rowUnknown.receipt_key, "k-unknown");
      assert.equal(rowUnknown.content_hash, "hash1");
      assert.equal(rowUnknown.message_id, null);
      assert.equal(rowUnknown.retryable, 0);
      assert.equal(rowUnknown.blocked_reason, null);

      const rowMsg = db
        .prepare(
          "SELECT receipt_key, content_hash, message_id, retryable, blocked_reason FROM codex_delivery_receipts WHERE receipt_key = 'k-msg'",
        )
        .get() as {
        receipt_key: string;
        content_hash: string;
        message_id: string | null;
        retryable: number;
        blocked_reason: string | null;
      };
      assert.equal(rowMsg.receipt_key, "k-msg");
      assert.equal(rowMsg.content_hash, "hash2");
      assert.equal(rowMsg.message_id, "msg-999");
      assert.equal(rowMsg.retryable, 0);
      assert.equal(rowMsg.blocked_reason, null);
    } finally {
      db.close();
    }
  });
});

describe("CommentaryOutbox migration and schema_current", () => {
  it("commentary_outbox - fresh migration, schema current detection, and repeat migration", () => {
    const db = new DatabaseSync(":memory:");
    try {
      assert.equal(schemaCurrentCommentaryOutbox(db), false);
      migrateCommentaryOutbox(db);
      assert.equal(schemaCurrentCommentaryOutbox(db), true);

      db.exec(
        "INSERT INTO codex_commentary_outbox (delivery_key, job_id, target_thread_id, turn_id, channel_id, text) VALUES ('dk1', 'job1', 't1', 'turn1', 123, 'hello commentary')",
      );

      // Repeat migration is idempotent and data intact
      migrateCommentaryOutbox(db);
      assert.equal(schemaCurrentCommentaryOutbox(db), true);

      const row = db
        .prepare(
          "SELECT sequence, delivery_key, text FROM codex_commentary_outbox WHERE delivery_key = 'dk1'",
        )
        .get() as { sequence: number; delivery_key: string; text: string };
      assert.equal(row.delivery_key, "dk1");
      assert.equal(row.text, "hello commentary");
    } finally {
      db.close();
    }
  });
});

describe("MirrorContext migration and schema_current", () => {
  it("mirror_context - fresh migration and schema current detection", () => {
    const db = new DatabaseSync(":memory:");
    try {
      assert.equal(schemaCurrentMirrorContext(db), false);
      migrateMirrorContext(db);
      assert.equal(schemaCurrentMirrorContext(db), true);
      migrateMirrorContext(db);
      assert.equal(schemaCurrentMirrorContext(db), true);
    } finally {
      db.close();
    }
  });

  it("mirror_context - legacy fixture migration adds turn_context with NULL for existing rows", () => {
    const db = new DatabaseSync(":memory:");
    try {
      // V1_SCHEMA legacy fixture
      db.exec(
        "CREATE TABLE IF NOT EXISTS codex_session_mirror_offsets (codex_thread_id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cursor INTEGER NOT NULL, updated_at REAL NOT NULL)",
      );
      db.exec(
        "INSERT INTO codex_session_mirror_offsets VALUES ('th-old', '/path/rollout', 42, 1700000000.0)",
      );
      assert.equal(schemaCurrentMirrorContext(db), false);

      migrateMirrorContext(db);
      assert.equal(schemaCurrentMirrorContext(db), true);

      const row = db
        .prepare(
          "SELECT codex_thread_id, rollout_path, cursor, updated_at, turn_context FROM codex_session_mirror_offsets WHERE codex_thread_id = 'th-old'",
        )
        .get() as {
        codex_thread_id: string;
        rollout_path: string;
        cursor: number;
        updated_at: number;
        turn_context: string | null;
      };
      assert.equal(row.codex_thread_id, "th-old");
      assert.equal(row.rollout_path, "/path/rollout");
      assert.equal(row.cursor, 42);
      assert.equal(row.updated_at, 1700000000.0);
      assert.equal(row.turn_context, null);
    } finally {
      db.close();
    }
  });
});

describe("PromptIntake migration and schema_current", () => {
  it("prompt_intake - fresh migration, indexes, and schema current detection", () => {
    const db = new DatabaseSync(":memory:");
    try {
      assert.equal(schemaCurrentPromptIntake(db), false);
      migratePromptIntake(db);
      assert.equal(schemaCurrentPromptIntake(db), true);
      migratePromptIntake(db);
      assert.equal(schemaCurrentPromptIntake(db), true);
    } finally {
      db.close();
    }
  });

  it("prompt_intake - legacy partial table adds missing columns with defaults preserving job", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE codex_prompt_intakes (job_id TEXT PRIMARY KEY)");
      db.exec("INSERT INTO codex_prompt_intakes (job_id) VALUES ('job-preserve-1')");
      assert.equal(schemaCurrentPromptIntake(db), false);

      migratePromptIntake(db);
      assert.equal(schemaCurrentPromptIntake(db), true);

      const row = db
        .prepare("SELECT * FROM codex_prompt_intakes WHERE job_id = 'job-preserve-1'")
        .get() as Record<string, unknown>;
      assert.equal(row["job_id"], "job-preserve-1");
      assert.equal(row["target_thread_id"], "");
      assert.equal(row["channel_id"], 0);
      assert.equal(row["owner_user_id"], null);
      assert.equal(row["discord_message_id"], null);
      assert.equal(row["raw_prompt"], "");
      assert.equal(row["auto_queue_when_busy"], 0);
      assert.equal(row["require_current_mirror"], 0);
      assert.equal(row["attempt_count"], 0);
      assert.equal(row["last_error"], "");
      assert.equal(row["retry_after"], 0);
      assert.equal(row["claim_token"], null);
      assert.equal(row["claim_expires_at"], 0);
      assert.equal(row["created_at"], 0);
      assert.equal(row["updated_at"], 0);
    } finally {
      db.close();
    }
  });

  it("prompt_intake - missing job_id throws StoreIntegrityError before ALTER", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE codex_prompt_intakes (other_id TEXT PRIMARY KEY)");
      assert.throws(
        () => {
          migratePromptIntake(db);
        },
        (err: unknown) => {
          const error = err as Error & { kind?: string };
          assert.equal(
            error.message,
            "SQLite integrity check failed: codex_prompt_intakes is missing its job_id primary identity",
          );
          assert.equal(error.kind, "Integrity");
          return true;
        },
      );
      // Verify no columns were added by ALTER TABLE
      const cols = db
        .prepare("PRAGMA table_info(codex_prompt_intakes)")
        .all() as Array<{ name: string }>;
      assert.equal(cols.length, 1);
      assert.equal(cols[0]?.name, "other_id");
    } finally {
      db.close();
    }
  });

  it("prompt_intake - dropped index detection and repair on re-migration", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migratePromptIntake(db);
      assert.equal(schemaCurrentPromptIntake(db), true);

      // Drop unique index
      db.exec("DROP INDEX codex_prompt_intakes_message_id");
      assert.equal(schemaCurrentPromptIntake(db), false);
      migratePromptIntake(db);
      assert.equal(schemaCurrentPromptIntake(db), true);

      // Drop target ready index
      db.exec("DROP INDEX codex_prompt_intakes_target_ready");
      assert.equal(schemaCurrentPromptIntake(db), false);
      migratePromptIntake(db);
      assert.equal(schemaCurrentPromptIntake(db), true);
    } finally {
      db.close();
    }
  });

  it("prompt_intake - boolean CHECK constraints enforce 0/1 and allow NULL where valid", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migratePromptIntake(db);
      // Valid insert
      db.exec(
        "INSERT INTO codex_prompt_intakes (job_id, target_thread_id, channel_id, raw_prompt, auto_queue_when_busy, require_current_mirror, created_at, updated_at) VALUES ('j-valid', 'th1', 10, 'prompt', 1, 0, 100.0, 100.0)",
      );

      // Invalid auto_queue_when_busy CHECK violation
      assert.throws(() => {
        db.exec(
          "INSERT INTO codex_prompt_intakes (job_id, target_thread_id, channel_id, raw_prompt, auto_queue_when_busy, require_current_mirror, created_at, updated_at) VALUES ('j-bad-1', 'th1', 10, 'prompt', 2, 0, 100.0, 100.0)",
        );
      });

      // Invalid require_current_mirror CHECK violation
      assert.throws(() => {
        db.exec(
          "INSERT INTO codex_prompt_intakes (job_id, target_thread_id, channel_id, raw_prompt, auto_queue_when_busy, require_current_mirror, created_at, updated_at) VALUES ('j-bad-2', 'th1', 10, 'prompt', 0, 5, 100.0, 100.0)",
        );
      });
    } finally {
      db.close();
    }
  });
});

describe("DeadGeneration migration and schema_current", () => {
  it("dead_generation - 3 tables catalog detection, repeat migration, and singleton CHECK", () => {
    const db = new DatabaseSync(":memory:");
    try {
      assert.equal(schemaCurrentDeadGeneration(db), false);
      migrateDeadGeneration(db);
      assert.equal(schemaCurrentDeadGeneration(db), true);
      migrateDeadGeneration(db);
      assert.equal(schemaCurrentDeadGeneration(db), true);

      // Verify singleton CHECK
      db.exec(
        "INSERT INTO codex_app_server_runtime (singleton, runtime_id) VALUES (1, 'rt-alpha')",
      );
      assert.throws(() => {
        db.exec(
          "INSERT INTO codex_app_server_runtime (singleton, runtime_id) VALUES (2, 'rt-beta')",
        );
      });
    } finally {
      db.close();
    }
  });

  it("dead_generation - preserves opaque JSON and bigint generation with setReadBigInts", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateDeadGeneration(db);

      const runtimeId = "rt-prod-1";
      const generation = 9007199254740993n; // exceeds Number.MAX_SAFE_INTEGER
      const snapshotJson = JSON.stringify({ state: "halted", memoryMb: 1024, flags: [true, false] });
      const queueJobsJson = JSON.stringify(["job-uuid-1", "job-uuid-2"]);
      const createdAt = 1700000050.25;

      const insertStmt = db.prepare(
        "INSERT INTO codex_dead_generation_incidents (runtime_id, generation, snapshot_json, queue_jobs_json, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      insertStmt.run(runtimeId, generation, snapshotJson, queueJobsJson, createdAt);

      const readStmt = db.prepare(
        "SELECT runtime_id, generation, snapshot_json, queue_jobs_json, created_at FROM codex_dead_generation_incidents WHERE runtime_id = ?",
      );
      readStmt.setReadBigInts(true);
      const row = readStmt.get(runtimeId) as {
        runtime_id: string;
        generation: bigint;
        snapshot_json: string;
        queue_jobs_json: string;
        created_at: number;
      };

      assert.equal(row.runtime_id, runtimeId);
      assert.equal(row.generation, 9007199254740993n);
      assert.equal(row.snapshot_json, snapshotJson);
      assert.equal(row.queue_jobs_json, queueJobsJson);
      assert.deepEqual(JSON.parse(row.snapshot_json), { state: "halted", memoryMb: 1024, flags: [true, false] });
      assert.deepEqual(JSON.parse(row.queue_jobs_json), ["job-uuid-1", "job-uuid-2"]);
    } finally {
      db.close();
    }
  });
});

describe("Caller transaction rollback", () => {
  it("caller BEGIN IMMEDIATE rollback reverts schema changes across extensions", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE IF NOT EXISTS busy_choices (choice_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, channel_id INTEGER NOT NULL, target_thread_id TEXT, prompt TEXT NOT NULL, allow_steer INTEGER NOT NULL, created_at REAL NOT NULL, expires_at REAL NOT NULL, claimed_at REAL)",
      );
      assert.equal(schemaCurrentClaims(db), false);

      db.exec("BEGIN IMMEDIATE");
      migrateClaims(db);
      migrateDeliveryReceipt(db);
      migrateCommentaryOutbox(db);
      migrateMirrorContext(db);
      migratePromptIntake(db);
      migrateDeadGeneration(db);

      assert.equal(schemaCurrentClaims(db), true);
      assert.equal(schemaCurrentDeliveryReceipt(db), true);
      assert.equal(schemaCurrentCommentaryOutbox(db), true);
      assert.equal(schemaCurrentMirrorContext(db), true);
      assert.equal(schemaCurrentPromptIntake(db), true);
      assert.equal(schemaCurrentDeadGeneration(db), true);

      db.exec("ROLLBACK");

      assert.equal(schemaCurrentClaims(db), false);
      assert.equal(schemaCurrentDeliveryReceipt(db), false);
      assert.equal(schemaCurrentCommentaryOutbox(db), false);
      assert.equal(schemaCurrentMirrorContext(db), false);
      assert.equal(schemaCurrentPromptIntake(db), false);
      assert.equal(schemaCurrentDeadGeneration(db), false);
    } finally {
      db.close();
    }
  });
});
