import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  migrateIngress,
  schemaCurrentIngress,
  migrateNewReply,
  schemaCurrentNewReply,
  migrateCancellation,
  schemaCurrentCancellation,
  migrateMappingCreation,
  schemaCurrentMappingCreation,
  migrateContainerCreation,
  schemaCurrentContainerCreation,
} from '../../src/store/schema-extensions-b2.ts';

function createCancellationFixtures(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_turn_queue (
      job_id TEXT PRIMARY KEY,
      discord_message_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS codex_prompt_intakes (
      job_id TEXT PRIMARY KEY,
      discord_message_id INTEGER
    );
  `);
}

describe('ingress schema migration, structural predicates, and repair', () => {
  it('handles lifecycle, drops, repairs, and missing columns', () => {
    const db = new DatabaseSync(':memory:');
    try {
      assert.equal(schemaCurrentIngress(db), false);
      migrateIngress(db);
      assert.equal(schemaCurrentIngress(db), true);

      const indices = db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='index' AND name IN ('cdr_stop_revision_target','cdr_stop_pending','cdr_stop_target','cdr_stop_original_interrupt') ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      assert.equal(indices.length, 4);

      db.exec('DROP INDEX cdr_stop_revision_target;');
      assert.equal(schemaCurrentIngress(db), false);
      migrateIngress(db);
      assert.equal(schemaCurrentIngress(db), true);

      db.exec('DROP TABLE cdr_stop_clock;');
      db.exec('CREATE TABLE cdr_stop_clock (singleton INTEGER PRIMARY KEY CHECK(singleton=1));');
      db.exec('INSERT INTO cdr_stop_clock VALUES(1);');
      assert.equal(schemaCurrentIngress(db), false);
    } finally {
      db.close();
    }
  });
});

describe('ingress stop clock initial revision and repeat retention', () => {
  it('preserves existing non-zero revision and retained journal entries', () => {
    const db = new DatabaseSync(':memory:');
    try {
      migrateIngress(db);
      db.exec('UPDATE cdr_stop_clock SET revision = 42 WHERE singleton = 1;');
      db.prepare(
        "INSERT INTO discord_ingress_journal (ingress_id, kind, channel_id, owner_user_id, payload_json, state, phase, created_at, updated_at) VALUES ('ing-1', 'message', 1, 10, '{}', 'staged', 'init', 100, 100)",
      ).run();

      migrateIngress(db);

      const clock = db.prepare('SELECT revision FROM cdr_stop_clock WHERE singleton = 1').get() as {
        revision: number;
      };
      assert.equal(clock.revision, 42);
      const journal = db
        .prepare("SELECT ingress_id FROM discord_ingress_journal WHERE ingress_id = 'ing-1'")
        .get() as { ingress_id: string };
      assert.equal(journal.ingress_id, 'ing-1');
    } finally {
      db.close();
    }
  });
});

describe('ingress stop control constraints and column count', () => {
  it('validates 13 columns, phase, generation, and partial unique constraint', () => {
    const db = new DatabaseSync(':memory:');
    try {
      migrateIngress(db);
      const countRow = db
        .prepare("SELECT count(*) as cnt FROM pragma_table_info('cdr_stop_controls')")
        .get() as { cnt: number };
      assert.equal(countRow.cnt, 13);

      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO cdr_stop_controls (operation_id, target_thread_id, resident_owner, generation, turn_id, record_json, phase) VALUES ('op-bad-phase', 't1', 'res1', 1, 'turn1', '{}', 'invalid_phase')",
            )
            .run(),
        /CHECK/i,
      );
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO cdr_stop_controls (operation_id, target_thread_id, resident_owner, generation, turn_id, record_json, phase) VALUES ('op-bad-gen', 't1', 'res1', 0, 'turn1', '{}', 'accepted')",
            )
            .run(),
        /CHECK/i,
      );

      db.prepare(
        "INSERT INTO cdr_stop_controls (operation_id, target_thread_id, resident_owner, generation, turn_id, record_json, phase, claim_token) VALUES ('op-uniq-1', 't-target', 'owner-1', 1, 'turn-1', '{}', 'accepted', 'claim-tok')",
      ).run();
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO cdr_stop_controls (operation_id, target_thread_id, resident_owner, generation, turn_id, record_json, phase, claim_token) VALUES ('op-uniq-2', 't-target', 'owner-1', 1, 'turn-1', '{}', 'accepted', 'claim-tok-2')",
            )
            .run(),
        /UNIQUE/i,
      );

      db.prepare(
        "INSERT INTO cdr_stop_controls (operation_id, target_thread_id, resident_owner, generation, turn_id, record_json, phase, claim_token) VALUES ('op-null-1', 't-target-2', 'owner-2', 1, 'turn-2', '{}', 'accepted', NULL)",
      ).run();
      db.prepare(
        "INSERT INTO cdr_stop_controls (operation_id, target_thread_id, resident_owner, generation, turn_id, record_json, phase, claim_token) VALUES ('op-null-2', 't-target-2', 'owner-2', 1, 'turn-2', '{}', 'accepted', NULL)",
      ).run();
    } finally {
      db.close();
    }
  });
});

describe('new reply migration, defaults, nulls, and constraints', () => {
  it('verifies defaults, uniqueness, state checks, and retention', () => {
    const db = new DatabaseSync(':memory:');
    try {
      assert.equal(schemaCurrentNewReply(db), false);
      migrateNewReply(db);
      assert.equal(schemaCurrentNewReply(db), true);

      db.prepare(
        "INSERT INTO codex_new_first_replies (job_id, ingress_id, identity_json) VALUES ('job-1', 'ing-1', '{}')",
      ).run();
      const row = db
        .prepare("SELECT * FROM codex_new_first_replies WHERE job_id = 'job-1'")
        .get() as Record<string, unknown>;
      assert.equal(row.state, 'pending');
      assert.equal(row.version, 1);
      assert.equal(row.scan_json, '{}');
      assert.equal(row.last_error, '');
      assert.equal(row.confirmation_delivered, 0);
      assert.equal(row.warning_due, 0);
      assert.equal(row.checked_at, 0);
      assert.equal(row.ack_recovery_allowed, 0);
      assert.equal(row.turn_id, null);
      assert.equal(row.accepted_at, null);

      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO codex_new_first_replies (job_id, ingress_id, identity_json) VALUES ('job-2', 'ing-1', '{}')",
            )
            .run(),
        /UNIQUE/i,
      );
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO codex_new_first_replies (job_id, ingress_id, identity_json, state) VALUES ('job-3', 'ing-3', '{}', 'invalid_state')",
            )
            .run(),
        /CHECK/i,
      );

      migrateNewReply(db);
      const total = db
        .prepare('SELECT count(*) as cnt FROM codex_new_first_replies')
        .get() as { cnt: number };
      assert.equal(total.cnt, 1);
    } finally {
      db.close();
    }
  });
});

describe('cancellation schema migration, trigger drops, and repair', () => {
  it('verifies 6 schema objects and repairs after drop', () => {
    const db = new DatabaseSync(':memory:');
    try {
      createCancellationFixtures(db);
      assert.equal(schemaCurrentCancellation(db), false);
      migrateCancellation(db);
      assert.equal(schemaCurrentCancellation(db), true);

      db.exec('DROP TRIGGER cancelled_codex_turn_queue_INSERT;');
      assert.equal(schemaCurrentCancellation(db), false);
      migrateCancellation(db);
      assert.equal(schemaCurrentCancellation(db), true);

      db.exec('DROP INDEX codex_cancelled_message;');
      assert.equal(schemaCurrentCancellation(db), false);
      migrateCancellation(db);
      assert.equal(schemaCurrentCancellation(db), true);
    } finally {
      db.close();
    }
  });
});

describe('cancellation trigger guards on queue and prompt intake tables', () => {
  it('enforces guards on insert/update and allows non-matching/null', () => {
    const db = new DatabaseSync(':memory:');
    try {
      createCancellationFixtures(db);
      migrateCancellation(db);

      db.prepare(
        "INSERT INTO codex_request_cancellations VALUES ('cancel-job-1', 'thread-1', 1, 10, 500, 1000.0)",
      ).run();

      assert.throws(
        () =>
          db
            .prepare("INSERT INTO codex_turn_queue (job_id, discord_message_id) VALUES ('cancel-job-1', 999)")
            .run(),
        /request was cancelled by its original sender/,
      );
      assert.throws(
        () =>
          db
            .prepare("INSERT INTO codex_turn_queue (job_id, discord_message_id) VALUES ('other-job', 500)")
            .run(),
        /request was cancelled by its original sender/,
      );
      db.prepare("INSERT INTO codex_turn_queue (job_id, discord_message_id) VALUES ('valid-1', 999)").run();
      db.prepare("INSERT INTO codex_turn_queue (job_id, discord_message_id) VALUES ('valid-2', NULL)").run();

      assert.throws(
        () =>
          db
            .prepare("UPDATE codex_turn_queue SET job_id = 'cancel-job-1' WHERE job_id = 'valid-1'")
            .run(),
        /request was cancelled by its original sender/,
      );
      assert.throws(
        () =>
          db
            .prepare("UPDATE codex_turn_queue SET discord_message_id = 500 WHERE job_id = 'valid-2'")
            .run(),
        /request was cancelled by its original sender/,
      );
      db.prepare("UPDATE codex_turn_queue SET discord_message_id = 888 WHERE job_id = 'valid-2'").run();

      assert.throws(
        () =>
          db
            .prepare("INSERT INTO codex_prompt_intakes (job_id, discord_message_id) VALUES ('cancel-job-1', 999)")
            .run(),
        /request was cancelled by its original sender/,
      );
      assert.throws(
        () =>
          db
            .prepare("INSERT INTO codex_prompt_intakes (job_id, discord_message_id) VALUES ('pi-job', 500)")
            .run(),
        /request was cancelled by its original sender/,
      );
      db.prepare("INSERT INTO codex_prompt_intakes (job_id, discord_message_id) VALUES ('pi-valid', NULL)").run();
      assert.throws(
        () =>
          db
            .prepare("UPDATE codex_prompt_intakes SET discord_message_id = 500 WHERE job_id = 'pi-valid'")
            .run(),
        /request was cancelled by its original sender/,
      );
      db.prepare("UPDATE codex_prompt_intakes SET discord_message_id = 777 WHERE job_id = 'pi-valid'").run();
    } finally {
      db.close();
    }
  });
});

describe('cancellation partial message index', () => {
  it('permits multiple null message_ids while enforcing uniqueness on integers', () => {
    const db = new DatabaseSync(':memory:');
    try {
      createCancellationFixtures(db);
      migrateCancellation(db);

      db.prepare(
        "INSERT INTO codex_request_cancellations VALUES ('c-null-1', 'thread-1', 1, 10, NULL, 100.0)",
      ).run();
      db.prepare(
        "INSERT INTO codex_request_cancellations VALUES ('c-null-2', 'thread-1', 1, 10, NULL, 101.0)",
      ).run();
      db.prepare(
        "INSERT INTO codex_request_cancellations VALUES ('c-int-1', 'thread-1', 1, 10, 5555, 102.0)",
      ).run();
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO codex_request_cancellations VALUES ('c-int-2', 'thread-1', 1, 10, 5555, 103.0)",
            )
            .run(),
        /UNIQUE/i,
      );
    } finally {
      db.close();
    }
  });
});

describe('mapping creation schema, exact columns, and constraints', () => {
  it('validates 8 columns, foreign ids, paired expected values, phase, and token', () => {
    const db = new DatabaseSync(':memory:');
    try {
      assert.equal(schemaCurrentMappingCreation(db), false);
      migrateMappingCreation(db);
      assert.equal(schemaCurrentMappingCreation(db), true);

      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO cdr_mirror_thread_creations VALUES ('th-1', 'tok-1', 0, 10, NULL, NULL, 'attempted', NULL)",
            )
            .run(),
        /CHECK/i,
      );
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO cdr_mirror_thread_creations VALUES ('th-1', 'tok-1', 10, 20, 30, NULL, 'attempted', NULL)",
            )
            .run(),
        /CHECK/i,
      );
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO cdr_mirror_thread_creations VALUES ('th-1', 'tok-1', 10, 20, NULL, 40, 'attempted', NULL)",
            )
            .run(),
        /CHECK/i,
      );
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO cdr_mirror_thread_creations VALUES ('th-1', 'tok-1', 10, 20, 0, 40, 'attempted', NULL)",
            )
            .run(),
        /CHECK/i,
      );
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO cdr_mirror_thread_creations VALUES ('th-1', 'tok-1', 10, 20, NULL, NULL, 'attempted', 100)",
            )
            .run(),
        /CHECK/i,
      );
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO cdr_mirror_thread_creations VALUES ('th-1', 'tok-1', 10, 20, NULL, NULL, 'confirmed', NULL)",
            )
            .run(),
        /CHECK/i,
      );

      db.prepare(
        "INSERT INTO cdr_mirror_thread_creations VALUES ('th-1', 'tok-1', 10, 20, 30, 40, 'confirmed', 500)",
      ).run();
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO cdr_mirror_thread_creations VALUES ('th-2', 'tok-1', 10, 20, NULL, NULL, 'attempted', NULL)",
            )
            .run(),
        /UNIQUE/i,
      );
    } finally {
      db.close();
    }
  });
});

describe('container creation schema, exact columns, and constraints', () => {
  it('validates 8 columns, kind parent constraints, phase rules, and token uniqueness', () => {
    const db = new DatabaseSync(':memory:');
    try {
      assert.equal(schemaCurrentContainerCreation(db), false);
      migrateContainerCreation(db);
      assert.equal(schemaCurrentContainerCreation(db), true);

      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO cdr_mirror_container_creations VALUES ('category', 'scope-1', 'tok-1', 10, 20, '{}', 'attempted', NULL)",
            )
            .run(),
        /CHECK/i,
      );
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO cdr_mirror_container_creations VALUES ('project', 'scope-1', 'tok-2', 10, NULL, '{}', 'attempted', NULL)",
            )
            .run(),
        /CHECK/i,
      );
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO cdr_mirror_container_creations VALUES ('project', 'scope-1', 'tok-2', 10, 0, '{}', 'attempted', NULL)",
            )
            .run(),
        /CHECK/i,
      );
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO cdr_mirror_container_creations VALUES ('project', 'scope-1', 'tok-3', 10, 20, '{}', 'bound', 50)",
            )
            .run(),
        /CHECK/i,
      );

      db.prepare(
        "INSERT INTO cdr_mirror_container_creations VALUES ('category', 'cat-scope', 'tok-shared', 10, NULL, '{}', 'bound', 60)",
      ).run();
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO cdr_mirror_container_creations VALUES ('project', 'proj-scope', 'tok-shared', 10, 20, '{}', 'confirmed', 70)",
            )
            .run(),
        /UNIQUE/i,
      );
    } finally {
      db.close();
    }
  });
});

describe('multi-extension composition, idempotency, and rollback', () => {
  it('migrates all five together, ensures idempotent repeat, and rolls back cleanly', () => {
    const db = new DatabaseSync(':memory:');
    try {
      createCancellationFixtures(db);

      migrateIngress(db);
      migrateNewReply(db);
      migrateCancellation(db);
      migrateMappingCreation(db);
      migrateContainerCreation(db);

      assert.equal(schemaCurrentIngress(db), true);
      assert.equal(schemaCurrentNewReply(db), true);
      assert.equal(schemaCurrentCancellation(db), true);
      assert.equal(schemaCurrentMappingCreation(db), true);
      assert.equal(schemaCurrentContainerCreation(db), true);

      migrateIngress(db);
      migrateNewReply(db);
      migrateCancellation(db);
      migrateMappingCreation(db);
      migrateContainerCreation(db);

      assert.equal(schemaCurrentIngress(db), true);
      assert.equal(schemaCurrentNewReply(db), true);
      assert.equal(schemaCurrentCancellation(db), true);
      assert.equal(schemaCurrentMappingCreation(db), true);
      assert.equal(schemaCurrentContainerCreation(db), true);

      db.exec('BEGIN IMMEDIATE;');
      db.prepare(
        "INSERT INTO codex_new_first_replies (job_id, ingress_id, identity_json) VALUES ('tx-job', 'tx-ing', '{}')",
      ).run();
      db.exec('ROLLBACK;');

      const txRow = db
        .prepare("SELECT * FROM codex_new_first_replies WHERE job_id = 'tx-job'")
        .get();
      assert.equal(txRow, undefined);
    } finally {
      db.close();
    }
  });
});
