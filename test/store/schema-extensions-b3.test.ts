import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  migrateRoomCleanup,
  schemaCurrentRoomCleanup,
} from "../../src/store/schema-extensions-b3.ts";

function createPrerequisiteDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE codex_goal_progress (
      thread TEXT,
      channel INTEGER
    );
    CREATE TABLE codex_commentary_outbox (
      target_thread_id TEXT,
      channel_id INTEGER
    );
    CREATE TABLE codex_turn_queue (
      target_thread_id TEXT,
      channel_id INTEGER
    );
    CREATE TABLE codex_prompt_intakes (
      target_thread_id TEXT,
      channel_id INTEGER
    );
    CREATE TABLE codex_delivery_outbox (
      target_thread_id TEXT,
      channel_id INTEGER
    );
    CREATE TABLE busy_choices (
      target_thread_id TEXT,
      channel_id INTEGER
    );
    CREATE TABLE mirror_threads (
      codex_thread_id TEXT,
      discord_thread_id INTEGER,
      discord_channel_id INTEGER
    );
    CREATE TABLE mirror_projects (
      discord_channel_id INTEGER
    );
    CREATE TABLE discord_ingress_journal (
      ingress_id TEXT PRIMARY KEY,
      channel_id INTEGER,
      target_thread_id TEXT,
      state TEXT,
      phase TEXT,
      hold_reason TEXT
    );
    CREATE TABLE codex_delivery_receipts (
      receipt_key TEXT PRIMARY KEY
    );
  `);
  return db;
}

describe("fresh database schema currentness", () => {
  it("returns false on a blank database without tables", () => {
    const db = new DatabaseSync(":memory:");
    try {
      assert.equal(schemaCurrentRoomCleanup(db), false);
    } finally {
      db.close();
    }
  });

  it("returns false when only prerequisite tables exist prior to room cleanup migration", () => {
    const db = createPrerequisiteDb();
    try {
      assert.equal(schemaCurrentRoomCleanup(db), false);
    } finally {
      db.close();
    }
  });
});

describe("migration idempotence and schema signature stability", () => {
  it("migrates schema to current and keeps sqlite_schema signatures strictly identical across repeated runs", () => {
    const db = createPrerequisiteDb();
    try {
      migrateRoomCleanup(db);
      assert.equal(schemaCurrentRoomCleanup(db), true);

      const readSignature = () =>
        db
          .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
          )
          .all() as { type: string; name: string; tbl_name: string; sql: string }[];

      const initialSignature = readSignature();

      migrateRoomCleanup(db);
      const secondSignature = readSignature();
      assert.deepEqual(secondSignature, initialSignature);

      migrateRoomCleanup(db);
      const thirdSignature = readSignature();
      assert.deepEqual(thirdSignature, initialSignature);

      assert.equal(schemaCurrentRoomCleanup(db), true);
    } finally {
      db.close();
    }
  });
});

describe("transaction rollback isolation", () => {
  it("leaves room cleanup tables absent when caller transaction rolls back", () => {
    const db = createPrerequisiteDb();
    try {
      db.exec("BEGIN");
      migrateRoomCleanup(db);
      assert.equal(schemaCurrentRoomCleanup(db), true);
      db.exec("ROLLBACK");

      assert.equal(schemaCurrentRoomCleanup(db), false);

      const createdTables = db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('cdr_archive_fences', 'cdr_archived_cleanup_evidence', 'cdr_cleanup_fences')",
        )
        .all();
      assert.equal(createdTables.length, 0);
    } finally {
      db.close();
    }
  });
});

describe("dropped schema components and self-repair", () => {
  it("detects dropped tables, triggers, and indices as non-current, then re-migration repairs them", () => {
    const db = createPrerequisiteDb();
    try {
      migrateRoomCleanup(db);
      assert.equal(schemaCurrentRoomCleanup(db), true);

      db.exec("DROP TABLE cdr_cleanup_fences;");
      assert.equal(schemaCurrentRoomCleanup(db), false);
      migrateRoomCleanup(db);
      assert.equal(schemaCurrentRoomCleanup(db), true);

      db.exec("DROP TRIGGER cdr_cleanup_busy_choices_INSERT;");
      assert.equal(schemaCurrentRoomCleanup(db), false);
      migrateRoomCleanup(db);
      assert.equal(schemaCurrentRoomCleanup(db), true);

      db.exec("DROP TRIGGER cdr_archive_mirror_threads_UPDATE;");
      assert.equal(schemaCurrentRoomCleanup(db), false);
      migrateRoomCleanup(db);
      assert.equal(schemaCurrentRoomCleanup(db), true);

      db.exec("DROP TRIGGER cdr_archived_cleanup_evidence_no_update;");
      assert.equal(schemaCurrentRoomCleanup(db), false);
      migrateRoomCleanup(db);
      assert.equal(schemaCurrentRoomCleanup(db), true);

      db.exec("DROP INDEX cdr_archived_cleanup_evidence_ingress;");
      assert.equal(schemaCurrentRoomCleanup(db), false);
      migrateRoomCleanup(db);
      assert.equal(schemaCurrentRoomCleanup(db), true);

      db.exec("DROP TRIGGER cdr_cleanup_receipt;");
      assert.equal(schemaCurrentRoomCleanup(db), false);
      migrateRoomCleanup(db);
      assert.equal(schemaCurrentRoomCleanup(db), true);
    } finally {
      db.close();
    }
  });
});

describe("archived cleanup evidence append-only enforcement", () => {
  it("allows inserting evidence rows but rejects UPDATE and DELETE with exact abort message", () => {
    const db = createPrerequisiteDb();
    try {
      migrateRoomCleanup(db);

      db.prepare(`
        INSERT INTO cdr_archived_cleanup_evidence (
          token, channel_id, target_thread_id, ingress_id,
          payload_json, outcome_json, row_snapshot_json, archive_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "token-test",
        1001,
        "thread-test",
        "interaction:1",
        "{}",
        "{}",
        "{}",
        "{}",
        1700000000.5,
      );

      assert.throws(
        () => {
          db.prepare(
            "UPDATE cdr_archived_cleanup_evidence SET channel_id = ? WHERE ingress_id = ?",
          ).run(9999, "interaction:1");
        },
        /archived cleanup evidence is append-only/,
      );

      assert.throws(
        () => {
          db.prepare(
            "DELETE FROM cdr_archived_cleanup_evidence WHERE ingress_id = ?",
          ).run("interaction:1");
        },
        /archived cleanup evidence is append-only/,
      );
    } finally {
      db.close();
    }
  });
});

describe("fence table constraints matching Rust authority", () => {
  it("enforces channel_id > 0 and restricted phase on cdr_cleanup_fences", () => {
    const db = createPrerequisiteDb();
    try {
      migrateRoomCleanup(db);

      assert.throws(
        () => {
          db.prepare(`
            INSERT INTO cdr_cleanup_fences (channel_id, target_thread_id, token, phase, created_at)
            VALUES (0, 'th-0', 'tok', 'deleting', 100)
          `).run();
        },
        /CHECK constraint failed/,
      );

      assert.throws(
        () => {
          db.prepare(`
            INSERT INTO cdr_cleanup_fences (channel_id, target_thread_id, token, phase, created_at)
            VALUES (-1, 'th-neg', 'tok', 'deleting', 100)
          `).run();
        },
        /CHECK constraint failed/,
      );

      assert.throws(
        () => {
          db.prepare(`
            INSERT INTO cdr_cleanup_fences (channel_id, target_thread_id, token, phase, created_at)
            VALUES (101, 'th-phase', 'tok', 'invalid_phase', 100)
          `).run();
        },
        /CHECK constraint failed/,
      );

      db.prepare(`
        INSERT INTO cdr_cleanup_fences (channel_id, target_thread_id, token, phase, created_at)
        VALUES (101, 'th-del', 'tok', 'deleting', 100)
      `).run();
      db.prepare(`
        INSERT INTO cdr_cleanup_fences (channel_id, target_thread_id, token, phase, created_at)
        VALUES (102, 'th-done', 'tok', 'deleted', 100)
      `).run();
    } finally {
      db.close();
    }
  });

  it("enforces json_valid(channels) and restricted phase on cdr_archive_fences", () => {
    const db = createPrerequisiteDb();
    try {
      migrateRoomCleanup(db);

      assert.throws(
        () => {
          db.prepare(`
            INSERT INTO cdr_archive_fences (target_thread_id, token, channels, phase, created_at)
            VALUES ('th-bad-json', 'tok', 'not-valid-json', 'deleting', 100)
          `).run();
        },
        /CHECK constraint failed/,
      );

      assert.throws(
        () => {
          db.prepare(`
            INSERT INTO cdr_archive_fences (target_thread_id, token, channels, phase, created_at)
            VALUES ('th-bad-phase', 'tok', '[1, 2]', 'active', 100)
          `).run();
        },
        /CHECK constraint failed/,
      );

      db.prepare(`
        INSERT INTO cdr_archive_fences (target_thread_id, token, channels, phase, created_at)
        VALUES ('th-ok-1', 'tok', '[10, 20]', 'deleting', 100)
      `).run();
      db.prepare(`
        INSERT INTO cdr_archive_fences (target_thread_id, token, channels, phase, created_at)
        VALUES ('th-ok-2', 'tok', '[]', 'deleted', 100)
      `).run();
    } finally {
      db.close();
    }
  });
});

describe("archive fences blocking guarded tables across declared columns", () => {
  it("blocks INSERT and UPDATE on matching target or channel while allowing unrelated rows", () => {
    const db = createPrerequisiteDb();
    try {
      migrateRoomCleanup(db);

      db.prepare(`
        INSERT INTO cdr_archive_fences (target_thread_id, token, channels, phase, created_at)
        VALUES ('fenced-thread', 'token-arch', '[2001, 2002]', 'deleting', 100)
      `).run();

      // 1. codex_goal_progress (thread, channel)
      assert.throws(() => {
        db.prepare("INSERT INTO codex_goal_progress (thread, channel) VALUES ('fenced-thread', 9999)").run();
      }, /archive deletion fenced; operation not executed/);
      assert.throws(() => {
        db.prepare("INSERT INTO codex_goal_progress (thread, channel) VALUES ('safe-thread', 2001)").run();
      }, /archive deletion fenced; operation not executed/);
      db.prepare("INSERT INTO codex_goal_progress (thread, channel) VALUES ('safe-thread', 9999)").run();
      assert.throws(() => {
        db.prepare("UPDATE codex_goal_progress SET thread = 'fenced-thread' WHERE thread = 'safe-thread'").run();
      }, /archive deletion fenced; operation not executed/);
      assert.throws(() => {
        db.prepare("UPDATE codex_goal_progress SET channel = 2002 WHERE thread = 'safe-thread'").run();
      }, /archive deletion fenced; operation not executed/);
      db.prepare("UPDATE codex_goal_progress SET channel = 9998 WHERE thread = 'safe-thread'").run();

      // 2-6. Standard target_thread_id / channel_id guarded table family
      const standardTables = [
        "codex_commentary_outbox",
        "codex_turn_queue",
        "codex_prompt_intakes",
        "codex_delivery_outbox",
        "busy_choices",
      ] as const;

      for (const table of standardTables) {
        assert.throws(() => {
          db.prepare(`INSERT INTO ${table} (target_thread_id, channel_id) VALUES ('fenced-thread', 9999)`).run();
        }, /archive deletion fenced; operation not executed/);
        assert.throws(() => {
          db.prepare(`INSERT INTO ${table} (target_thread_id, channel_id) VALUES ('safe-${table}', 2001)`).run();
        }, /archive deletion fenced; operation not executed/);
        db.prepare(`INSERT INTO ${table} (target_thread_id, channel_id) VALUES ('safe-${table}', 9999)`).run();
        assert.throws(() => {
          db.prepare(`UPDATE ${table} SET target_thread_id = 'fenced-thread' WHERE target_thread_id = 'safe-${table}'`).run();
        }, /archive deletion fenced; operation not executed/);
        assert.throws(() => {
          db.prepare(`UPDATE ${table} SET channel_id = 2002 WHERE target_thread_id = 'safe-${table}'`).run();
        }, /archive deletion fenced; operation not executed/);
        db.prepare(`UPDATE ${table} SET channel_id = 9998 WHERE target_thread_id = 'safe-${table}'`).run();
      }

      // 7. mirror_threads (codex_thread_id, discord_thread_id, discord_channel_id)
      assert.throws(() => {
        db.prepare("INSERT INTO mirror_threads (codex_thread_id, discord_thread_id, discord_channel_id) VALUES ('fenced-thread', 9999, 8888)").run();
      }, /archive deletion fenced; operation not executed/);
      assert.throws(() => {
        db.prepare("INSERT INTO mirror_threads (codex_thread_id, discord_thread_id, discord_channel_id) VALUES ('safe-mirror', 2001, 8888)").run();
      }, /archive deletion fenced; operation not executed/);
      db.prepare("INSERT INTO mirror_threads (codex_thread_id, discord_thread_id, discord_channel_id) VALUES ('safe-mirror', 9999, 8888)").run();
      assert.throws(() => {
        db.prepare("UPDATE mirror_threads SET codex_thread_id = 'fenced-thread' WHERE codex_thread_id = 'safe-mirror'").run();
      }, /archive deletion fenced; operation not executed/);
      assert.throws(() => {
        db.prepare("UPDATE mirror_threads SET discord_thread_id = 2002 WHERE codex_thread_id = 'safe-mirror'").run();
      }, /archive deletion fenced; operation not executed/);
      db.prepare("UPDATE mirror_threads SET discord_channel_id = 8889 WHERE codex_thread_id = 'safe-mirror'").run();
    } finally {
      db.close();
    }
  });
});

describe("room cleanup fences blocking guarded tables across declared columns", () => {
  it("blocks matching cleanup channel or deleting target while allowing unrelated rows", () => {
    const db = createPrerequisiteDb();
    try {
      migrateRoomCleanup(db);

      db.prepare(`
        INSERT INTO cdr_cleanup_fences (channel_id, target_thread_id, token, phase, created_at)
        VALUES (3001, 'fenced-clean-thread', 'token-clean', 'deleting', 100)
      `).run();

      // 1. codex_goal_progress
      assert.throws(() => {
        db.prepare("INSERT INTO codex_goal_progress (thread, channel) VALUES ('safe-thread', 3001)").run();
      }, /room cleanup fence active; operation not executed/);
      assert.throws(() => {
        db.prepare("INSERT INTO codex_goal_progress (thread, channel) VALUES ('fenced-clean-thread', 9999)").run();
      }, /room cleanup fence active; operation not executed/);
      db.prepare("INSERT INTO codex_goal_progress (thread, channel) VALUES ('safe-thread', 9999)").run();
      assert.throws(() => {
        db.prepare("UPDATE codex_goal_progress SET channel = 3001 WHERE thread = 'safe-thread'").run();
      }, /room cleanup fence active; operation not executed/);
      assert.throws(() => {
        db.prepare("UPDATE codex_goal_progress SET thread = 'fenced-clean-thread' WHERE thread = 'safe-thread'").run();
      }, /room cleanup fence active; operation not executed/);
      db.prepare("UPDATE codex_goal_progress SET channel = 9998 WHERE thread = 'safe-thread'").run();

      // 2-6. Standard tables
      const standardTables = [
        "codex_commentary_outbox",
        "codex_turn_queue",
        "codex_prompt_intakes",
        "codex_delivery_outbox",
        "busy_choices",
      ] as const;

      for (const table of standardTables) {
        assert.throws(() => {
          db.prepare(`INSERT INTO ${table} (target_thread_id, channel_id) VALUES ('safe-${table}', 3001)`).run();
        }, /room cleanup fence active; operation not executed/);
        assert.throws(() => {
          db.prepare(`INSERT INTO ${table} (target_thread_id, channel_id) VALUES ('fenced-clean-thread', 9999)`).run();
        }, /room cleanup fence active; operation not executed/);
        db.prepare(`INSERT INTO ${table} (target_thread_id, channel_id) VALUES ('safe-${table}', 9999)`).run();
        assert.throws(() => {
          db.prepare(`UPDATE ${table} SET channel_id = 3001 WHERE target_thread_id = 'safe-${table}'`).run();
        }, /room cleanup fence active; operation not executed/);
        assert.throws(() => {
          db.prepare(`UPDATE ${table} SET target_thread_id = 'fenced-clean-thread' WHERE target_thread_id = 'safe-${table}'`).run();
        }, /room cleanup fence active; operation not executed/);
        db.prepare(`UPDATE ${table} SET channel_id = 9998 WHERE target_thread_id = 'safe-${table}'`).run();
      }

      // 7. mirror_threads
      assert.throws(() => {
        db.prepare("INSERT INTO mirror_threads (codex_thread_id, discord_thread_id, discord_channel_id) VALUES ('safe-mirror', 3001, 8888)").run();
      }, /room cleanup fence active; operation not executed/);
      assert.throws(() => {
        db.prepare("INSERT INTO mirror_threads (codex_thread_id, discord_thread_id, discord_channel_id) VALUES ('safe-mirror', 9999, 3001)").run();
      }, /room cleanup fence active; operation not executed/);
      assert.throws(() => {
        db.prepare("INSERT INTO mirror_threads (codex_thread_id, discord_thread_id, discord_channel_id) VALUES ('fenced-clean-thread', 9999, 8888)").run();
      }, /room cleanup fence active; operation not executed/);
      db.prepare("INSERT INTO mirror_threads (codex_thread_id, discord_thread_id, discord_channel_id) VALUES ('safe-mirror', 9999, 8888)").run();
      assert.throws(() => {
        db.prepare("UPDATE mirror_threads SET discord_thread_id = 3001 WHERE codex_thread_id = 'safe-mirror'").run();
      }, /room cleanup fence active; operation not executed/);
      assert.throws(() => {
        db.prepare("UPDATE mirror_threads SET discord_channel_id = 3001 WHERE codex_thread_id = 'safe-mirror'").run();
      }, /room cleanup fence active; operation not executed/);
      assert.throws(() => {
        db.prepare("UPDATE mirror_threads SET codex_thread_id = 'fenced-clean-thread' WHERE codex_thread_id = 'safe-mirror'").run();
      }, /room cleanup fence active; operation not executed/);
      db.prepare("UPDATE mirror_threads SET discord_channel_id = 8889 WHERE codex_thread_id = 'safe-mirror'").run();

      // 8. mirror_projects (discord_channel_id)
      assert.throws(() => {
        db.prepare("INSERT INTO mirror_projects (discord_channel_id) VALUES (3001)").run();
      }, /room cleanup fence active; operation not executed/);
      db.prepare("INSERT INTO mirror_projects (discord_channel_id) VALUES (9999)").run();
      assert.throws(() => {
        db.prepare("UPDATE mirror_projects SET discord_channel_id = 3001 WHERE discord_channel_id = 9999").run();
      }, /room cleanup fence active; operation not executed/);
      db.prepare("UPDATE mirror_projects SET discord_channel_id = 9998 WHERE discord_channel_id = 9999").run();
    } finally {
      db.close();
    }
  });
});

describe("room cleanup deleted phase transition semantics", () => {
  it("retains channel guard in deleted phase but allows different-channel same target", () => {
    const db = createPrerequisiteDb();
    try {
      migrateRoomCleanup(db);

      db.prepare(`
        INSERT INTO cdr_cleanup_fences (channel_id, target_thread_id, token, phase, created_at)
        VALUES (4001, 'target-deleted-phase', 'token-del', 'deleted', 100)
      `).run();

      // Matching channel_id is still blocked under phase = 'deleted'
      assert.throws(() => {
        db.prepare("INSERT INTO codex_goal_progress (thread, channel) VALUES ('other-thread', 4001)").run();
      }, /room cleanup fence active; operation not executed/);
      assert.throws(() => {
        db.prepare("INSERT INTO codex_commentary_outbox (target_thread_id, channel_id) VALUES ('other-thread', 4001)").run();
      }, /room cleanup fence active; operation not executed/);
      assert.throws(() => {
        db.prepare("INSERT INTO mirror_projects (discord_channel_id) VALUES (4001)").run();
      }, /room cleanup fence active; operation not executed/);

      // Different channel with same target thread is allowed under phase = 'deleted'
      db.prepare("INSERT INTO codex_goal_progress (thread, channel) VALUES ('target-deleted-phase', 9999)").run();
      db.prepare("INSERT INTO codex_commentary_outbox (target_thread_id, channel_id) VALUES ('target-deleted-phase', 9999)").run();
      db.prepare("INSERT INTO codex_turn_queue (target_thread_id, channel_id) VALUES ('target-deleted-phase', 9999)").run();
      db.prepare("INSERT INTO mirror_threads (codex_thread_id, discord_thread_id, discord_channel_id) VALUES ('target-deleted-phase', 9999, 8888)").run();

      db.prepare("UPDATE codex_goal_progress SET channel = 9998 WHERE thread = 'target-deleted-phase'").run();
      db.prepare("UPDATE codex_commentary_outbox SET channel_id = 9998 WHERE target_thread_id = 'target-deleted-phase'").run();
    } finally {
      db.close();
    }
  });
});

describe("ingress journal fencing and state transitions", () => {
  it("holds fenced inserts with exact phase and reason, denies executable updates, and allows unrelated ingress", () => {
    const db = createPrerequisiteDb();
    try {
      migrateRoomCleanup(db);

      db.prepare(`
        INSERT INTO cdr_archive_fences (target_thread_id, token, channels, phase, created_at)
        VALUES ('arch-target-thread', 'tok-a', '[5001]', 'deleting', 100)
      `).run();

      db.prepare(`
        INSERT INTO cdr_cleanup_fences (channel_id, target_thread_id, token, phase, created_at)
        VALUES (6001, 'clean-target-thread', 'tok-c', 'deleting', 100)
      `).run();

      // Archive-fenced INSERT
      db.prepare(`
        INSERT INTO discord_ingress_journal (ingress_id, channel_id, target_thread_id, state, phase, hold_reason)
        VALUES ('ing-arch', 9999, 'arch-target-thread', 'staged', 'initial', NULL)
      `).run();

      const archRow = db
        .prepare("SELECT state, phase, hold_reason FROM discord_ingress_journal WHERE ingress_id = 'ing-arch'")
        .get() as { state: string; phase: string; hold_reason: string };
      assert.equal(archRow.state, "held");
      assert.equal(archRow.phase, "archive_fenced");
      assert.equal(
        archRow.hold_reason,
        "archive deletion in progress or completed; original request saved without execution",
      );

      for (const execState of ["staged", "acknowledged", "executing", "owned"]) {
        assert.throws(() => {
          db.prepare("UPDATE discord_ingress_journal SET state = ? WHERE ingress_id = 'ing-arch'").run(execState);
        }, /archive deletion fenced; ingress cannot execute/);
      }

      // Cleanup-fenced INSERT
      db.prepare(`
        INSERT INTO discord_ingress_journal (ingress_id, channel_id, target_thread_id, state, phase, hold_reason)
        VALUES ('ing-clean', 6001, 'safe-thread', 'staged', 'initial', NULL)
      `).run();

      const cleanRow = db
        .prepare("SELECT state, phase, hold_reason FROM discord_ingress_journal WHERE ingress_id = 'ing-clean'")
        .get() as { state: string; phase: string; hold_reason: string };
      assert.equal(cleanRow.state, "held");
      assert.equal(cleanRow.phase, "cleanup_fenced");
      assert.equal(
        cleanRow.hold_reason,
        "room cleanup in progress or completed; original request saved without execution",
      );

      for (const execState of ["staged", "acknowledged", "executing", "owned"]) {
        assert.throws(() => {
          db.prepare("UPDATE discord_ingress_journal SET state = ? WHERE ingress_id = 'ing-clean'").run(execState);
        }, /room cleanup fence active; ingress cannot execute/);
      }

      // Unrelated INSERT and execution
      db.prepare(`
        INSERT INTO discord_ingress_journal (ingress_id, channel_id, target_thread_id, state, phase, hold_reason)
        VALUES ('ing-safe', 9999, 'safe-thread', 'staged', 'initial', NULL)
      `).run();

      const safeRow = db
        .prepare("SELECT state, phase, hold_reason FROM discord_ingress_journal WHERE ingress_id = 'ing-safe'")
        .get() as { state: string; phase: string; hold_reason: string | null };
      assert.equal(safeRow.state, "staged");
      assert.equal(safeRow.phase, "initial");
      assert.equal(safeRow.hold_reason, null);

      db.prepare("UPDATE discord_ingress_journal SET state = 'executing' WHERE ingress_id = 'ing-safe'").run();
      const updatedSafeRow = db
        .prepare("SELECT state FROM discord_ingress_journal WHERE ingress_id = 'ing-safe'")
        .get() as { state: string };
      assert.equal(updatedSafeRow.state, "executing");
    } finally {
      db.close();
    }
  });
});

describe("delivery receipts destination fencing", () => {
  it("blocks matching integer destinations and conservatively blocks malformed/non-integer keys when fences exist", () => {
    const db = createPrerequisiteDb();
    try {
      migrateRoomCleanup(db);

      db.prepare(`
        INSERT INTO cdr_archive_fences (target_thread_id, token, channels, phase, created_at)
        VALUES ('arch-thread', 'tok-a', '[7001, 7002]', 'deleting', 100)
      `).run();

      // Blocked under archive fence
      assert.throws(() => {
        db.prepare("INSERT INTO codex_delivery_receipts (receipt_key) VALUES ('[7001, \"m1\"]')").run();
      }, /archive deletion fenced; delivery not attempted/);
      assert.throws(() => {
        db.prepare("INSERT INTO codex_delivery_receipts (receipt_key) VALUES ('[7002, \"m2\"]')").run();
      }, /archive deletion fenced; delivery not attempted/);

      // Malformed or non-integer conservatively blocked
      assert.throws(() => {
        db.prepare("INSERT INTO codex_delivery_receipts (receipt_key) VALUES ('not-json')").run();
      }, /archive deletion fenced; delivery not attempted/);
      assert.throws(() => {
        db.prepare("INSERT INTO codex_delivery_receipts (receipt_key) VALUES ('[\"channel-str\", \"m\"]')").run();
      }, /archive deletion fenced; delivery not attempted/);
      assert.throws(() => {
        db.prepare("INSERT INTO codex_delivery_receipts (receipt_key) VALUES ('[]')").run();
      }, /archive deletion fenced; delivery not attempted/);
      assert.throws(() => {
        db.prepare("INSERT INTO codex_delivery_receipts (receipt_key) VALUES ('{\"channel\": 7001}')").run();
      }, /archive deletion fenced; delivery not attempted/);

      // Unrelated integer channel allowed
      db.prepare("INSERT INTO codex_delivery_receipts (receipt_key) VALUES ('[9999, \"m3\"]')").run();

      // Add cleanup fence and verify cleanup block
      db.prepare(`
        INSERT INTO cdr_cleanup_fences (channel_id, target_thread_id, token, phase, created_at)
        VALUES (8001, 'clean-thread', 'tok-c', 'deleting', 100)
      `).run();

      assert.throws(() => {
        db.prepare("INSERT INTO codex_delivery_receipts (receipt_key) VALUES ('[8001, \"m4\"]')").run();
      }, /room cleanup fence active; delivery not attempted/);

      // When all fences are removed, malformed/non-integer keys are not blocked
      db.exec("DELETE FROM cdr_archive_fences; DELETE FROM cdr_cleanup_fences;");
      db.prepare("INSERT INTO codex_delivery_receipts (receipt_key) VALUES ('not-json-now-allowed')").run();
      db.prepare("INSERT INTO codex_delivery_receipts (receipt_key) VALUES ('[\"str-chan\", \"m\"]')").run();
    } finally {
      db.close();
    }
  });
});
