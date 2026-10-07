import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  COMPONENT,
  FORMAT_VERSION,
  PublicationConsentIntegrityError,
  migratePublicationConsent,
  schemaCurrentPublicationConsent,
  checkPublicationConsentCompatibility,
} from '../../src/store/schema-publication-consent.ts';

function createBaseDb(withCapabilityTable = true): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  if (withCapabilityTable) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cdr_runtime_capability_requirements (
        component TEXT PRIMARY KEY,
        format_version INTEGER NOT NULL
      );
    `);
  }
  return db;
}

const VALID_PROPOSAL_SQL = `
  INSERT INTO cdr_recovery_publication_proposals (
    id, format_version, revision, job_id, target_thread_id,
    owner_user_id, channel_id, application_id, seal_json, seal_sha256
  ) VALUES (
    '0123456789abcdef0123456789abcdef', 1, 1, 'job-001', 'thread-001',
    100, 200, 300, '{"ok":true}', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
`;

const VALID_DELIVERY_SQL = `
  INSERT INTO cdr_recovery_publication_deliveries (
    proposal_id, revision, message_id, body_sha256
  ) VALUES (
    '0123456789abcdef0123456789abcdef', 1, 1000,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
`;

const VALID_DECISION_SQL = `
  INSERT INTO cdr_recovery_publication_decisions (
    proposal_id, revision, ingress_id, interaction_id, decision, recorded_at_bits
  ) VALUES (
    '0123456789abcdef0123456789abcdef', 1, 'ingress-001', 5000,
    'approve_exact', '1700000000'
  );
`;

describe('schema-publication-consent', () => {
  it('1. accepts legacy db with required=0 and tables absent even without capability table', () => {
    const db = createBaseDb(false);
    assert.equal(schemaCurrentPublicationConsent(db), false);
    assert.doesNotThrow(() => checkPublicationConsentCompatibility(db, 0n));
    assert.throws(
      () => checkPublicationConsentCompatibility(db, 1n),
      /no such table: cdr_runtime_capability_requirements/
    );
    db.close();
  });

  it('2. evaluates empty capability table correctly for legacy and current requirements', () => {
    const db = createBaseDb(true);
    assert.equal(schemaCurrentPublicationConsent(db), false);
    assert.doesNotThrow(() => checkPublicationConsentCompatibility(db, 0n));
    assert.throws(
      () => checkPublicationConsentCompatibility(db, 1n),
      PublicationConsentIntegrityError
    );
    db.close();
  });

  it('3. migrates fresh db and validates schemaCurrent and compatibility predicates', () => {
    const db = createBaseDb(true);
    migratePublicationConsent(db);
    assert.equal(schemaCurrentPublicationConsent(db), true);
    assert.doesNotThrow(() => checkPublicationConsentCompatibility(db, 1n));
    db.close();
  });

  it('4. repeat migration is idempotent and maintains full catalog stability', () => {
    const db = createBaseDb(true);
    migratePublicationConsent(db);

    const readCatalog = (): Array<{ type: string; name: string; tbl_name: string; sql: string | null }> =>
      (db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all() as Array<{
        type: string;
        name: string;
        tbl_name: string;
        sql: string | null;
      }>).map((row) => ({ ...row }));

    const catalogBefore = readCatalog();
    migratePublicationConsent(db);
    const catalogAfter = readCatalog();
    assert.deepEqual(catalogAfter, catalogBefore);

    const countStmt = db.prepare(`
      SELECT count(*) AS count FROM sqlite_schema WHERE name IN (
        'cdr_recovery_publication_proposals','cdr_recovery_publication_deliveries',
        'cdr_recovery_publication_decisions','cdr_recovery_publication_job_revision',
        'cdr_recovery_publication_proposal_immutable','cdr_recovery_publication_proposal_no_delete',
        'cdr_recovery_publication_delivery_immutable','cdr_recovery_publication_delivery_no_delete',
        'cdr_recovery_publication_decision_immutable','cdr_recovery_publication_decision_no_delete'
      )
    `);
    countStmt.setReadBigInts(true);
    const row = countStmt.get() as { count: bigint };
    assert.equal(row.count, 10n);

    const capStmt = db.prepare('SELECT format_version FROM cdr_runtime_capability_requirements WHERE component = ?');
    capStmt.setReadBigInts(true);
    const capRow = capStmt.get(COMPONENT) as { format_version: bigint };
    assert.equal(capRow.format_version, FORMAT_VERSION);
    assert.equal(schemaCurrentPublicationConsent(db), true);
    assert.doesNotThrow(() => checkPublicationConsentCompatibility(db, 1n));
    db.close();
  });

  it('5. respects caller DDL transaction rollback without leaving partial state', () => {
    const db = createBaseDb(true);
    db.exec('BEGIN');
    migratePublicationConsent(db);
    assert.equal(schemaCurrentPublicationConsent(db), true);
    db.exec('ROLLBACK');

    assert.equal(schemaCurrentPublicationConsent(db), false);
    assert.throws(
      () => checkPublicationConsentCompatibility(db, 1n),
      PublicationConsentIntegrityError
    );
    db.close();
  });

  it('6. fails migration when capability row cannot be inserted due to RAISE(IGNORE)', () => {
    const db = createBaseDb(true);
    db.exec(`
      CREATE TRIGGER block_cap BEFORE INSERT ON cdr_runtime_capability_requirements
      BEGIN SELECT RAISE(IGNORE); END;
    `);
    assert.throws(() => migratePublicationConsent(db), /missing required capability requirement/);
    db.close();
  });

  it('7. retains schemaCurrent true on future capability version but fails exact compatibility', () => {
    const db = createBaseDb(true);
    migratePublicationConsent(db);
    db.exec("UPDATE cdr_runtime_capability_requirements SET format_version = 2 WHERE component = 'recovery_publication_consent'");

    assert.equal(schemaCurrentPublicationConsent(db), true);
    assert.throws(
      () => checkPublicationConsentCompatibility(db, 1n),
      (err: unknown) => err instanceof PublicationConsentIntegrityError &&
        err.message.includes('unsupported or incomplete consent ledger capability')
    );
    assert.throws(
      () => checkPublicationConsentCompatibility(db, 2n),
      (err: unknown) => err instanceof PublicationConsentIntegrityError &&
        err.message.includes('unsupported or incomplete consent ledger capability')
    );
    db.close();
  });

  it('8. rejects malformed DB numeric types and fractions without silent coercion', () => {
    const db = createBaseDb(true);
    migratePublicationConsent(db);

    db.exec("UPDATE cdr_runtime_capability_requirements SET format_version = 1.5 WHERE component = 'recovery_publication_consent'");
    assert.throws(() => checkPublicationConsentCompatibility(db, 1n), TypeError);

    db.exec("UPDATE cdr_runtime_capability_requirements SET format_version = '1' WHERE component = 'recovery_publication_consent'");
    const row = db
      .prepare("SELECT typeof(format_version) AS type FROM cdr_runtime_capability_requirements WHERE component = 'recovery_publication_consent'")
      .get() as { type: string };
    assert.equal(row.type, 'integer');
    assert.doesNotThrow(() => checkPublicationConsentCompatibility(db, 1n));

    db.exec("UPDATE cdr_runtime_capability_requirements SET format_version = 'bad' WHERE component = 'recovery_publication_consent'");
    assert.throws(() => checkPublicationConsentCompatibility(db, 1n), TypeError);
    db.close();
  });

  it('9. rejects partial ledger and dropped trigger with no mutation or repair', () => {
    const db = createBaseDb(true);
    migratePublicationConsent(db);
    db.exec('DROP TRIGGER cdr_recovery_publication_decision_no_delete');

    assert.equal(schemaCurrentPublicationConsent(db), false);
    assert.throws(
      () => checkPublicationConsentCompatibility(db, 1n),
      PublicationConsentIntegrityError
    );

    // Verify dropped trigger was not repaired by the read-only compatibility check
    assert.equal(schemaCurrentPublicationConsent(db), false);
    db.close();
  });

  it('10. fails on empty table with consumed column mismatch with no repair', () => {
    const db = createBaseDb(true);
    migratePublicationConsent(db);

    // Drop delivery table and recreate with missing body_sha256 column
    db.exec(`
      DROP TABLE cdr_recovery_publication_deliveries;
      CREATE TABLE cdr_recovery_publication_deliveries (
        proposal_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>0),
        message_id INTEGER NOT NULL CHECK(message_id>0)
      );
      CREATE TRIGGER IF NOT EXISTS cdr_recovery_publication_delivery_immutable
      BEFORE UPDATE ON cdr_recovery_publication_deliveries
      BEGIN SELECT RAISE(ABORT,'publication delivery binding is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS cdr_recovery_publication_delivery_no_delete
      BEFORE DELETE ON cdr_recovery_publication_deliveries
      BEGIN SELECT RAISE(ABORT,'publication delivery cannot be forgotten'); END;
    `);

    assert.throws(
      () => checkPublicationConsentCompatibility(db, 1n),
      /no such column: body_sha256/
    );
    db.close();
  });

  it('11. rejects stored proposal with invalid format_version or non-positive revision', () => {
    const db = createBaseDb(true);
    migratePublicationConsent(db);

    // Recreate proposals table without CHECK constraint to simulate corrupt historical stored row
    db.exec(`
      DROP TABLE cdr_recovery_publication_proposals;
      CREATE TABLE cdr_recovery_publication_proposals (
        id TEXT PRIMARY KEY NOT NULL,
        format_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        job_id TEXT NOT NULL,
        target_thread_id TEXT NOT NULL,
        owner_user_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        application_id INTEGER NOT NULL,
        seal_json TEXT NOT NULL,
        seal_sha256 TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS cdr_recovery_publication_job_revision
      ON cdr_recovery_publication_proposals(job_id,revision);
      CREATE TRIGGER IF NOT EXISTS cdr_recovery_publication_proposal_immutable
      BEFORE UPDATE ON cdr_recovery_publication_proposals
      BEGIN SELECT RAISE(ABORT,'publication proposal is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS cdr_recovery_publication_proposal_no_delete
      BEFORE DELETE ON cdr_recovery_publication_proposals
      BEGIN SELECT RAISE(ABORT,'publication proposal cannot be forgotten'); END;
    `);

    db.exec(`
      INSERT INTO cdr_recovery_publication_proposals (
        id, format_version, revision, job_id, target_thread_id,
        owner_user_id, channel_id, application_id, seal_json, seal_sha256
      ) VALUES (
        '0123456789abcdef0123456789abcdef', 2, 1, 'job-bad', 'thread-1',
        100, 200, 300, '{"valid":true}', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      );
    `);

    assert.throws(
      () => checkPublicationConsentCompatibility(db, 1n),
      (err: unknown) => err instanceof PublicationConsentIntegrityError &&
        err.message.includes('unsupported stored consent proposal')
    );

    db.close();

    const db2 = createBaseDb(true);
    migratePublicationConsent(db2);

    db2.exec(`
      DROP TABLE cdr_recovery_publication_proposals;
      CREATE TABLE cdr_recovery_publication_proposals (
        id TEXT PRIMARY KEY NOT NULL,
        format_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        job_id TEXT NOT NULL,
        target_thread_id TEXT NOT NULL,
        owner_user_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        application_id INTEGER NOT NULL,
        seal_json TEXT NOT NULL,
        seal_sha256 TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS cdr_recovery_publication_job_revision
      ON cdr_recovery_publication_proposals(job_id,revision);
      CREATE TRIGGER IF NOT EXISTS cdr_recovery_publication_proposal_immutable
      BEFORE UPDATE ON cdr_recovery_publication_proposals
      BEGIN SELECT RAISE(ABORT,'publication proposal is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS cdr_recovery_publication_proposal_no_delete
      BEFORE DELETE ON cdr_recovery_publication_proposals
      BEGIN SELECT RAISE(ABORT,'publication proposal cannot be forgotten'); END;
    `);

    db2.exec(`
      INSERT INTO cdr_recovery_publication_proposals (
        id, format_version, revision, job_id, target_thread_id,
        owner_user_id, channel_id, application_id, seal_json, seal_sha256
      ) VALUES (
        'abcdef0123456789abcdef0123456789', 1, 0, 'job-bad-2', 'thread-1',
        100, 200, 300, '{"valid":true}', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      );
    `);

    assert.throws(
      () => checkPublicationConsentCompatibility(db2, 1n),
      (err: unknown) => err instanceof PublicationConsentIntegrityError &&
        err.message.includes('unsupported stored consent proposal')
    );
    db2.close();
  });

  it('12. enforces immutable UPDATE and DELETE guards on actual ledger records', () => {
    const db = createBaseDb(true);
    migratePublicationConsent(db);

    db.exec(VALID_PROPOSAL_SQL);
    db.exec(VALID_DELIVERY_SQL);
    db.exec(VALID_DECISION_SQL);

    assert.throws(
      () => db.exec("UPDATE cdr_recovery_publication_proposals SET job_id = 'job-002' WHERE id = '0123456789abcdef0123456789abcdef'"),
      /publication proposal is immutable/
    );
    assert.throws(
      () => db.exec("DELETE FROM cdr_recovery_publication_proposals WHERE id = '0123456789abcdef0123456789abcdef'"),
      /publication proposal cannot be forgotten/
    );

    assert.throws(
      () => db.exec("UPDATE cdr_recovery_publication_deliveries SET message_id = 9999 WHERE proposal_id = '0123456789abcdef0123456789abcdef'"),
      /publication delivery binding is immutable/
    );
    assert.throws(
      () => db.exec("DELETE FROM cdr_recovery_publication_deliveries WHERE proposal_id = '0123456789abcdef0123456789abcdef'"),
      /publication delivery cannot be forgotten/
    );

    assert.throws(
      () => db.exec("UPDATE cdr_recovery_publication_decisions SET decision = 'keep_held' WHERE proposal_id = '0123456789abcdef0123456789abcdef'"),
      /publication decision is immutable/
    );
    assert.throws(
      () => db.exec("DELETE FROM cdr_recovery_publication_decisions WHERE proposal_id = '0123456789abcdef0123456789abcdef'"),
      /publication decision cannot be forgotten/
    );

    db.close();
  });
});
