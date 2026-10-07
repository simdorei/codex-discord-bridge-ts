import type { DatabaseSync } from 'node:sqlite';

export class SchemaExtensionError extends Error {
  readonly kind: 'ActiveTransaction' | 'Integrity';

  constructor(kind: 'ActiveTransaction' | 'Integrity', message: string) {
    super(message);
    this.name = 'SchemaExtensionError';
    this.kind = kind;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static activeTransaction(): SchemaExtensionError {
    return new SchemaExtensionError(
      'ActiveTransaction',
      'store schema migration requires a connection without an active transaction'
    );
  }

  static integrity(details: string): SchemaExtensionError {
    return new SchemaExtensionError(
      'Integrity',
      `SQLite integrity check failed: ${details}`
    );
  }
}

function isInTransaction(db: DatabaseSync): boolean {
  const desc =
    Object.getOwnPropertyDescriptor(db, 'isTransaction') ??
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(db), 'isTransaction');
  if (desc && typeof desc.get === 'function') {
    return Boolean(desc.get.call(db));
  }
  const val = (db as unknown as { isTransaction?: unknown }).isTransaction;
  if (typeof val === 'function') {
    return Boolean((val as () => boolean).call(db));
  }
  return Boolean(val);
}

function stripPrefix(sql: string, prefix: string): string | null {
  if (sql.startsWith(prefix)) {
    return sql.slice(prefix.length);
  }
  return null;
}

const RUST_WHITESPACE_START =
  /^[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/u;
const RUST_WHITESPACE_END =
  /[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/u;

function rustTrim(sql: string): string {
  return sql.replace(RUST_WHITESPACE_START, '').replace(RUST_WHITESPACE_END, '');
}

function rustTrimEnd(sql: string): string {
  return sql.replace(RUST_WHITESPACE_END, '');
}

function viewBody(sql: string): string {
  let trimmed = rustTrim(sql);
  while (trimmed.endsWith(';')) {
    trimmed = trimmed.slice(0, -1);
  }
  trimmed = rustTrimEnd(trimmed);
  const stripped =
    stripPrefix(trimmed, 'CREATE VIEW IF NOT EXISTS ') ??
    stripPrefix(trimmed, 'CREATE VIEW ');
  return stripped ?? trimmed;
}

export function sameDefinition(actual: string, expected: string): boolean {
  return viewBody(actual) === viewBody(expected);
}

interface InstalledSchemaObject {
  readonly type: string;
  readonly sql: string | null;
}

function installedView(db: DatabaseSync): InstalledSchemaObject | null {
  const stmt = db.prepare(
    "SELECT type, sql FROM sqlite_schema WHERE name='cdr_archive_inspections_v1'"
  );
  const row = stmt.get() as { type?: unknown; sql?: unknown } | undefined;
  if (!row) {
    return null;
  }
  return {
    type: typeof row.type === 'string' ? row.type : '',
    sql: typeof row.sql === 'string' ? row.sql : null,
  };
}

const ARCHIVE_INSPECTIONS_VIEW_SQL = `CREATE VIEW IF NOT EXISTS cdr_archive_inspections_v1 AS
SELECT ingress_id FROM discord_ingress_journal AS d WHERE
    (kind='message' AND json_extract(payload_json,'$.version')=1 AND (
        json_extract(payload_json,'$.plan.Execute') IN ('Help','Runners','Doctor','Where','Identity','Resources')
        OR json_type(payload_json,'$.plan.Execute.SavedRequest')='object'))
    OR (kind='interaction' AND json_extract(payload_json,'$.version')=1
        AND json_extract(payload_json,'$.work.Slash.name') IN ('help','runners','doctor','where'))
    OR (kind='message' AND application_id IS NULL
        AND owner_user_id>0 AND channel_id>0 AND event_id>0 AND source_message_id=event_id
        AND target_thread_id IS NOT NULL AND length(target_thread_id)>0
        AND json_type(payload_json,'$.version')='integer' AND json_extract(payload_json,'$.version')=1
        AND json_type(payload_json,'$.author_is_bot')='false'
        AND (json_type(payload_json,'$.processing_mode') IS NULL
            OR json_extract(payload_json,'$.processing_mode')='normal')
        AND (json_type(payload_json,'$.settings_binding') IS NULL
            OR json_type(payload_json,'$.settings_binding')='null')
        AND (json_type(payload_json,'$.lifecycle_binding') IS NULL
            OR json_type(payload_json,'$.lifecycle_binding')='null')
        AND json_type(payload_json,'$.work') IS NULL
        AND json_type(payload_json,'$.plan.Execute.DiscardRequest')='object'
        AND (SELECT count(*) FROM json_each(payload_json,'$.plan'))=1
        AND (SELECT count(*) FROM json_each(payload_json,'$.plan.Execute'))=1
        AND (SELECT count(*) FROM json_each(payload_json,'$.plan.Execute.DiscardRequest'))=1
        AND json_type(payload_json,'$.plan.Execute.DiscardRequest.job_id')='text'
        AND EXISTS(SELECT 1 FROM codex_turn_queue q
            WHERE q.job_id=json_extract(d.payload_json,'$.plan.Execute.DiscardRequest.job_id')
            AND q.target_thread_id=d.target_thread_id AND q.channel_id=d.channel_id
            AND q.owner_user_id=d.owner_user_id AND q.state='pending' AND q.turn_id IS NULL))
    OR (kind='interaction' AND application_id>0 AND event_id>0
        AND owner_user_id>0 AND channel_id>0 AND source_message_id>0
        AND target_thread_id IS NOT NULL AND length(target_thread_id)>0
        AND json_type(payload_json,'$.version')='integer' AND json_extract(payload_json,'$.version')=1
        AND (
            (SELECT count(*) FROM json_each(payload_json))=2
            OR ((SELECT count(*) FROM json_each(payload_json))=5
                AND json_extract(payload_json,'$.processing_mode')='normal'
                AND json_type(payload_json,'$.settings_binding')='null'
                AND json_type(payload_json,'$.request_rejection')='null'))
        AND (SELECT count(*) FROM json_each(payload_json,'$.work'))=1
        AND (SELECT count(*) FROM json_each(payload_json,'$.work.Component'))=1
        AND json_type(payload_json,'$.work.Component.RecoveryAbandonDecision')='object'
        AND (SELECT count(*) FROM json_each(payload_json,'$.work.Component.RecoveryAbandonDecision'))=3
        AND json_type(payload_json,'$.work.Component.RecoveryAbandonDecision.proposal_id')='text'
        AND length(json_extract(payload_json,'$.work.Component.RecoveryAbandonDecision.proposal_id'))=32
        AND json_extract(payload_json,'$.work.Component.RecoveryAbandonDecision.proposal_id') NOT GLOB '*[^0-9a-f]*'
        AND json_type(payload_json,'$.work.Component.RecoveryAbandonDecision.revision')='integer'
        AND json_extract(payload_json,'$.work.Component.RecoveryAbandonDecision.revision')>0
        AND json_extract(payload_json,'$.work.Component.RecoveryAbandonDecision.decision') IN ('AbandonOnly','KeepHeld'));`;

const ARCHIVE_INSPECTIONS_LEGACY_VIEW_SQL = `CREATE VIEW IF NOT EXISTS cdr_archive_inspections_v1 AS
SELECT ingress_id FROM discord_ingress_journal WHERE
    (kind='message' AND json_extract(payload_json,'$.version')=1 AND (
        json_extract(payload_json,'$.plan.Execute') IN ('Help','Runners','Doctor','Where','Identity','Resources')
        OR json_type(payload_json,'$.plan.Execute.SavedRequest')='object'))
    OR (kind='interaction' AND json_extract(payload_json,'$.version')=1
        AND json_extract(payload_json,'$.work.Slash.name') IN ('help','runners','doctor','where'));`;

const ARCHIVE_FENCE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS codex_archive_fences (
    target_thread_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    own_ingress_id TEXT,
    phase TEXT NOT NULL CHECK(phase IN ('attempted','verified'))
);

-- Local inspection/disposition admission is installed by schema.rs.
-- Queue and intake fences below never grant execution or replay permission.

CREATE TRIGGER IF NOT EXISTS cdr_archive_admission_v1
AFTER INSERT ON discord_ingress_journal
WHEN NOT EXISTS(SELECT 1 FROM cdr_archive_inspections_v1 WHERE ingress_id=NEW.ingress_id)
AND EXISTS(SELECT 1 FROM codex_archive_fences f
    WHERE f.target_thread_id=NEW.target_thread_id
       OR (NEW.target_thread_id IS NULL AND f.phase='attempted'))
BEGIN
    UPDATE discord_ingress_journal SET state='held',phase='archive_fenced',
        hold_reason='archive scope is reserved or archived; request is saved, not executed and will not be retried automatically'
    WHERE ingress_id=NEW.ingress_id;
END;

CREATE TRIGGER IF NOT EXISTS cdr_archive_execution_v1
BEFORE UPDATE OF state,target_thread_id ON discord_ingress_journal
WHEN NEW.state IN ('executing','owned')
AND NOT EXISTS(SELECT 1 FROM cdr_archive_inspections_v1 WHERE ingress_id=NEW.ingress_id)
AND EXISTS(
    SELECT 1 FROM codex_archive_fences f WHERE
    (f.target_thread_id=NEW.target_thread_id OR (NEW.target_thread_id IS NULL AND f.phase='attempted'))
    AND (f.own_ingress_id IS NULL OR f.own_ingress_id!=NEW.ingress_id))
BEGIN SELECT RAISE(ABORT,'archive fence prevents execution or ownership handoff'); END;

CREATE TRIGGER IF NOT EXISTS cdr_archive_held_v1
BEFORE UPDATE OF state ON discord_ingress_journal
WHEN OLD.state='held' AND OLD.phase='archive_fenced' AND NEW.state!='held'
BEGIN SELECT RAISE(ABORT,'archive-held request requires explicit review; no automatic replay'); END;

CREATE TRIGGER IF NOT EXISTS cdr_archive_queue_insert_v1
BEFORE INSERT ON codex_turn_queue
WHEN EXISTS(SELECT 1 FROM codex_archive_fences WHERE target_thread_id=NEW.target_thread_id)
BEGIN SELECT RAISE(ABORT,'archive fence prevents queue handoff'); END;

CREATE TRIGGER IF NOT EXISTS cdr_archive_queue_update_v1
BEFORE UPDATE OF target_thread_id,state ON codex_turn_queue
WHEN EXISTS(SELECT 1 FROM codex_archive_fences WHERE target_thread_id=NEW.target_thread_id)
BEGIN SELECT RAISE(ABORT,'archive fence prevents queue execution or retargeting'); END;

CREATE TRIGGER IF NOT EXISTS cdr_archive_intake_insert_v1
BEFORE INSERT ON codex_prompt_intakes
WHEN EXISTS(SELECT 1 FROM codex_archive_fences WHERE target_thread_id=NEW.target_thread_id)
BEGIN SELECT RAISE(ABORT,'archive fence prevents prompt intake handoff'); END;

CREATE TRIGGER IF NOT EXISTS cdr_archive_intake_update_v1
BEFORE UPDATE OF target_thread_id,claim_token ON codex_prompt_intakes
WHEN EXISTS(SELECT 1 FROM codex_archive_fences WHERE target_thread_id=NEW.target_thread_id)
BEGIN SELECT RAISE(ABORT,'archive fence prevents prompt intake execution or retargeting'); END;`;

export function migrateArchiveFence(db: DatabaseSync): void {
  const installed = installedView(db);
  if (installed === null) {
    db.exec(ARCHIVE_INSPECTIONS_VIEW_SQL);
  } else if (
    installed.type === 'view' &&
    installed.sql !== null &&
    sameDefinition(installed.sql, ARCHIVE_INSPECTIONS_VIEW_SQL)
  ) {
    // View definition already current
  } else if (
    installed.type === 'view' &&
    installed.sql !== null &&
    sameDefinition(installed.sql, ARCHIVE_INSPECTIONS_LEGACY_VIEW_SQL)
  ) {
    if (!isInTransaction(db)) {
      throw SchemaExtensionError.activeTransaction();
    }
    db.exec('DROP VIEW cdr_archive_inspections_v1;');
    db.exec(ARCHIVE_INSPECTIONS_VIEW_SQL);
  } else {
    throw SchemaExtensionError.integrity(
      'archive inspection definition is unknown; no automatic replacement'
    );
  }
  db.exec(ARCHIVE_FENCE_SCHEMA_SQL);
}

export function schemaCurrentArchiveFence(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*)=9 AS ok FROM sqlite_schema WHERE
         (type='table' AND name='codex_archive_fences') OR
         (type='view' AND name='cdr_archive_inspections_v1') OR
         (type='trigger' AND name IN ('cdr_archive_admission_v1','cdr_archive_execution_v1',
          'cdr_archive_held_v1','cdr_archive_queue_insert_v1','cdr_archive_queue_update_v1',
          'cdr_archive_intake_insert_v1','cdr_archive_intake_update_v1'))`
    )
    .get() as { ok?: unknown } | undefined;
  const complete = Boolean(row && Number(row.ok) === 1);
  if (!complete) {
    return false;
  }
  const installed = installedView(db);
  return Boolean(
    installed &&
      installed.type === 'view' &&
      installed.sql !== null &&
      sameDefinition(installed.sql, ARCHIVE_INSPECTIONS_VIEW_SQL)
  );
}

interface ReserveColumnDef {
  readonly name: string;
  readonly definition: string;
}

const RESERVE_POLICY_COLUMNS_TO_ADD: readonly ReserveColumnDef[] = [
  { name: 'previous_effort_present', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'applied_model', definition: 'TEXT' },
  { name: 'applied_effort', definition: 'TEXT' },
  { name: 'applied_tier', definition: 'TEXT' },
  { name: 'usage_failure_state', definition: 'TEXT' },
  { name: 'usage_failure_revision', definition: 'INTEGER' },
  { name: 'usage_failure_id', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'usage_failure_reason', definition: 'TEXT' },
  { name: 'usage_failure_resolution_reason', definition: 'TEXT' },
  { name: 'usage_failure_updated_at', definition: 'REAL' },
];

export function migrateReserveStartNotice(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS codex_reserve_start_notices (
        job_id TEXT PRIMARY KEY, target_thread_id TEXT NOT NULL, channel_id INTEGER NOT NULL,
        app_server_generation INTEGER NOT NULL, attempt_count INTEGER NOT NULL,
        content TEXT NOT NULL, created_at REAL NOT NULL DEFAULT(unixepoch())
    );`
  );
}

export function schemaCurrentReserveStartNotice(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*)=7 AS ok FROM pragma_table_info('codex_reserve_start_notices')
        WHERE name IN ('job_id','target_thread_id','channel_id','app_server_generation','attempt_count','content','created_at')`
    )
    .get() as { ok?: unknown } | undefined;
  return Boolean(row && Number(row.ok) === 1);
}

export function migrateReserveTransitionNotice(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS codex_reserve_transition_notices (
            notice_id TEXT PRIMARY KEY,
            target_thread_id TEXT NOT NULL,
            channel_id INTEGER,
            policy_revision INTEGER NOT NULL,
            transition_state TEXT NOT NULL CHECK(transition_state IN ('reserve','ordinary')),
            content TEXT NOT NULL,
            created_at REAL NOT NULL DEFAULT(unixepoch())
        );
        CREATE INDEX IF NOT EXISTS codex_reserve_transition_notices_pending
            ON codex_reserve_transition_notices(created_at, notice_id);`
  );
}

export function schemaCurrentReserveTransitionNotice(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*)=7 AS ok FROM pragma_table_info('codex_reserve_transition_notices')
         WHERE name IN ('notice_id','target_thread_id','channel_id','policy_revision',
                        'transition_state','content','created_at')
         AND EXISTS(SELECT 1 FROM sqlite_schema
                    WHERE type='index' AND name='codex_reserve_transition_notices_pending')`
    )
    .get() as { ok?: unknown } | undefined;
  return Boolean(row && Number(row.ok) === 1);
}

export function migrateReservePolicy(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS codex_reserve_policy (
            thread_id TEXT PRIMARY KEY,
            mode TEXT NOT NULL CHECK(mode IN ('auto','on','off','manual')),
            state TEXT NOT NULL CHECK(state IN ('ordinary','entering','reserve','restoring','held','unknown')),
            account_id TEXT,
            process_id INTEGER,
            generation INTEGER,
            previous_model TEXT,
            previous_effort TEXT,
            previous_effort_present INTEGER NOT NULL DEFAULT 0,
            previous_tier TEXT,
            applied_model TEXT,
            applied_effort TEXT,
            applied_tier TEXT,
            revision INTEGER NOT NULL DEFAULT 0,
            updated_at REAL NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS codex_reserve_policy_recovery
            ON codex_reserve_policy(state, updated_at);`
  );

  const checkStmt = db.prepare(
    "SELECT EXISTS(SELECT 1 FROM pragma_table_info('codex_reserve_policy') WHERE name=?1) AS ok"
  );
  for (const col of RESERVE_POLICY_COLUMNS_TO_ADD) {
    const row = checkStmt.get(col.name) as { ok?: unknown } | undefined;
    const exists = Boolean(row && Number(row.ok) === 1);
    if (!exists) {
      db.exec(
        `ALTER TABLE codex_reserve_policy ADD COLUMN ${col.name} ${col.definition}`
      );
    }
  }

  migrateReserveStartNotice(db);
  migrateReserveTransitionNotice(db);
}

export function schemaCurrentReservePolicy(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM pragma_table_info('codex_reserve_policy')
         WHERE name IN ('thread_id','mode','state','account_id','process_id','generation',
         'previous_model','previous_effort','previous_effort_present','previous_tier',
         'applied_model','applied_effort','applied_tier','revision','updated_at',
         'usage_failure_state','usage_failure_revision','usage_failure_reason',
         'usage_failure_id','usage_failure_resolution_reason','usage_failure_updated_at'))=21
         AND EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='codex_reserve_policy_recovery') AS ok`
    )
    .get() as { ok?: unknown } | undefined;
  const current = Boolean(row && Number(row.ok) === 1);
  return (
    current &&
    schemaCurrentReserveStartNotice(db) &&
    schemaCurrentReserveTransitionNotice(db)
  );
}

export function migrateExecutionHold(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS cdr_execution_holds (
        job_id TEXT PRIMARY KEY, target_thread_id TEXT NOT NULL,
        reason TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at REAL NOT NULL
    );`
  );
}

export function schemaCurrentExecutionHold(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      "SELECT COUNT(*)=5 AS ok FROM pragma_table_info('cdr_execution_holds')"
    )
    .get() as { ok?: unknown } | undefined;
  return Boolean(row && Number(row.ok) === 1);
}

export function migrateFinalRecovery(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS cdr_final_recovery (
        delivery_id TEXT PRIMARY KEY, grant_json TEXT NOT NULL, created_at REAL NOT NULL);`
  );
}

export function schemaCurrentFinalRecovery(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      "SELECT COUNT(*)=3 AS ok FROM pragma_table_info('cdr_final_recovery')"
    )
    .get() as { ok?: unknown } | undefined;
  return Boolean(row && Number(row.ok) === 1);
}

export function migrateServerResponse(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS cdr_server_responses(
        request_key TEXT PRIMARY KEY, runtime_id TEXT NOT NULL, resident_owner TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation>0), target_thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL, job_id TEXT NOT NULL, authority_json TEXT NOT NULL,
        response_sha256 TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('admitted','flushed','not_sent','terminal')),
        created_at REAL NOT NULL, updated_at REAL NOT NULL, terminal_json TEXT);
        CREATE INDEX IF NOT EXISTS cdr_server_response_target
        ON cdr_server_responses(target_thread_id,phase);`
  );
}

export function schemaCurrentServerResponse(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      `SELECT (SELECT count(*) FROM pragma_table_info('cdr_server_responses'))=13
        AND EXISTS(SELECT 1 FROM sqlite_schema WHERE name='cdr_server_response_target') AS ok`
    )
    .get() as { ok?: unknown } | undefined;
  return Boolean(row && Number(row.ok) === 1);
}

export function migrateReserveRetirement(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS cdr_store_retirements (
        name TEXT PRIMARY KEY, evidence_json TEXT NOT NULL, completed_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS cdr_reserve_retirement_evidence (
        thread_id TEXT PRIMARY KEY, policy_json TEXT NOT NULL, retired_at REAL NOT NULL);`
  );
}

export function schemaCurrentReserveRetirement(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*)=2 AS ok FROM sqlite_schema WHERE type='table'
        AND name IN ('cdr_store_retirements','cdr_reserve_retirement_evidence')`
    )
    .get() as { ok?: unknown } | undefined;
  return Boolean(row && Number(row.ok) === 1);
}
