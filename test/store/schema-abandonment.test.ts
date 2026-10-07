import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  migrateAbandonment,
  schemaCurrentAbandonment,
  checkAbandonmentCompatibility,
  AbandonmentIntegrityError,
} from '../../src/store/schema-abandonment.ts';

const trackedDbs: DatabaseSync[] = [];

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  trackedDbs.push(db);
  return db;
}

function initPrerequisites(db: DatabaseSync): DatabaseSync {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cdr_runtime_capability_requirements (
      component TEXT PRIMARY KEY,
      format_version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS codex_request_cancellations (
      job_id TEXT PRIMARY KEY,
      discord_message_id INTEGER
    );
  `);
  return db;
}

function openInitializedDb(): DatabaseSync {
  const db = openDb();
  initPrerequisites(db);
  return db;
}

afterEach(() => {
  while (trackedDbs.length > 0) {
    const db = trackedDbs.pop();
    try {
      db?.close();
    } catch {
      // teardown close ignore
    }
  }
});

const VALID_PROPOSAL_ID = '0123456789abcdef0123456789abcdef';
const VALID_SHA256 = 'a'.repeat(64);
const VALID_SEAL = JSON.stringify({ action: 'abandon' });

function insertProposal(
  db: DatabaseSync,
  id = VALID_PROPOSAL_ID,
  jobId = 'job-001',
  revision = 1
): void {
  db.prepare(`
    INSERT INTO cdr_recovery_abandonment_proposals (
      id, format_version, revision, job_id, target_thread_id,
      owner_user_id, channel_id, application_id, seal_json, seal_sha256
    ) VALUES (?, 1, ?, ?, 'thread-001', 1001, 2001, 3001, ?, ?)
  `).run(id, revision, jobId, VALID_SEAL, VALID_SHA256);
}

function insertDelivery(
  db: DatabaseSync,
  proposalId = VALID_PROPOSAL_ID,
  revision = 1,
  messageId = 5001
): void {
  db.prepare(`
    INSERT INTO cdr_recovery_abandonment_deliveries (
      proposal_id, revision, message_id, body_sha256
    ) VALUES (?, ?, ?, ?)
  `).run(proposalId, revision, messageId, VALID_SHA256);
}

function insertDecision(
  db: DatabaseSync,
  proposalId = VALID_PROPOSAL_ID,
  revision = 1,
  decision: 'abandon_only' | 'keep_held' = 'abandon_only',
  interactionId = 9001
): void {
  db.prepare(`
    INSERT INTO cdr_recovery_abandonment_decisions (
      proposal_id, revision, ingress_id, interaction_id, decision, recorded_at_bits
    ) VALUES (?, ?, 'ingress-001', ?, ?, 'bits-001')
  `).run(proposalId, revision, interactionId, decision);
}

describe('Group 1: Fresh legacy database compatibility and parameter bounds', () => {
  it('accepts absent family when required is 0n on fresh database', () => {
    const db = openDb();
    assert.doesNotThrow(() => checkAbandonmentCompatibility(db, 0n));
    assert.equal(schemaCurrentAbandonment(db), false);
  });

  it('accepts absent family when required is 0n with prerequisites present', () => {
    const db = openInitializedDb();
    assert.doesNotThrow(() => checkAbandonmentCompatibility(db, 0n));
    assert.equal(schemaCurrentAbandonment(db), false);
  });

  it('rejects incomplete capability on fresh database when required is 1n', () => {
    const db = openInitializedDb();
    assert.throws(
      () => checkAbandonmentCompatibility(db, 1n),
      (err: unknown) =>
        err instanceof AbandonmentIntegrityError &&
        err.reason === 'unsupported or incomplete abandonment capability'
    );
  });

  it('validates parameter type and 64-bit signed integer range', () => {
    const db = openInitializedDb();
    assert.throws(
      () => checkAbandonmentCompatibility(db, 0 as unknown as bigint),
      TypeError
    );
    assert.throws(
      () => checkAbandonmentCompatibility(db, 9223372036854775808n),
      RangeError
    );
    assert.throws(
      () => checkAbandonmentCompatibility(db, -9223372036854775809n),
      RangeError
    );
  });
});

describe('Group 2: Migration, currentness, and repeat idempotency', () => {
  it('transitions from not current to current and compatible after migration', () => {
    const db = openInitializedDb();
    assert.equal(schemaCurrentAbandonment(db), false);
    migrateAbandonment(db);
    assert.equal(schemaCurrentAbandonment(db), true);
    assert.doesNotThrow(() => checkAbandonmentCompatibility(db, 1n));
  });

  it('is idempotent on repeat migration preserving catalog signatures', () => {
    const db = openInitializedDb();
    migrateAbandonment(db);
    assert.equal(schemaCurrentAbandonment(db), true);
    assert.doesNotThrow(() => migrateAbandonment(db));
    assert.equal(schemaCurrentAbandonment(db), true);
    assert.doesNotThrow(() => checkAbandonmentCompatibility(db, 1n));
  });
});

describe('Group 3: Caller transaction rollback', () => {
  it('rolls back completely when caller wraps migration in transaction', () => {
    const db = openInitializedDb();
    db.exec('BEGIN');
    migrateAbandonment(db);
    assert.equal(schemaCurrentAbandonment(db), true);
    db.exec('ROLLBACK');
    assert.equal(schemaCurrentAbandonment(db), false);
    assert.doesNotThrow(() => checkAbandonmentCompatibility(db, 0n));
    const row = db
      .prepare(
        "SELECT count(*) AS count FROM sqlite_schema WHERE name GLOB 'cdr_recovery_abandonment_*'"
      )
      .get() as { count: number | bigint };
    assert.equal(Number(row.count), 0);
  });
});

describe('Group 4: Catalog object count and verbatim schema matching', () => {
  it('creates exact 15 catalog objects matching expected signatures', () => {
    const db = openInitializedDb();
    migrateAbandonment(db);
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name GLOB 'cdr_recovery_abandonment_*' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    assert.equal(names.length, 15);
    const expected = [
      'cdr_recovery_abandonment_cancellation_no_delete',
      'cdr_recovery_abandonment_cancellation_no_replace',
      'cdr_recovery_abandonment_cancellation_no_update',
      'cdr_recovery_abandonment_decision_immutable',
      'cdr_recovery_abandonment_decision_no_delete',
      'cdr_recovery_abandonment_decision_no_replace',
      'cdr_recovery_abandonment_decisions',
      'cdr_recovery_abandonment_deliveries',
      'cdr_recovery_abandonment_delivery_immutable',
      'cdr_recovery_abandonment_delivery_no_delete',
      'cdr_recovery_abandonment_delivery_no_replace',
      'cdr_recovery_abandonment_proposal_immutable',
      'cdr_recovery_abandonment_proposal_no_delete',
      'cdr_recovery_abandonment_proposal_no_replace',
      'cdr_recovery_abandonment_proposals',
    ];
    assert.deepEqual([...names].sort(), [...expected].sort());
  });

  it('rejects extra GLOB family object without performing readonly repair', () => {
    const db = openInitializedDb();
    migrateAbandonment(db);
    db.exec('CREATE TABLE cdr_recovery_abandonment_extra (id TEXT PRIMARY KEY);');
    assert.equal(schemaCurrentAbandonment(db), false);
    assert.throws(
      () => checkAbandonmentCompatibility(db, 1n),
      AbandonmentIntegrityError
    );
    const extra = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name = 'cdr_recovery_abandonment_extra'"
      )
      .get();
    assert.ok(extra);
  });
});

describe('Group 5: Catalog alteration and column contract tampering', () => {
  it('rejects altered trigger body', () => {
    const db = openInitializedDb();
    migrateAbandonment(db);
    db.exec('DROP TRIGGER cdr_recovery_abandonment_proposal_immutable;');
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS cdr_recovery_abandonment_proposal_immutable
      BEFORE UPDATE ON cdr_recovery_abandonment_proposals
      BEGIN SELECT RAISE(ABORT, 'altered trigger body message'); END;
    `);
    assert.equal(schemaCurrentAbandonment(db), false);
    assert.throws(
      () => checkAbandonmentCompatibility(db, 1n),
      AbandonmentIntegrityError
    );
  });

  it('rejects empty table column contract changes', () => {
    const db = openInitializedDb();
    migrateAbandonment(db);
    db.exec('DROP TRIGGER cdr_recovery_abandonment_delivery_immutable;');
    db.exec('DROP TRIGGER cdr_recovery_abandonment_delivery_no_delete;');
    db.exec('DROP TRIGGER cdr_recovery_abandonment_delivery_no_replace;');
    db.exec('DROP TABLE cdr_recovery_abandonment_deliveries;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS cdr_recovery_abandonment_deliveries (
        proposal_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL,
        message_id INTEGER NOT NULL UNIQUE,
        altered_hash TEXT NOT NULL
      );
    `);
    assert.equal(schemaCurrentAbandonment(db), false);
    assert.throws(
      () => checkAbandonmentCompatibility(db, 1n),
      AbandonmentIntegrityError
    );
  });
});

describe('Group 6: Private Rust normalizer controls via writable_schema', () => {
  it('accepts Rust NEL whitespace but rejects BOM, case fold, and spacing changes', () => {
    const db = openInitializedDb();
    migrateAbandonment(db);

    const triggerName = 'cdr_recovery_abandonment_proposal_immutable';
    const row = db
      .prepare('SELECT sql FROM sqlite_schema WHERE name=?')
      .get(triggerName) as { sql: string };
    const originalSql = row.sql;

    try {
      (db as unknown as { enableDefensive?: (v: boolean) => void }).enableDefensive?.(false);
      db.exec('PRAGMA writable_schema = ON;');

      // 1. NEL (\u0085) Rust whitespace accepted
      db.prepare('UPDATE sqlite_schema SET sql=? WHERE name=?').run(
        `\u0085${originalSql};\u0085`,
        triggerName
      );
      assert.equal(schemaCurrentAbandonment(db), true);

      // 2. BOM (\uFEFF) not Rust whitespace, rejected
      db.prepare('UPDATE sqlite_schema SET sql=? WHERE name=?').run(
        `\uFEFF${originalSql}`,
        triggerName
      );
      assert.equal(schemaCurrentAbandonment(db), false);

      // 3. Literal case modification rejected
      const caseChangedSql = originalSql.replace(
        "'abandonment evidence is immutable'",
        "'ABANDONMENT EVIDENCE IS IMMUTABLE'"
      );
      db.prepare('UPDATE sqlite_schema SET sql=? WHERE name=?').run(
        caseChangedSql,
        triggerName
      );
      assert.equal(schemaCurrentAbandonment(db), false);

      // 4. Internal whitespace modification rejected
      const spacingChangedSql = originalSql.replace(
        'BEFORE UPDATE ON',
        'BEFORE  UPDATE  ON'
      );
      db.prepare('UPDATE sqlite_schema SET sql=? WHERE name=?').run(
        spacingChangedSql,
        triggerName
      );
      assert.equal(schemaCurrentAbandonment(db), false);

      // Restore original SQL
      db.prepare('UPDATE sqlite_schema SET sql=? WHERE name=?').run(
        originalSql,
        triggerName
      );
      assert.equal(schemaCurrentAbandonment(db), true);
    } finally {
      try {
        db.exec('PRAGMA writable_schema = OFF;');
        (db as unknown as { enableDefensive?: (v: boolean) => void }).enableDefensive?.(true);
      } catch {
        // cleanup safeguard
      }
    }
  });
});

describe('Group 7: Capability requirement format_version matching semantics', () => {
  it('rejects large integer versions > 2^53 without precision decode', () => {
    const db = openInitializedDb();
    migrateAbandonment(db);
    db.prepare(
      "UPDATE cdr_runtime_capability_requirements SET format_version = 9007199254740993 WHERE component = 'recovery_abandonment'"
    ).run();
    assert.equal(schemaCurrentAbandonment(db), false);
    assert.throws(
      () => checkAbandonmentCompatibility(db, 1n),
      AbandonmentIntegrityError
    );
  });

  it('accepts REAL 1.0 format_version via numeric SQL affinity comparison', () => {
    const db = openInitializedDb();
    db.exec(`
      DROP TABLE cdr_runtime_capability_requirements;
      CREATE TABLE cdr_runtime_capability_requirements (
        component TEXT PRIMARY KEY,
        format_version NOT NULL
      );
    `);
    migrateAbandonment(db);
    db.prepare(
      "UPDATE cdr_runtime_capability_requirements SET format_version = 1.0 WHERE component = 'recovery_abandonment'"
    ).run();
    const row = db
      .prepare(
        "SELECT typeof(format_version) AS type FROM cdr_runtime_capability_requirements WHERE component = 'recovery_abandonment'"
      )
      .get() as { type: string };
    assert.equal(row.type, 'real');
    assert.equal(schemaCurrentAbandonment(db), true);
    assert.doesNotThrow(() => checkAbandonmentCompatibility(db, 1n));
  });

  it('rejects TEXT format_version string', () => {
    const db = openInitializedDb();
    db.exec(`
      DROP TABLE cdr_runtime_capability_requirements;
      CREATE TABLE cdr_runtime_capability_requirements (
        component TEXT PRIMARY KEY,
        format_version NOT NULL
      );
    `);
    migrateAbandonment(db);
    db.prepare(
      "UPDATE cdr_runtime_capability_requirements SET format_version = '1' WHERE component = 'recovery_abandonment'"
    ).run();
    const row = db
      .prepare(
        "SELECT typeof(format_version) AS type FROM cdr_runtime_capability_requirements WHERE component = 'recovery_abandonment'"
      )
      .get() as { type: string };
    assert.equal(row.type, 'text');
    assert.equal(schemaCurrentAbandonment(db), false);
    assert.throws(
      () => checkAbandonmentCompatibility(db, 1n),
      AbandonmentIntegrityError
    );
  });
});

describe('Group 8: Conflicting capability requirement INSERT OR IGNORE throws on migrate', () => {
  it('throws AbandonmentIntegrityError when preexisting requirement has incompatible version', () => {
    const db = openInitializedDb();
    db.prepare(
      "INSERT INTO cdr_runtime_capability_requirements (component, format_version) VALUES ('recovery_abandonment', 99)"
    ).run();
    assert.throws(
      () => migrateAbandonment(db),
      (err: unknown) =>
        err instanceof AbandonmentIntegrityError &&
        err.reason === 'unsupported or incomplete abandonment capability'
    );
  });
});

describe('Group 9: Proposal table CHECK constraints and immutability triggers', () => {
  it('enforces proposal column constraints: id hex length, revision, seal valid JSON', () => {
    const db = openInitializedDb();
    migrateAbandonment(db);

    assert.throws(
      () => insertProposal(db, '0123456789abcdef'),
      /CHECK constraint failed/
    );
    assert.throws(
      () => insertProposal(db, '0123456789abcdef0123456789abcdeg'),
      /CHECK constraint failed/
    );
    assert.throws(
      () => insertProposal(db, '0123456789ABCDEF0123456789ABCDEF'),
      /CHECK constraint failed/
    );
    assert.throws(
      () => insertProposal(db, VALID_PROPOSAL_ID, 'job-001', 0),
      /CHECK constraint failed/
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO cdr_recovery_abandonment_proposals (
              id, format_version, revision, job_id, target_thread_id,
              owner_user_id, channel_id, application_id, seal_json, seal_sha256
            ) VALUES (?, 1, 1, 'j1', 't1', 1, 1, 1, 'INVALID JSON', ?)`
          )
          .run(VALID_PROPOSAL_ID, VALID_SHA256),
      /CHECK constraint failed/
    );
  });

  it('blocks UPDATE, DELETE, and INSERT OR REPLACE on proposals', () => {
    const db = openInitializedDb();
    migrateAbandonment(db);
    insertProposal(db);

    assert.throws(
      () =>
        db
          .prepare(
            'UPDATE cdr_recovery_abandonment_proposals SET target_thread_id = ? WHERE id = ?'
          )
          .run('thread-new', VALID_PROPOSAL_ID),
      /abandonment evidence is immutable/
    );

    assert.throws(
      () =>
        db
          .prepare(
            'DELETE FROM cdr_recovery_abandonment_proposals WHERE id = ?'
          )
          .run(VALID_PROPOSAL_ID),
      /abandonment evidence cannot be forgotten/
    );

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT OR REPLACE INTO cdr_recovery_abandonment_proposals (
              id, format_version, revision, job_id, target_thread_id,
              owner_user_id, channel_id, application_id, seal_json, seal_sha256
            ) VALUES (?, 1, 1, 'job-001', 'thread-002', 1001, 2001, 3001, ?, ?)`
          )
          .run(VALID_PROPOSAL_ID, VALID_SEAL, VALID_SHA256),
      /abandonment evidence cannot be replaced/
    );
  });
});

describe('Group 10: Delivery and decision constraints and immutability triggers', () => {
  it('blocks UPDATE, DELETE, and INSERT OR REPLACE on deliveries', () => {
    const db = openInitializedDb();
    migrateAbandonment(db);
    insertProposal(db);
    insertDelivery(db);

    assert.throws(
      () =>
        db
          .prepare(
            'UPDATE cdr_recovery_abandonment_deliveries SET message_id = ? WHERE proposal_id = ?'
          )
          .run(9999, VALID_PROPOSAL_ID),
      /abandonment evidence is immutable/
    );

    assert.throws(
      () =>
        db
          .prepare(
            'DELETE FROM cdr_recovery_abandonment_deliveries WHERE proposal_id = ?'
          )
          .run(VALID_PROPOSAL_ID),
      /abandonment evidence cannot be forgotten/
    );

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT OR REPLACE INTO cdr_recovery_abandonment_deliveries (
              proposal_id, revision, message_id, body_sha256
            ) VALUES (?, 1, 5001, ?)`
          )
          .run(VALID_PROPOSAL_ID, VALID_SHA256),
      /abandonment evidence cannot be replaced/
    );
  });

  it('blocks UPDATE, DELETE, and INSERT OR REPLACE on decisions, rejecting invalid decision enum', () => {
    const db = openInitializedDb();
    migrateAbandonment(db);
    insertProposal(db);

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO cdr_recovery_abandonment_decisions (
              proposal_id, revision, ingress_id, interaction_id, decision, recorded_at_bits
            ) VALUES (?, 1, 'ing-err', 7001, 'invalid_action', 'bits')`
          )
          .run(VALID_PROPOSAL_ID),
      /CHECK constraint failed/
    );

    insertDecision(db);

    assert.throws(
      () =>
        db
          .prepare(
            'UPDATE cdr_recovery_abandonment_decisions SET decision = ? WHERE proposal_id = ?'
          )
          .run('keep_held', VALID_PROPOSAL_ID),
      /abandonment evidence is immutable/
    );

    assert.throws(
      () =>
        db
          .prepare(
            'DELETE FROM cdr_recovery_abandonment_decisions WHERE proposal_id = ?'
          )
          .run(VALID_PROPOSAL_ID),
      /abandonment evidence cannot be forgotten/
    );

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT OR REPLACE INTO cdr_recovery_abandonment_decisions (
              proposal_id, revision, ingress_id, interaction_id, decision, recorded_at_bits
            ) VALUES (?, 1, 'ingress-002', 9001, 'abandon_only', 'bits-002')`
          )
          .run(VALID_PROPOSAL_ID),
      /abandonment evidence cannot be replaced/
    );
  });
});

describe('Group 11: Orphaned delivery and decision survive SQL CHECK but fail compatibility', () => {
  it('survives SQL insert of orphaned delivery but checkAbandonmentCompatibility fails without repair', () => {
    const db = openInitializedDb();
    migrateAbandonment(db);

    const orphanProposalId = 'fedcba9876543210fedcba9876543210';
    db.prepare(`
      INSERT INTO cdr_recovery_abandonment_deliveries (
        proposal_id, revision, message_id, body_sha256
      ) VALUES (?, 1, 8001, ?)
    `).run(orphanProposalId, VALID_SHA256);

    const count = db
      .prepare('SELECT count(*) AS count FROM cdr_recovery_abandonment_deliveries')
      .get() as { count: number | bigint };
    assert.equal(Number(count.count), 1);

    assert.throws(
      () => checkAbandonmentCompatibility(db, 1n),
      (err: unknown) =>
        err instanceof AbandonmentIntegrityError &&
        err.reason === 'stored abandonment evidence has no supported original proposal'
    );

    const countAfter = db
      .prepare('SELECT count(*) AS count FROM cdr_recovery_abandonment_deliveries')
      .get() as { count: number | bigint };
    assert.equal(Number(countAfter.count), 1);
  });

  it('survives SQL insert of orphaned decision but checkAbandonmentCompatibility fails without repair', () => {
    const db = openInitializedDb();
    migrateAbandonment(db);

    const orphanProposalId = 'abcdef0123456789abcdef0123456789';
    db.prepare(`
      INSERT INTO cdr_recovery_abandonment_decisions (
        proposal_id, revision, ingress_id, interaction_id, decision, recorded_at_bits
      ) VALUES (?, 1, 'ingress-orphan', 8002, 'abandon_only', 'bits')
    `).run(orphanProposalId);

    assert.throws(
      () => checkAbandonmentCompatibility(db, 1n),
      (err: unknown) =>
        err instanceof AbandonmentIntegrityError &&
        err.reason === 'stored abandonment evidence has no supported original proposal'
    );

    const countAfter = db
      .prepare('SELECT count(*) AS count FROM cdr_recovery_abandonment_decisions')
      .get() as { count: number | bigint };
    assert.equal(Number(countAfter.count), 1);
  });

  it('fails compatibility check when delivery revision does not match proposal revision', () => {
    const db = openInitializedDb();
    migrateAbandonment(db);
    insertProposal(db, VALID_PROPOSAL_ID, 'job-rev-mismatch', 1);

    db.prepare(`
      INSERT INTO cdr_recovery_abandonment_deliveries (
        proposal_id, revision, message_id, body_sha256
      ) VALUES (?, 2, 8003, ?)
    `).run(VALID_PROPOSAL_ID, VALID_SHA256);

    assert.throws(
      () => checkAbandonmentCompatibility(db, 1n),
      (err: unknown) =>
        err instanceof AbandonmentIntegrityError &&
        err.reason === 'stored abandonment evidence has no supported original proposal'
    );
  });
});

describe('Group 12: Cancellation guard triggers for abandon_only vs keep_held', () => {
  it('guards abandoned cancellation: blocks UPDATE, DELETE, and same job or old message replacement, but allows unrelated', () => {
    const db = openInitializedDb();
    migrateAbandonment(db);

    const jobId = 'job-abandon-target';
    const messageId = 11111;

    db.prepare(
      'INSERT INTO codex_request_cancellations (job_id, discord_message_id) VALUES (?, ?)'
    ).run(jobId, messageId);

    insertProposal(db, VALID_PROPOSAL_ID, jobId, 1);
    insertDecision(db, VALID_PROPOSAL_ID, 1, 'abandon_only', 33333);

    assert.throws(
      () =>
        db
          .prepare(
            'UPDATE codex_request_cancellations SET discord_message_id = ? WHERE job_id = ?'
          )
          .run(22222, jobId),
      /abandoned request must remain non-replayable/
    );

    assert.throws(
      () =>
        db
          .prepare(
            'DELETE FROM codex_request_cancellations WHERE job_id = ?'
          )
          .run(jobId),
      /abandoned request must remain non-replayable/
    );

    assert.throws(
      () =>
        db
          .prepare(
            'INSERT INTO codex_request_cancellations (job_id, discord_message_id) VALUES (?, ?)'
          )
          .run(jobId, 44444),
      /abandoned cancellation cannot be replaced/
    );

    assert.throws(
      () =>
        db
          .prepare(
            'INSERT INTO codex_request_cancellations (job_id, discord_message_id) VALUES (?, ?)'
          )
          .run('job-other-replacement', messageId),
      /abandoned cancellation cannot be replaced/
    );

    assert.doesNotThrow(() =>
      db
        .prepare(
          'INSERT INTO codex_request_cancellations (job_id, discord_message_id) VALUES (?, ?)'
        )
        .run('job-unrelated', 99999)
    );
  });

  it('allows updates and deletions when decision is keep_held without blocking beyond PK', () => {
    const db = openInitializedDb();
    migrateAbandonment(db);

    const jobId = 'job-keep-held-target';
    const messageId = 55555;

    db.prepare(
      'INSERT INTO codex_request_cancellations (job_id, discord_message_id) VALUES (?, ?)'
    ).run(jobId, messageId);

    const proposalId = 'abababababababababababababababab';
    insertProposal(db, proposalId, jobId, 1);
    insertDecision(db, proposalId, 1, 'keep_held', 44444);

    assert.doesNotThrow(() =>
      db
        .prepare(
          'UPDATE codex_request_cancellations SET discord_message_id = ? WHERE job_id = ?'
        )
        .run(66666, jobId)
    );

    assert.doesNotThrow(() =>
      db
        .prepare(
          'DELETE FROM codex_request_cancellations WHERE job_id = ?'
        )
        .run(jobId)
    );
  });
});
