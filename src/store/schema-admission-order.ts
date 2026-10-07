import { DatabaseSync } from 'node:sqlite';

const COMPONENT = 'recovery_admission_order';
const FORMAT_VERSION = 1n;

const SCHEMA = `CREATE TABLE IF NOT EXISTS cdr_recovery_ingress_order (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(sequence>0),
    ingress_id TEXT UNIQUE,
    kind TEXT NOT NULL CHECK(kind IN ('message','interaction','action')),
    event_id INTEGER,
    origin TEXT NOT NULL CHECK(origin IN ('legacy','admitted')),
    identity_sha256 TEXT,
    UNIQUE(kind,event_id),
    CHECK((origin='legacy' AND identity_sha256 IS NULL)
        OR (origin='admitted' AND ingress_id IS NOT NULL AND identity_sha256 IS NOT NULL
            AND length(identity_sha256)=64 AND identity_sha256 NOT GLOB '*[^0-9a-f]*'))
);
-- object --
CREATE TRIGGER IF NOT EXISTS cdr_recovery_ingress_order_no_update
BEFORE UPDATE ON cdr_recovery_ingress_order
BEGIN SELECT RAISE(ABORT,'first admission order is immutable'); END;
-- object --
CREATE TRIGGER IF NOT EXISTS cdr_recovery_ingress_order_no_delete
BEFORE DELETE ON cdr_recovery_ingress_order
BEGIN SELECT RAISE(ABORT,'first admission order cannot be forgotten'); END;
-- object --
CREATE TRIGGER IF NOT EXISTS cdr_recovery_ingress_order_no_replace
BEFORE INSERT ON cdr_recovery_ingress_order
WHEN EXISTS(SELECT 1 FROM cdr_recovery_ingress_order o WHERE o.sequence=NEW.sequence
    OR (NEW.ingress_id IS NOT NULL AND o.ingress_id=NEW.ingress_id)
    OR (NEW.event_id IS NOT NULL AND o.kind=NEW.kind AND o.event_id=NEW.event_id))
BEGIN SELECT RAISE(ABORT,'an old ingress cannot acquire a new admission order'); END;`;

export class AdmissionOrderIntegrityError extends Error {
  readonly kind = 'Integrity';
  readonly reason: string;

  constructor(reason: string) {
    super(`SQLite integrity check failed: recovery admission order held: ${reason}`);
    this.name = 'AdmissionOrderIntegrityError';
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const RUST_WS_START = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;
const RUST_WS_END = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/u;
const RUST_WS_SPLIT = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;

function rustTrim(value: string): string {
  return value.replace(RUST_WS_START, '').replace(RUST_WS_END, '');
}

function rustTrimEnd(value: string): string {
  return value.replace(RUST_WS_END, '');
}

function rustSplitWhitespace(value: string): string[] {
  const trimmed = rustTrim(value);
  if (trimmed.length === 0) {
    return [];
  }
  return trimmed.split(RUST_WS_SPLIT).filter((w) => w.length > 0);
}

function normalized(value: string): string {
  let v = rustTrim(value);
  if (v.endsWith(';')) {
    v = v.slice(0, -1);
  }
  v = rustTrimEnd(v);
  const prefixes: [string, string][] = [
    ['CREATE TABLE IF NOT EXISTS ', 'CREATE TABLE '],
    ['CREATE TRIGGER IF NOT EXISTS ', 'CREATE TRIGGER '],
  ];
  for (const [prefix, replacement] of prefixes) {
    if (v.startsWith(prefix)) {
      return `${replacement}${v.slice(prefix.length)}`;
    }
  }
  return v;
}

function objectCount(db: DatabaseSync): bigint {
  const stmt = db.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name GLOB 'cdr_recovery_ingress_order*'"
  );
  stmt.setReadBigInts(true);
  const row = stmt.get() as { count: bigint } | undefined;
  if (!row || typeof row.count !== 'bigint') {
    throw new AdmissionOrderIntegrityError('failed to query schema object count');
  }
  return row.count;
}

function requirement(db: DatabaseSync): bigint | null {
  const stmt = db.prepare(
    'SELECT format_version FROM cdr_runtime_capability_requirements WHERE component = ?'
  );
  stmt.setReadBigInts(true);
  const row = stmt.get(COMPONENT) as { format_version?: unknown } | undefined;
  if (!row) {
    return null;
  }
  const val = row.format_version;
  if (typeof val !== 'bigint') {
    throw new AdmissionOrderIntegrityError('invalid format version type');
  }
  return val;
}

function catalogMatches(db: DatabaseSync): boolean {
  let count = 0n;
  const objects = SCHEMA.split('-- object --');
  const stmt = db.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?');

  for (const rawDef of objects) {
    const definition = rustTrim(rawDef);
    if (definition.length === 0) {
      continue;
    }
    const words = rustSplitWhitespace(definition);
    if (words[0] !== 'CREATE') {
      throw new AdmissionOrderIntegrityError('invalid built-in DDL');
    }
    let kind: string;
    if (words[1] === 'TABLE') {
      kind = 'table';
    } else if (words[1] === 'TRIGGER') {
      kind = 'trigger';
    } else {
      throw new AdmissionOrderIntegrityError('unsupported built-in DDL');
    }
    if (words[2] !== 'IF' || words[3] !== 'NOT' || words[4] !== 'EXISTS') {
      throw new AdmissionOrderIntegrityError('invalid built-in object prefix');
    }
    const name = words[5];
    if (!name) {
      throw new AdmissionOrderIntegrityError('missing built-in object name');
    }

    const row = stmt.get(kind, name) as { sql?: string | null } | undefined;
    if (!row || typeof row.sql !== 'string') {
      return false;
    }
    if (normalized(row.sql) !== normalized(definition)) {
      return false;
    }
    count += 1n;
  }

  return objectCount(db) === count;
}

export function schemaCurrentAdmissionOrder(db: DatabaseSync): boolean {
  return catalogMatches(db) && requirement(db) === FORMAT_VERSION;
}

export function migrateAdmissionOrder(db: DatabaseSync): void {
  // A partial/missing ledger with a persisted capability is lost history,
  // not permission to reset its monotonic boundary or repair it in place.
  if (objectCount(db) !== 0n || requirement(db) !== null) {
    return checkAdmissionOrderCompatibility(db, FORMAT_VERSION);
  }

  db.exec(SCHEMA);

  // Existing source rows get legacy markers, never invented fresh authority.
  // The ID-only legacy set is retained too, even after ordinary pruning.
  db.exec(
    "INSERT INTO cdr_recovery_ingress_order(ingress_id,kind,event_id,origin)\n" +
    " SELECT ingress_id,kind,event_id,'legacy' FROM discord_ingress_journal ORDER BY rowid;\n" +
    " INSERT INTO cdr_recovery_ingress_order(ingress_id,kind,event_id,origin)\n" +
    " SELECT NULL,'message',p.message_id,'legacy' FROM discord_processed_messages p\n" +
    " WHERE NOT EXISTS(SELECT 1 FROM cdr_recovery_ingress_order o\n" +
    "     WHERE o.kind='message' AND o.event_id=p.message_id) ORDER BY p.message_id;"
  );

  const verifyStmt = db.prepare(
    "SELECT NOT EXISTS(SELECT 1 FROM discord_ingress_journal j WHERE NOT EXISTS(\n" +
    "    SELECT 1 FROM cdr_recovery_ingress_order o WHERE o.ingress_id IS j.ingress_id\n" +
    "    AND o.kind=j.kind AND o.event_id IS j.event_id AND o.origin='legacy'))\n" +
    " AND NOT EXISTS(SELECT 1 FROM discord_processed_messages p WHERE NOT EXISTS(\n" +
    "    SELECT 1 FROM cdr_recovery_ingress_order o WHERE o.kind='message' AND o.event_id=p.message_id)) AS complete"
  );
  verifyStmt.setReadBigInts(true);
  const verifyRow = verifyStmt.get() as { complete?: bigint | number } | undefined;
  const complete = verifyRow && (verifyRow.complete === 1n || verifyRow.complete === 1);
  if (!complete) {
    throw new AdmissionOrderIntegrityError('legacy admission inventory was not retained');
  }

  const insertCapStmt = db.prepare(
    'INSERT INTO cdr_runtime_capability_requirements(component,format_version) VALUES(?,?)'
  );
  const insertCapResult = insertCapStmt.run(COMPONENT, FORMAT_VERSION);
  if (insertCapResult.changes !== 1 && insertCapResult.changes !== 1n) {
    throw new AdmissionOrderIntegrityError('required capability was not retained');
  }

  checkAdmissionOrderCompatibility(db, FORMAT_VERSION);
}

export function checkAdmissionOrderCompatibility(db: DatabaseSync, required: bigint): void {
  if (required === 0n && objectCount(db) === 0n) {
    return;
  }
  if (required !== FORMAT_VERSION || !schemaCurrentAdmissionOrder(db)) {
    throw new AdmissionOrderIntegrityError('unsupported or incomplete durable admission order');
  }
}
