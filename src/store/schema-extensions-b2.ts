import type { DatabaseSync } from 'node:sqlite';

const INGRESS_JOURNAL_SQL = `CREATE TABLE IF NOT EXISTS discord_ingress_journal (
            ingress_id TEXT PRIMARY KEY,
            version INTEGER NOT NULL DEFAULT 1 CHECK(version = 1),
            kind TEXT NOT NULL CHECK(kind IN ('message', 'interaction', 'action')),
            event_id INTEGER,
            application_id INTEGER,
            channel_id INTEGER NOT NULL,
            owner_user_id INTEGER NOT NULL,
            source_message_id INTEGER,
            payload_json TEXT NOT NULL,
            runtime_id TEXT,
            state TEXT NOT NULL CHECK(state IN ('staged','acknowledged','executing','owned','completed','held')),
            phase TEXT NOT NULL,
            target_thread_id TEXT,
            canonical_owner TEXT,
            owner_kind TEXT,
            owner_id TEXT,
            outcome_json TEXT,
            confirmation_delivered INTEGER NOT NULL DEFAULT 0,
            hold_reason TEXT NOT NULL DEFAULT '',
            notice_staged INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
         );
         CREATE UNIQUE INDEX IF NOT EXISTS discord_ingress_event ON discord_ingress_journal(kind,event_id) WHERE event_id IS NOT NULL;
         CREATE INDEX IF NOT EXISTS discord_ingress_owner ON discord_ingress_journal(canonical_owner);
         CREATE TABLE IF NOT EXISTS discord_ingress_owner_receipts (
            owner_key TEXT PRIMARY KEY,
            owner_kind TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            target_thread_id TEXT,
            channel_id INTEGER NOT NULL,
            owner_user_id INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            created_at REAL NOT NULL
         );`;

const STOP_REVISION_SQL = `CREATE TABLE IF NOT EXISTS cdr_stop_clock(
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            revision INTEGER NOT NULL CHECK(revision>=0));
         INSERT OR IGNORE INTO cdr_stop_clock VALUES(1,0);
         CREATE TABLE IF NOT EXISTS cdr_stop_revisions(
            target_thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
            operation_id TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS cdr_stop_revision_receipts(
            operation_id TEXT PRIMARY KEY, target_thread_id TEXT NOT NULL,
            revision INTEGER NOT NULL UNIQUE CHECK(revision>0), scope_json TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS cdr_stop_revision_target
            ON cdr_stop_revision_receipts(target_thread_id,revision);`;

const STOP_CONTROL_SQL = `CREATE TABLE IF NOT EXISTS cdr_stop_controls(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL UNIQUE,
        target_thread_id TEXT NOT NULL,
        resident_owner TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation>0),
        turn_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('accepted','dispatching','acknowledged','unknown','settled')),
        claim_token TEXT, wire_attempt TEXT, wire_id TEXT,
        last_error TEXT NOT NULL DEFAULT '', terminal_json TEXT);
        CREATE INDEX IF NOT EXISTS cdr_stop_pending ON cdr_stop_controls(phase,sequence);
        CREATE INDEX IF NOT EXISTS cdr_stop_target ON cdr_stop_controls(target_thread_id,phase);
        CREATE UNIQUE INDEX IF NOT EXISTS cdr_stop_original_interrupt
        ON cdr_stop_controls(target_thread_id,resident_owner,generation,turn_id)
        WHERE claim_token IS NOT NULL;`;

const INGRESS_CURRENT_SQL = `SELECT COUNT(*) = 2 FROM sqlite_schema WHERE type = 'table'
         AND name IN ('discord_ingress_journal','discord_ingress_owner_receipts')`;

const STOP_REVISION_CURRENT_SQL = `SELECT (SELECT group_concat(name,',') FROM pragma_table_info('cdr_stop_clock'))='singleton,revision'
         AND (SELECT group_concat(name,',') FROM pragma_table_info('cdr_stop_revisions'))='target_thread_id,revision,operation_id'
         AND (SELECT group_concat(name,',') FROM pragma_table_info('cdr_stop_revision_receipts'))='operation_id,target_thread_id,revision,scope_json'
         AND EXISTS(SELECT 1 FROM sqlite_schema WHERE name='cdr_stop_revision_target')`;

const STOP_CONTROL_CURRENT_SQL = `SELECT
        (SELECT COUNT(*) FROM pragma_table_info('cdr_stop_controls'))=13
        AND EXISTS(SELECT 1 FROM sqlite_schema WHERE name='cdr_stop_original_interrupt')
        AND EXISTS(SELECT 1 FROM sqlite_schema WHERE name='cdr_stop_pending')
        AND EXISTS(SELECT 1 FROM sqlite_schema WHERE name='cdr_stop_target')`;

const NEW_REPLY_SQL = `CREATE TABLE IF NOT EXISTS codex_new_first_replies (
            job_id TEXT PRIMARY KEY, ingress_id TEXT NOT NULL UNIQUE,
            identity_json TEXT NOT NULL, turn_id TEXT, accepted_at REAL,
            state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','verified','review_required')),
            version INTEGER NOT NULL DEFAULT 1, scan_json TEXT NOT NULL DEFAULT '{}',
            last_error TEXT NOT NULL DEFAULT '', confirmation_delivered INTEGER NOT NULL DEFAULT 0,
            warning_due INTEGER NOT NULL DEFAULT 0, checked_at REAL NOT NULL DEFAULT 0,
            ack_recovery_allowed INTEGER NOT NULL DEFAULT 0);
         CREATE INDEX IF NOT EXISTS codex_new_first_replies_pending
            ON codex_new_first_replies(checked_at,job_id);`;

const NEW_REPLY_CURRENT_SQL = `SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='codex_new_first_replies')`;

const CANCELLATION_SQL = `CREATE TABLE IF NOT EXISTS codex_request_cancellations (
        job_id TEXT PRIMARY KEY, target_thread_id TEXT NOT NULL, channel_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL, discord_message_id INTEGER, cancelled_at REAL NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS codex_cancelled_message ON codex_request_cancellations(discord_message_id)
        WHERE discord_message_id IS NOT NULL;`;

const CANCELLATION_TABLES = ['codex_turn_queue', 'codex_prompt_intakes'] as const;
const CANCELLATION_OPERATIONS = ['INSERT', 'UPDATE'] as const;

const CANCELLATION_CURRENT_SQL = `SELECT COUNT(*) FROM sqlite_schema WHERE
        (type='table' AND name='codex_request_cancellations') OR
        (type='index' AND name='codex_cancelled_message') OR
        (type='trigger' AND name IN ('cancelled_codex_turn_queue_INSERT','cancelled_codex_turn_queue_UPDATE',
        'cancelled_codex_prompt_intakes_INSERT','cancelled_codex_prompt_intakes_UPDATE'))`;

const MAPPING_CREATION_SQL = `CREATE TABLE IF NOT EXISTS cdr_mirror_thread_creations (
         thread_id TEXT PRIMARY KEY NOT NULL,token TEXT NOT NULL UNIQUE,
         guild_id INTEGER NOT NULL CHECK(guild_id>0),parent_id INTEGER NOT NULL CHECK(parent_id>0),
         expected_parent_id INTEGER,expected_channel_id INTEGER,
         phase TEXT NOT NULL CHECK(phase IN ('attempted','confirmed')),channel_id INTEGER,
         CHECK((expected_parent_id IS NULL AND expected_channel_id IS NULL)
            OR (expected_parent_id IS NOT NULL AND expected_channel_id IS NOT NULL
                AND expected_parent_id>0 AND expected_channel_id>0)),
         CHECK((phase='attempted' AND channel_id IS NULL)
            OR (phase='confirmed' AND channel_id IS NOT NULL AND channel_id>0)));`;

const MAPPING_CREATION_CURRENT_SQL = `SELECT COUNT(*)=8 FROM pragma_table_info('cdr_mirror_thread_creations')
         WHERE name IN ('thread_id','token','guild_id','parent_id','expected_parent_id',
                       'expected_channel_id','phase','channel_id')`;

const CONTAINER_CREATION_SQL = `CREATE TABLE IF NOT EXISTS cdr_mirror_container_creations (
         kind TEXT NOT NULL CHECK(kind IN ('category','project')),scope_key TEXT NOT NULL CHECK(length(scope_key)>0),
         token TEXT NOT NULL UNIQUE,guild_id INTEGER NOT NULL CHECK(guild_id>0),
         parent_id INTEGER,expected_json TEXT NOT NULL,phase TEXT NOT NULL,channel_id INTEGER,
         PRIMARY KEY(kind,scope_key),
         CHECK((kind='category' AND parent_id IS NULL) OR (kind='project' AND parent_id IS NOT NULL AND parent_id>0)),
         CHECK((phase='attempted' AND channel_id IS NULL)
           OR (phase='confirmed' AND channel_id IS NOT NULL AND channel_id>0)
           OR (phase='bound' AND kind='category' AND channel_id IS NOT NULL AND channel_id>0)));`;

const CONTAINER_CREATION_CURRENT_SQL = `SELECT COUNT(*)=8 FROM pragma_table_info('cdr_mirror_container_creations')
         WHERE name IN ('kind','scope_key','token','guild_id','parent_id','expected_json','phase','channel_id')`;

function queryBoolean(db: DatabaseSync, sql: string): boolean {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  if (!row) return false;
  const val = Object.values(row)[0];
  return val === 1 || val === 1n || val === true;
}

function queryCount(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  if (!row) return 0;
  const val = Object.values(row)[0];
  return typeof val === 'number' ? val : typeof val === 'bigint' ? Number(val) : 0;
}

export function migrateIngress(db: DatabaseSync): void {
  db.exec(INGRESS_JOURNAL_SQL);
  db.exec(STOP_REVISION_SQL);
  db.exec(STOP_CONTROL_SQL);
}

export function schemaCurrentIngress(db: DatabaseSync): boolean {
  return (
    queryBoolean(db, INGRESS_CURRENT_SQL) &&
    queryBoolean(db, STOP_REVISION_CURRENT_SQL) &&
    queryBoolean(db, STOP_CONTROL_CURRENT_SQL)
  );
}

export function migrateNewReply(db: DatabaseSync): void {
  db.exec(NEW_REPLY_SQL);
}

export function schemaCurrentNewReply(db: DatabaseSync): boolean {
  return queryBoolean(db, NEW_REPLY_CURRENT_SQL);
}

export function migrateCancellation(db: DatabaseSync): void {
  db.exec(CANCELLATION_SQL);
  for (const table of CANCELLATION_TABLES) {
    for (const operation of CANCELLATION_OPERATIONS) {
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS cancelled_${table}_${operation}
                 BEFORE ${operation} ON ${table}
                 WHEN EXISTS(SELECT 1 FROM codex_request_cancellations c WHERE c.job_id=NEW.job_id
                    OR (NEW.discord_message_id IS NOT NULL AND c.discord_message_id=NEW.discord_message_id))
                 BEGIN SELECT RAISE(ABORT, 'request was cancelled by its original sender; no automatic retry'); END;`,
      );
    }
  }
}

export function schemaCurrentCancellation(db: DatabaseSync): boolean {
  return queryCount(db, CANCELLATION_CURRENT_SQL) === 6;
}

export function migrateMappingCreation(db: DatabaseSync): void {
  db.exec(MAPPING_CREATION_SQL);
}

export function schemaCurrentMappingCreation(db: DatabaseSync): boolean {
  return queryBoolean(db, MAPPING_CREATION_CURRENT_SQL);
}

export function migrateContainerCreation(db: DatabaseSync): void {
  db.exec(CONTAINER_CREATION_SQL);
}

export function schemaCurrentContainerCreation(db: DatabaseSync): boolean {
  return queryBoolean(db, CONTAINER_CREATION_CURRENT_SQL);
}
