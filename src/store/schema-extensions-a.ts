import type { DatabaseSync } from "node:sqlite";

function decodeSqliteBoolean(row: Record<string, unknown> | undefined): boolean {
  if (row === undefined || row === null) {
    return false;
  }
  const values = Object.values(row);
  if (values.length === 0) {
    return false;
  }
  const val = values[0];
  if (typeof val === "number") {
    return val === 1;
  }
  if (typeof val === "bigint") {
    return val === 1n;
  }
  if (typeof val === "boolean") {
    return val;
  }
  return false;
}

// ---------------------------------------------------------------------------
// goal_progress
// ---------------------------------------------------------------------------

export function migrateGoalProgress(c: DatabaseSync): void {
  c.exec(
    `CREATE TABLE IF NOT EXISTS codex_goal_progress (
        thread TEXT NOT NULL, turn TEXT NOT NULL, channel INTEGER NOT NULL,
        content TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(thread,turn));`,
  );
  const row = c
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM pragma_table_info('codex_goal_progress')
        WHERE name='job_id')`,
    )
    .get() as Record<string, unknown> | undefined;
  if (!decodeSqliteBoolean(row)) {
    c.exec("ALTER TABLE codex_goal_progress ADD COLUMN job_id TEXT;");
  }
}

export function schemaCurrentGoalProgress(c: DatabaseSync): boolean {
  const row = c
    .prepare(
      "SELECT EXISTS(SELECT 1 FROM pragma_table_info('codex_goal_progress') WHERE name='job_id')",
    )
    .get() as Record<string, unknown> | undefined;
  return decodeSqliteBoolean(row);
}

// ---------------------------------------------------------------------------
// observed_completion
// ---------------------------------------------------------------------------

function hasResidentOwner(connection: DatabaseSync): boolean {
  const row = connection
    .prepare(
      "SELECT EXISTS(SELECT 1 FROM pragma_table_info('codex_observed_completions') WHERE name='resident_owner')",
    )
    .get() as Record<string, unknown> | undefined;
  return decodeSqliteBoolean(row);
}

export function migrateObservedCompletion(connection: DatabaseSync): void {
  connection.exec(
    `CREATE TABLE IF NOT EXISTS codex_observed_completions (
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, generation INTEGER NOT NULL,
        payload TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(thread_id, turn_id));`,
  );
  if (!hasResidentOwner(connection)) {
    connection.exec(
      "ALTER TABLE codex_observed_completions ADD COLUMN resident_owner TEXT",
    );
  }
}

export function schemaCurrentObservedCompletion(connection: DatabaseSync): boolean {
  const tableRow = connection
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table'
        AND name='codex_observed_completions')`,
    )
    .get() as Record<string, unknown> | undefined;
  return decodeSqliteBoolean(tableRow) && hasResidentOwner(connection);
}

// ---------------------------------------------------------------------------
// observed_final_answer
// ---------------------------------------------------------------------------

export function migrateObservedFinalAnswer(connection: DatabaseSync): void {
  connection.exec(
    `CREATE TABLE IF NOT EXISTS codex_observed_final_answers (
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, generation INTEGER NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY(thread_id, turn_id, generation));`,
  );
}

export function schemaCurrentObservedFinalAnswer(connection: DatabaseSync): boolean {
  const row = connection
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table'
        AND name='codex_observed_final_answers')`,
    )
    .get() as Record<string, unknown> | undefined;
  return decodeSqliteBoolean(row);
}

// ---------------------------------------------------------------------------
// async_question
// ---------------------------------------------------------------------------

const CANDIDATE_COLUMNS = [
  "candidate_generation",
  "candidate_execution_generation",
  "candidate_attempt_count",
] as const;

function hasPreparation(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      "SELECT EXISTS(SELECT 1 FROM pragma_table_info('cdr_async_questions') WHERE name='preparation_json')",
    )
    .get() as Record<string, unknown> | undefined;
  return decodeSqliteBoolean(row);
}

export function migrateAsyncQuestion(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cdr_async_question_inbox (
        id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL, generation INTEGER NOT NULL,
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
        candidate_job_id TEXT NOT NULL, candidate_channel_id INTEGER NOT NULL,
        candidate_owner_id INTEGER NOT NULL, body TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'waiting', created_at REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS cdr_async_question_inbox_pending ON cdr_async_question_inbox(runtime_id,generation,state);`);
  const stmt = db.prepare(
    "SELECT EXISTS(SELECT 1 FROM pragma_table_info('cdr_async_question_inbox') WHERE name=?)",
  );
  for (const column of CANDIDATE_COLUMNS) {
    const row = stmt.get(column) as Record<string, unknown> | undefined;
    const present = decodeSqliteBoolean(row);
    if (!present) {
      db.exec(`ALTER TABLE cdr_async_question_inbox ADD COLUMN ${column} INTEGER`);
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS cdr_async_questions (
        id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL, generation INTEGER NOT NULL,
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
        origin_job_id TEXT NOT NULL, channel_id INTEGER NOT NULL, owner_user_id INTEGER NOT NULL,
        body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'observed', message_id TEXT, chosen INTEGER,
        dispatch_mode TEXT, reply_job_id TEXT, accepted_turn_id TEXT, error TEXT NOT NULL DEFAULT '',
        owner_confirmed INTEGER NOT NULL DEFAULT 0,
        created_at REAL NOT NULL, updated_at REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS cdr_async_question_pending ON cdr_async_questions(runtime_id,state);
        CREATE UNIQUE INDEX IF NOT EXISTS cdr_async_question_reply_job ON cdr_async_questions(reply_job_id) WHERE reply_job_id IS NOT NULL;`);
  if (!hasPreparation(db)) {
    db.exec("ALTER TABLE cdr_async_questions ADD COLUMN preparation_json TEXT");
  }
}

export function schemaCurrentAsyncQuestion(db: DatabaseSync): boolean {
  const tableCountRow = db
    .prepare(
      "SELECT COUNT(*)=2 FROM sqlite_schema WHERE type='table' AND name IN ('cdr_async_questions','cdr_async_question_inbox')",
    )
    .get() as Record<string, unknown> | undefined;
  if (!decodeSqliteBoolean(tableCountRow)) {
    return false;
  }
  if (!hasPreparation(db)) {
    return false;
  }
  const colCountRow = db
    .prepare(
      "SELECT COUNT(*)=3 FROM pragma_table_info('cdr_async_question_inbox') WHERE name IN ('candidate_generation','candidate_execution_generation','candidate_attempt_count')",
    )
    .get() as Record<string, unknown> | undefined;
  return decodeSqliteBoolean(colCountRow);
}

// ---------------------------------------------------------------------------
// idle_release
// ---------------------------------------------------------------------------

export function migrateIdleRelease(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS cdr_idle_release (
        intent_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, generation INTEGER NOT NULL,
        thread_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, job_id TEXT NOT NULL,
        revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN
        ('Candidate','Dispatching','AwaitUnload','Resubscribing','Unknown','Settled')),
        detail TEXT NOT NULL DEFAULT '');`,
  );
}

export function schemaCurrentIdleRelease(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='cdr_idle_release' AND type='table')",
    )
    .get() as Record<string, unknown> | undefined;
  return decodeSqliteBoolean(row);
}

// ---------------------------------------------------------------------------
// observation_gap
// ---------------------------------------------------------------------------

export function migrateObservationGap(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cdr_observation_streams (
        owner_id TEXT NOT NULL,generation INTEGER NOT NULL,active INTEGER NOT NULL,
        seen_seq INTEGER NOT NULL DEFAULT 0,scan_after INTEGER NOT NULL DEFAULT 0,
        cycle_upper INTEGER NOT NULL DEFAULT 0,unsealed INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(owner_id,generation));
        CREATE TABLE IF NOT EXISTS cdr_observation_gaps (
        gap_id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id TEXT NOT NULL,generation INTEGER NOT NULL,
        first_seq INTEGER NOT NULL,last_seq INTEGER NOT NULL,scan_cursor INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL CHECK(state IN ('Open','Unresolved','Verified')),
        verified_json TEXT NOT NULL DEFAULT '[]',detail TEXT NOT NULL DEFAULT '',
        CHECK(first_seq>=0 AND last_seq>=first_seq AND scan_cursor>=first_seq-1 AND scan_cursor<=last_seq));
        CREATE INDEX IF NOT EXISTS cdr_observation_gap_scope ON cdr_observation_gaps(owner_id,generation,gap_id);
        CREATE UNIQUE INDEX IF NOT EXISTS cdr_observation_gap_unknown ON cdr_observation_gaps(owner_id,generation) WHERE first_seq=0;`);
}

export function schemaCurrentObservationGap(db: DatabaseSync): boolean {
  const tableCountRow = db
    .prepare(
      `SELECT COUNT(*)=2 FROM sqlite_schema WHERE type='table'
        AND name IN ('cdr_observation_streams','cdr_observation_gaps')`,
    )
    .get() as Record<string, unknown> | undefined;
  if (!decodeSqliteBoolean(tableCountRow)) {
    return false;
  }
  const colCountRow = db
    .prepare(
      `SELECT COUNT(*)=9 FROM pragma_table_info('cdr_observation_gaps')
        WHERE name IN ('gap_id','owner_id','generation','first_seq','last_seq','scan_cursor','revision','state','verified_json')`,
    )
    .get() as Record<string, unknown> | undefined;
  return decodeSqliteBoolean(colCountRow);
}

// ---------------------------------------------------------------------------
// mutation_attempt
// ---------------------------------------------------------------------------

export function migrateMutationAttempt(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS codex_mutation_runtime(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), runtime_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS codex_mutation_attempts(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL UNIQUE,
        runtime_id TEXT NOT NULL, owner_id TEXT NOT NULL, generation INTEGER NOT NULL,
        wire_id TEXT NOT NULL, method TEXT NOT NULL, target_thread_id TEXT,
        scoped INTEGER NOT NULL CHECK(scoped IN (0,1)),
        request_sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared','reply_ok','reply_error','not_sent')),
        created_at REAL NOT NULL, updated_at REAL NOT NULL,
        CHECK(scoped=0 OR length(target_thread_id)>0));
        CREATE UNIQUE INDEX IF NOT EXISTS codex_mutation_prepared_target
        ON codex_mutation_attempts(target_thread_id) WHERE scoped=1 AND state='prepared';
        CREATE INDEX IF NOT EXISTS codex_mutation_prepared
        ON codex_mutation_attempts(state,scoped,target_thread_id);`);
}

export function schemaCurrentMutationAttempt(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      `SELECT
        EXISTS(SELECT 1 FROM pragma_table_info('codex_mutation_attempts') WHERE name='request_sha256')
        AND EXISTS(SELECT 1 FROM pragma_table_info('codex_mutation_runtime') WHERE name='runtime_id')
        AND EXISTS(SELECT 1 FROM sqlite_schema WHERE name='codex_mutation_prepared_target')`,
    )
    .get() as Record<string, unknown> | undefined;
  return decodeSqliteBoolean(row);
}

// ---------------------------------------------------------------------------
// control_binding
// ---------------------------------------------------------------------------

export function migrateControlBinding(connection: DatabaseSync): void {
  connection.exec(
    `CREATE TABLE IF NOT EXISTS codex_busy_control_bindings (
        choice_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, job_id TEXT);
        CREATE TRIGGER IF NOT EXISTS codex_bind_preparing_control
        AFTER UPDATE OF turn_id ON codex_turn_queue
        WHEN OLD.turn_id IS NULL AND NEW.turn_id IS NOT NULL
        BEGIN
          UPDATE codex_busy_control_bindings SET turn_id=NEW.turn_id
          WHERE job_id=NEW.job_id AND thread_id=NEW.target_thread_id AND turn_id IS NULL;
        END;`,
  );
}

export function schemaCurrentControlBinding(connection: DatabaseSync): boolean {
  const row = connection
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table'
        AND name='codex_busy_control_bindings') AND EXISTS(SELECT 1 FROM sqlite_schema
        WHERE type='trigger' AND name='codex_bind_preparing_control')`,
    )
    .get() as Record<string, unknown> | undefined;
  return decodeSqliteBoolean(row);
}
