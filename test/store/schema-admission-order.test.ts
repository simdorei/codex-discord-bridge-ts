import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  migrateAdmissionOrder,
  schemaCurrentAdmissionOrder,
  checkAdmissionOrderCompatibility,
  AdmissionOrderIntegrityError,
} from '../../src/store/schema-admission-order.ts';

const trackedDbs: DatabaseSync[] = [];

function trackDb(db: DatabaseSync): DatabaseSync {
  trackedDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of trackedDbs) {
    try {
      db.close();
    } catch {
      // ignore already closed
    }
  }
  trackedDbs.length = 0;
});

function createBaseDb(): DatabaseSync {
  const db = trackDb(new DatabaseSync(':memory:'));
  db.exec(`
    CREATE TABLE cdr_runtime_capability_requirements (
      component TEXT PRIMARY KEY,
      format_version INTEGER NOT NULL
    );
    CREATE TABLE discord_ingress_journal (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      ingress_id TEXT,
      kind TEXT NOT NULL,
      event_id INTEGER
    );
    CREATE TABLE discord_processed_messages (
      message_id INTEGER PRIMARY KEY
    );
  `);
  return db;
}

describe('1. fresh legacy accept and migrate', () => {
  it('migrates journal and processed messages into recovery ingress order with null SHA', () => {
    const db = createBaseDb();
    db.exec(`
      INSERT INTO discord_ingress_journal (ingress_id, kind, event_id) VALUES
        ('ing-1', 'message', 101),
        ('ing-2', 'interaction', 102);
      INSERT INTO discord_processed_messages (message_id) VALUES
        (101),
        (201);
    `);

    migrateAdmissionOrder(db);

    const rows = (
      db.prepare('SELECT sequence, ingress_id, kind, event_id, origin, identity_sha256 FROM cdr_recovery_ingress_order ORDER BY sequence').all() as any[]
    ).map((row) => ({ ...row }));
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], {
      sequence: 1,
      ingress_id: 'ing-1',
      kind: 'message',
      event_id: 101,
      origin: 'legacy',
      identity_sha256: null,
    });
    assert.deepEqual(rows[1], {
      sequence: 2,
      ingress_id: 'ing-2',
      kind: 'interaction',
      event_id: 102,
      origin: 'legacy',
      identity_sha256: null,
    });
    assert.deepEqual(rows[2], {
      sequence: 3,
      ingress_id: null,
      kind: 'message',
      event_id: 201,
      origin: 'legacy',
      identity_sha256: null,
    });

    const cap = db.prepare("SELECT format_version FROM cdr_runtime_capability_requirements WHERE component = 'recovery_admission_order'").get() as any;
    assert.equal(cap.format_version, 1);
    assert.equal(schemaCurrentAdmissionOrder(db), true);
    assert.doesNotThrow(() => checkAdmissionOrderCompatibility(db, 1n));
  });
});

describe('2. old processed deduplication and ordering', () => {
  it('excludes known kind message / event id from journal and sorts remaining by message_id', () => {
    const db = createBaseDb();
    db.exec(`
      INSERT INTO discord_ingress_journal (ingress_id, kind, event_id) VALUES
        ('ing-1', 'interaction', 50),
        ('ing-2', 'message', 100);
      INSERT INTO discord_processed_messages (message_id) VALUES
        (50),
        (300),
        (200),
        (100);
    `);

    migrateAdmissionOrder(db);

    const rows = (
      db.prepare("SELECT kind, event_id, origin FROM cdr_recovery_ingress_order WHERE ingress_id IS NULL ORDER BY sequence").all() as any[]
    ).map((row) => ({ ...row }));
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { kind: 'message', event_id: 50, origin: 'legacy' });
    assert.deepEqual(rows[1], { kind: 'message', event_id: 200, origin: 'legacy' });
    assert.deepEqual(rows[2], { kind: 'message', event_id: 300, origin: 'legacy' });
  });
});

describe('3. migration repeat never resets or backfills newer rows', () => {
  it('is idempotent, preserves newly admitted rows, and ignores subsequent journal entries', () => {
    const db = createBaseDb();
    migrateAdmissionOrder(db);

    const sha = 'a'.repeat(64);
    db.prepare("INSERT INTO cdr_recovery_ingress_order (sequence, ingress_id, kind, event_id, origin, identity_sha256) VALUES (1, 'ing-new', 'message', 999, 'admitted', ?)").run(sha);
    db.exec("INSERT INTO discord_ingress_journal (ingress_id, kind, event_id) VALUES ('late-1', 'message', 888)");

    migrateAdmissionOrder(db);

    const count = db.prepare('SELECT COUNT(*) AS count FROM cdr_recovery_ingress_order').get() as any;
    assert.equal(count.count, 1);
    const row = db.prepare('SELECT ingress_id, origin, identity_sha256 FROM cdr_recovery_ingress_order WHERE sequence = 1').get() as any;
    assert.equal(row.ingress_id, 'ing-new');
    assert.equal(row.origin, 'admitted');
    assert.equal(row.identity_sha256, sha);
  });
});

describe('4. immutable order UPDATE, DELETE, and monotonic replace guards', () => {
  it('rejects updates, deletes, and duplicate replacements via installed triggers', () => {
    const db = createBaseDb();
    migrateAdmissionOrder(db);

    const sha = 'b'.repeat(64);
    db.prepare("INSERT INTO cdr_recovery_ingress_order (sequence, ingress_id, kind, event_id, origin, identity_sha256) VALUES (1, 'ing-1', 'message', 10, 'admitted', ?)").run(sha);

    assert.throws(
      () => db.exec("UPDATE cdr_recovery_ingress_order SET origin = 'legacy' WHERE sequence = 1"),
      /first admission order is immutable/
    );

    assert.throws(
      () => db.exec('DELETE FROM cdr_recovery_ingress_order WHERE sequence = 1'),
      /first admission order cannot be forgotten/
    );

    assert.throws(
      () => db.prepare("INSERT INTO cdr_recovery_ingress_order (sequence, ingress_id, kind, event_id, origin, identity_sha256) VALUES (1, 'ing-2', 'action', 20, 'admitted', ?)").run(sha),
      /an old ingress cannot acquire a new admission order/
    );

    assert.throws(
      () => db.prepare("INSERT INTO cdr_recovery_ingress_order (sequence, ingress_id, kind, event_id, origin, identity_sha256) VALUES (2, 'ing-1', 'action', 20, 'admitted', ?)").run(sha),
      /an old ingress cannot acquire a new admission order/
    );

    assert.throws(
      () => db.prepare("INSERT INTO cdr_recovery_ingress_order (sequence, ingress_id, kind, event_id, origin, identity_sha256) VALUES (2, 'ing-2', 'message', 10, 'admitted', ?)").run(sha),
      /an old ingress cannot acquire a new admission order/
    );
  });
});

describe('5. full catalog stable and required checks', () => {
  it('validates schemaCurrentAdmissionOrder and compatibility checks', () => {
    const db = createBaseDb();
    assert.doesNotThrow(() => checkAdmissionOrderCompatibility(db, 0n));

    migrateAdmissionOrder(db);

    const catalogQuery = 'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name';
    const before = (db.prepare(catalogQuery).all() as any[]).map((row) => ({ ...row }));

    migrateAdmissionOrder(db);

    const after = (db.prepare(catalogQuery).all() as any[]).map((row) => ({ ...row }));
    assert.deepEqual(after, before);

    assert.equal(schemaCurrentAdmissionOrder(db), true);
    assert.doesNotThrow(() => checkAdmissionOrderCompatibility(db, 1n));

    assert.throws(
      () => checkAdmissionOrderCompatibility(db, 0n),
      (err: any) => err instanceof AdmissionOrderIntegrityError && err.kind === 'Integrity'
    );
  });
});

describe('6. caller BEGIN / DDL rollback', () => {
  it('rolls back completely within caller transaction on failure', () => {
    const db = createBaseDb();
    db.exec('BEGIN');
    migrateAdmissionOrder(db);
    db.exec('ROLLBACK');

    const count = db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name GLOB 'cdr_recovery_ingress_order*'").get() as any;
    assert.equal(count.count, 0);
  });
});

describe('7. partial / dropped trigger and cap-only no repair', () => {
  it('fails and does not repair when a trigger is missing or only capability exists', () => {
    const db = createBaseDb();
    migrateAdmissionOrder(db);
    db.exec('DROP TRIGGER cdr_recovery_ingress_order_no_update');

    assert.throws(
      () => migrateAdmissionOrder(db),
      (err: any) => err instanceof AdmissionOrderIntegrityError
    );
    assert.equal(schemaCurrentAdmissionOrder(db), false);

    const db2 = createBaseDb();
    db2.exec("INSERT INTO cdr_runtime_capability_requirements (component, format_version) VALUES ('recovery_admission_order', 1)");
    assert.throws(
      () => migrateAdmissionOrder(db2),
      (err: any) => err instanceof AdmissionOrderIntegrityError
    );
    const count = db2.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name GLOB 'cdr_recovery_ingress_order*'").get() as any;
    assert.equal(count.count, 0);
  });
});

describe('8. changed DDL body / extra family object rejected', () => {
  it('rejects altered table definition or extra family object even if empty', () => {
    const db = createBaseDb();
    migrateAdmissionOrder(db);
    db.exec('CREATE TABLE cdr_recovery_ingress_order_extra (id INTEGER)');

    assert.equal(schemaCurrentAdmissionOrder(db), false);
    assert.throws(
      () => checkAdmissionOrderCompatibility(db, 1n),
      (err: any) => err instanceof AdmissionOrderIntegrityError
    );

    const db2 = createBaseDb();
    migrateAdmissionOrder(db2);
    db2.enableDefensive(false);
    try {
      db2.exec('PRAGMA writable_schema = ON;');
      db2.exec("UPDATE sqlite_schema SET sql = sql || ' -- modified' WHERE name = 'cdr_recovery_ingress_order'");
      db2.exec('PRAGMA writable_schema = OFF;');
    } finally {
      db2.enableDefensive(true);
    }
    assert.equal(schemaCurrentAdmissionOrder(db2), false);
  });
});

describe('9. future and large cap rejected without number loss', () => {
  it('rejects large and invalid format versions without precision loss', () => {
    const db = createBaseDb();
    migrateAdmissionOrder(db);

    const largeCap = 9223372036854775807n;
    db.prepare("UPDATE cdr_runtime_capability_requirements SET format_version = ? WHERE component = 'recovery_admission_order'").run(largeCap);

    assert.equal(schemaCurrentAdmissionOrder(db), false);
    assert.throws(
      () => checkAdmissionOrderCompatibility(db, 1n),
      (err: any) => err instanceof AdmissionOrderIntegrityError
    );
    assert.throws(
      () => checkAdmissionOrderCompatibility(db, largeCap),
      (err: any) => err instanceof AdmissionOrderIntegrityError
    );

    db.exec("UPDATE cdr_runtime_capability_requirements SET format_version = 1.5 WHERE component = 'recovery_admission_order'");
    assert.throws(
      () => schemaCurrentAdmissionOrder(db),
      (err: any) => err instanceof AdmissionOrderIntegrityError
    );
  });
});

describe('10. ignored capability INSERT error within caller rollback', () => {
  it('fails migration when capability INSERT changes !== 1 and rolls back cleanly', () => {
    const db = createBaseDb();
    db.exec(`
      CREATE TRIGGER ignore_cap_insert
      BEFORE INSERT ON cdr_runtime_capability_requirements
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);

    db.exec('BEGIN');
    assert.throws(
      () => migrateAdmissionOrder(db),
      /required capability was not retained/
    );
    db.exec('ROLLBACK');

    const count = db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name GLOB 'cdr_recovery_ingress_order*'").get() as any;
    assert.equal(count.count, 0);
  });
});

describe('11. required 0 absent family only accept', () => {
  it('accepts required 0 only when object family is entirely absent', () => {
    const db = trackDb(new DatabaseSync(':memory:'));
    assert.doesNotThrow(() => checkAdmissionOrderCompatibility(db, 0n));

    assert.throws(
      () => checkAdmissionOrderCompatibility(db, 1n),
      (err: any) => err instanceof AdmissionOrderIntegrityError
    );
  });
});

describe('12. RustWS normalization NEL and BOM cases', () => {
  it('accepts NEL as whitespace and rejects BOM on installed schema', () => {
    const db = createBaseDb();
    migrateAdmissionOrder(db);

    const orig = (db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'cdr_recovery_ingress_order'").get() as any).sql;

    // NEL (\u0085) should be trimmed and accepted
    db.enableDefensive(false);
    try {
      db.exec('PRAGMA writable_schema = ON;');
      db.prepare("UPDATE sqlite_schema SET sql = ? WHERE name = 'cdr_recovery_ingress_order'").run(`\u0085${orig}\u0085`);
      db.exec('PRAGMA writable_schema = OFF;');
    } finally {
      db.enableDefensive(true);
    }
    assert.equal(schemaCurrentAdmissionOrder(db), true);

    // BOM (\uFEFF) should NOT be trimmed and must be rejected
    db.enableDefensive(false);
    try {
      db.exec('PRAGMA writable_schema = ON;');
      db.prepare("UPDATE sqlite_schema SET sql = ? WHERE name = 'cdr_recovery_ingress_order'").run(`\uFEFF${orig}`);
      db.exec('PRAGMA writable_schema = OFF;');
    } finally {
      db.enableDefensive(true);
    }
    assert.equal(schemaCurrentAdmissionOrder(db), false);
    assert.throws(
      () => checkAdmissionOrderCompatibility(db, 1n),
      (err: any) => err instanceof AdmissionOrderIntegrityError
    );
  });
});
