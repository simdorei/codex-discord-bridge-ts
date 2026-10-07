import type { DatabaseSync } from 'node:sqlite';

export const COMPONENT = 'recovery_publication_consent';
export const FORMAT_VERSION = 1n;

export class PublicationConsentIntegrityError extends Error {
  readonly kind = 'Integrity' as const;

  constructor(reason: string) {
    super(`SQLite integrity check failed: recovery publication consent held: ${reason}`);
    this.name = 'PublicationConsentIntegrityError';
  }
}

export const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS cdr_recovery_publication_proposals (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=32),
    format_version INTEGER NOT NULL CHECK(format_version=1),
    revision INTEGER NOT NULL CHECK(revision>0),
    job_id TEXT NOT NULL,
    target_thread_id TEXT NOT NULL,
    owner_user_id INTEGER NOT NULL CHECK(owner_user_id>0),
    channel_id INTEGER NOT NULL CHECK(channel_id>0),
    application_id INTEGER NOT NULL CHECK(application_id>0),
    seal_json TEXT NOT NULL CHECK(json_valid(seal_json) AND length(CAST(seal_json AS BLOB))<=524288),
    seal_sha256 TEXT NOT NULL CHECK(length(seal_sha256)=64)
);
CREATE UNIQUE INDEX IF NOT EXISTS cdr_recovery_publication_job_revision
ON cdr_recovery_publication_proposals(job_id,revision);
CREATE TABLE IF NOT EXISTS cdr_recovery_publication_deliveries (
    proposal_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0),
    message_id INTEGER NOT NULL CHECK(message_id>0),
    body_sha256 TEXT NOT NULL CHECK(length(body_sha256)=64)
);
CREATE TABLE IF NOT EXISTS cdr_recovery_publication_decisions (
    proposal_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0),
    ingress_id TEXT NOT NULL UNIQUE,
    interaction_id INTEGER NOT NULL UNIQUE CHECK(interaction_id>0),
    decision TEXT NOT NULL CHECK(decision IN ('approve_exact','keep_held')),
    recorded_at_bits TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS cdr_recovery_publication_proposal_immutable
BEFORE UPDATE ON cdr_recovery_publication_proposals
BEGIN SELECT RAISE(ABORT,'publication proposal is immutable'); END;
CREATE TRIGGER IF NOT EXISTS cdr_recovery_publication_proposal_no_delete
BEFORE DELETE ON cdr_recovery_publication_proposals
BEGIN SELECT RAISE(ABORT,'publication proposal cannot be forgotten'); END;
CREATE TRIGGER IF NOT EXISTS cdr_recovery_publication_delivery_immutable
BEFORE UPDATE ON cdr_recovery_publication_deliveries
BEGIN SELECT RAISE(ABORT,'publication delivery binding is immutable'); END;
CREATE TRIGGER IF NOT EXISTS cdr_recovery_publication_delivery_no_delete
BEFORE DELETE ON cdr_recovery_publication_deliveries
BEGIN SELECT RAISE(ABORT,'publication delivery cannot be forgotten'); END;
CREATE TRIGGER IF NOT EXISTS cdr_recovery_publication_decision_immutable
BEFORE UPDATE ON cdr_recovery_publication_decisions
BEGIN SELECT RAISE(ABORT,'publication decision is immutable'); END;
CREATE TRIGGER IF NOT EXISTS cdr_recovery_publication_decision_no_delete
BEFORE DELETE ON cdr_recovery_publication_decisions
BEGIN SELECT RAISE(ABORT,'publication decision cannot be forgotten'); END;`;

function parseI64(value: unknown, context: string): bigint {
  if (typeof value === 'bigint') {
    if (value < -9223372036854775808n || value > 9223372036854775807n) {
      throw new RangeError(`Value ${value} for ${context} is out of i64 range`);
    }
    return value;
  }
  throw new TypeError(
    `Invalid i64 value for ${context}: expected bigint, got ${typeof value === 'number' ? `fraction/float ${value}` : typeof value}`
  );
}

export function migratePublicationConsent(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
  const insertStmt = db.prepare(
    'INSERT OR IGNORE INTO cdr_runtime_capability_requirements(component,format_version) VALUES(?,?)'
  );
  insertStmt.run(COMPONENT, FORMAT_VERSION);

  // RAISE(IGNORE) must not leave the new ledger without a launch requirement.
  const queryStmt = db.prepare(
    'SELECT format_version FROM cdr_runtime_capability_requirements WHERE component=? AND format_version>=?'
  );
  queryStmt.setReadBigInts(true);
  const row = queryStmt.get(COMPONENT, FORMAT_VERSION) as { format_version?: unknown } | undefined;
  if (!row || row.format_version === undefined || row.format_version === null) {
    throw new Error('missing required capability requirement');
  }
  parseI64(row.format_version, 'cdr_runtime_capability_requirements.format_version');
}

export function schemaCurrentPublicationConsent(db: DatabaseSync): boolean {
  const schemaStmt = db.prepare(
    "SELECT (count(*) = 10) AS present FROM sqlite_schema WHERE name IN (" +
    "'cdr_recovery_publication_proposals','cdr_recovery_publication_deliveries'," +
    "'cdr_recovery_publication_decisions','cdr_recovery_publication_job_revision'," +
    "'cdr_recovery_publication_proposal_immutable','cdr_recovery_publication_proposal_no_delete'," +
    "'cdr_recovery_publication_delivery_immutable','cdr_recovery_publication_delivery_no_delete'," +
    "'cdr_recovery_publication_decision_immutable','cdr_recovery_publication_decision_no_delete')"
  );
  schemaStmt.setReadBigInts(true);
  const schemaRow = schemaStmt.get() as { present?: unknown } | undefined;
  const isPresent = schemaRow?.present === 1n || schemaRow?.present === 1;
  if (!isPresent) {
    return false;
  }

  const existsStmt = db.prepare(
    'SELECT EXISTS(SELECT 1 FROM cdr_runtime_capability_requirements WHERE component = ? AND format_version >= ?) AS present'
  );
  existsStmt.setReadBigInts(true);
  const existsRow = existsStmt.get(COMPONENT, FORMAT_VERSION) as { present?: unknown } | undefined;
  return existsRow?.present === 1n || existsRow?.present === 1;
}

export function checkPublicationConsentCompatibility(db: DatabaseSync, required: bigint): void {
  if (typeof required !== 'bigint') {
    throw new TypeError(`Expected bigint for required, got ${typeof required}`);
  }
  parseI64(required, 'required');

  const countStmt = db.prepare(
    "SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name IN (" +
    "'cdr_recovery_publication_proposals','cdr_recovery_publication_deliveries'," +
    "'cdr_recovery_publication_decisions')"
  );
  countStmt.setReadBigInts(true);
  const countRow = countStmt.get() as { count?: unknown } | undefined;
  const count = typeof countRow?.count === 'bigint' ? countRow.count : (typeof countRow?.count === 'number' ? BigInt(countRow.count) : 0n);

  if (required === 0n && count === 0n) {
    return;
  }

  const persistedStmt = db.prepare(
    'SELECT format_version FROM cdr_runtime_capability_requirements WHERE component = ?'
  );
  persistedStmt.setReadBigInts(true);
  const persistedRow = persistedStmt.get(COMPONENT) as { format_version?: unknown } | undefined;
  let persisted: bigint | null = null;
  if (persistedRow !== undefined && persistedRow.format_version !== null && persistedRow.format_version !== undefined) {
    persisted = parseI64(persistedRow.format_version, 'cdr_runtime_capability_requirements.format_version');
  }

  if (required !== FORMAT_VERSION || persisted !== required || !schemaCurrentPublicationConsent(db)) {
    throw new PublicationConsentIntegrityError('unsupported or incomplete consent ledger capability');
  }

  const unsupportedStmt = db.prepare(
    'SELECT EXISTS(SELECT 1 FROM cdr_recovery_publication_proposals WHERE format_version != ? OR revision < 1) AS unsupported'
  );
  unsupportedStmt.setReadBigInts(true);
  const unsupportedRow = unsupportedStmt.get(FORMAT_VERSION) as { unsupported?: unknown } | undefined;
  const isUnsupported = unsupportedRow?.unsupported === 1n || unsupportedRow?.unsupported === 1;
  if (isUnsupported) {
    throw new PublicationConsentIntegrityError('unsupported stored consent proposal');
  }

  // Validate the consumed column contract, including empty tables.
  db.prepare(
    'SELECT id,format_version,revision,job_id,target_thread_id,owner_user_id,channel_id,application_id,seal_json,seal_sha256 FROM cdr_recovery_publication_proposals LIMIT 0'
  );
  db.prepare(
    'SELECT proposal_id,revision,message_id,body_sha256 FROM cdr_recovery_publication_deliveries LIMIT 0'
  );
  db.prepare(
    'SELECT proposal_id,revision,ingress_id,interaction_id,decision,recorded_at_bits FROM cdr_recovery_publication_decisions LIMIT 0'
  );
}
