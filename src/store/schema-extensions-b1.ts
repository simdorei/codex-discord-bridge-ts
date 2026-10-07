import type { DatabaseSync } from "node:sqlite";

export class StoreIntegrityError extends Error {
  readonly kind = "Integrity";

  constructor(message: string) {
    super(`SQLite integrity check failed: ${message}`);
    this.name = "StoreIntegrityError";
  }
}

function queryBoolean(
  db: DatabaseSync,
  sql: string,
  ...params: readonly (string | number | bigint | null)[]
): boolean {
  const stmt = db.prepare(sql);
  const row = (
    params.length > 0 ? stmt.get(...params) : stmt.get()
  ) as Record<string, unknown> | undefined;
  if (!row) {
    return false;
  }
  const val = Object.values(row)[0];
  return Number(val) === 1;
}

// ---------------------------------------------------------------------------
// 1. Claims (claims/creation.rs)
// ---------------------------------------------------------------------------

export function schemaCurrentClaims(db: DatabaseSync): boolean {
  return queryBoolean(
    db,
    "SELECT EXISTS(SELECT 1 FROM pragma_table_info('busy_choices') WHERE name='require_current_mirror')",
  );
}

export function migrateClaims(db: DatabaseSync): void {
  if (!schemaCurrentClaims(db)) {
    db.exec(
      "ALTER TABLE busy_choices ADD COLUMN require_current_mirror INTEGER CHECK(require_current_mirror IN (0,1))",
    );
  }
}

// ---------------------------------------------------------------------------
// 2. DeliveryReceipt (delivery_receipt.rs)
// ---------------------------------------------------------------------------

const DELIVERY_RECEIPT_COLUMNS: readonly [string, string][] = [
  ["retryable", "INTEGER NOT NULL DEFAULT 0"],
  ["blocked_reason", "TEXT"],
];

export function schemaCurrentDeliveryReceipt(db: DatabaseSync): boolean {
  return queryBoolean(
    db,
    "SELECT COUNT(*)=2 FROM pragma_table_info('codex_delivery_receipts') WHERE name IN ('retryable','blocked_reason')",
  );
}

export function migrateDeliveryReceipt(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS codex_delivery_receipts (\n        receipt_key TEXT PRIMARY KEY, content_hash TEXT NOT NULL, message_id TEXT);",
  );
  for (const [name, definition] of DELIVERY_RECEIPT_COLUMNS) {
    const exists = queryBoolean(
      db,
      "SELECT EXISTS(SELECT 1 FROM pragma_table_info('codex_delivery_receipts') WHERE name=?)",
      name,
    );
    if (!exists) {
      db.exec(
        `ALTER TABLE codex_delivery_receipts ADD COLUMN ${name} ${definition}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3. CommentaryOutbox (commentary_outbox.rs)
// ---------------------------------------------------------------------------

export function schemaCurrentCommentaryOutbox(db: DatabaseSync): boolean {
  return queryBoolean(
    db,
    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table'\n        AND name='codex_commentary_outbox')",
  );
}

export function migrateCommentaryOutbox(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS codex_commentary_outbox (\n        sequence INTEGER PRIMARY KEY AUTOINCREMENT, delivery_key TEXT NOT NULL UNIQUE,\n        job_id TEXT NOT NULL, target_thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,\n        channel_id INTEGER NOT NULL, text TEXT NOT NULL);",
  );
}

// ---------------------------------------------------------------------------
// 4. MirrorContext (mirror/context.rs)
// ---------------------------------------------------------------------------

export function schemaCurrentMirrorContext(db: DatabaseSync): boolean {
  const rows = db
    .prepare("PRAGMA table_info(codex_session_mirror_offsets)")
    .all() as Array<{ name: string }>;
  return rows.some((row) => row.name === "turn_context");
}

export function migrateMirrorContext(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS codex_session_mirror_offsets\n        (codex_thread_id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cursor INTEGER NOT NULL,\n         updated_at REAL NOT NULL, turn_context TEXT)",
  );
  if (!schemaCurrentMirrorContext(db)) {
    db.exec(
      "ALTER TABLE codex_session_mirror_offsets ADD COLUMN turn_context TEXT",
    );
  }
}

// ---------------------------------------------------------------------------
// 5. PromptIntake (prompt_intake/storage.rs)
// ---------------------------------------------------------------------------

const PROMPT_INTAKES_TABLE = "codex_prompt_intakes";
const PROMPT_INTAKES_MESSAGE_INDEX = "codex_prompt_intakes_message_id";
const PROMPT_INTAKES_TARGET_READY_INDEX = "codex_prompt_intakes_target_ready";

const PROMPT_INTAKES_REQUIRED_COLUMNS: readonly string[] = [
  "job_id",
  "target_thread_id",
  "channel_id",
  "owner_user_id",
  "discord_message_id",
  "raw_prompt",
  "auto_queue_when_busy",
  "require_current_mirror",
  "attempt_count",
  "last_error",
  "retry_after",
  "claim_token",
  "claim_expires_at",
  "created_at",
  "updated_at",
];

const PROMPT_INTAKES_OPTIONAL_COLUMNS: readonly [string, string][] = [
  ["target_thread_id", "TEXT NOT NULL DEFAULT ''"],
  ["channel_id", "INTEGER NOT NULL DEFAULT 0"],
  ["owner_user_id", "INTEGER"],
  ["discord_message_id", "INTEGER"],
  ["raw_prompt", "TEXT NOT NULL DEFAULT ''"],
  ["auto_queue_when_busy", "INTEGER NOT NULL DEFAULT 0"],
  ["require_current_mirror", "INTEGER NOT NULL DEFAULT 0"],
  ["attempt_count", "INTEGER NOT NULL DEFAULT 0"],
  ["last_error", "TEXT NOT NULL DEFAULT ''"],
  ["retry_after", "REAL NOT NULL DEFAULT 0"],
  ["claim_token", "TEXT"],
  ["claim_expires_at", "REAL NOT NULL DEFAULT 0"],
  ["created_at", "REAL NOT NULL DEFAULT 0"],
  ["updated_at", "REAL NOT NULL DEFAULT 0"],
];

function promptIntakeColumns(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare("PRAGMA table_info(codex_prompt_intakes)")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function addMissingPromptIntakeColumns(db: DatabaseSync): void {
  const cols = promptIntakeColumns(db);
  if (!cols.has("job_id")) {
    throw new StoreIntegrityError(
      "codex_prompt_intakes is missing its job_id primary identity",
    );
  }
  for (const [name, definition] of PROMPT_INTAKES_OPTIONAL_COLUMNS) {
    if (!cols.has(name)) {
      db.exec(
        `ALTER TABLE ${PROMPT_INTAKES_TABLE} ADD COLUMN ${name} ${definition}`,
      );
    }
  }
}

export function schemaCurrentPromptIntake(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      "SELECT COUNT(*) FROM sqlite_schema WHERE (type = 'table' AND name = ?) OR (type = 'index' AND name IN (?, ?))",
    )
    .get(
      PROMPT_INTAKES_TABLE,
      PROMPT_INTAKES_MESSAGE_INDEX,
      PROMPT_INTAKES_TARGET_READY_INDEX,
    ) as Record<string, unknown> | undefined;
  if (!row) {
    return false;
  }
  const count = Number(Object.values(row)[0]);
  if (count !== 3) {
    return false;
  }
  const cols = promptIntakeColumns(db);
  return PROMPT_INTAKES_REQUIRED_COLUMNS.every((col) => cols.has(col));
}

export function migratePromptIntake(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS codex_prompt_intakes (job_id TEXT PRIMARY KEY, target_thread_id TEXT NOT NULL, channel_id INTEGER NOT NULL, owner_user_id INTEGER, discord_message_id INTEGER, raw_prompt TEXT NOT NULL, auto_queue_when_busy INTEGER NOT NULL, require_current_mirror INTEGER NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', retry_after REAL NOT NULL DEFAULT 0, claim_token TEXT, claim_expires_at REAL NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL, CHECK (auto_queue_when_busy IN (0, 1)), CHECK (require_current_mirror IN (0, 1)))",
  );
  addMissingPromptIntakeColumns(db);
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS codex_prompt_intakes_message_id ON codex_prompt_intakes(discord_message_id) WHERE discord_message_id IS NOT NULL",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS codex_prompt_intakes_target_ready ON codex_prompt_intakes(target_thread_id, retry_after, claim_expires_at, created_at, job_id)",
  );
}

// ---------------------------------------------------------------------------
// 6. DeadGeneration (dead_generation/schema.rs)
// ---------------------------------------------------------------------------

export function schemaCurrentDeadGeneration(db: DatabaseSync): boolean {
  return queryBoolean(
    db,
    "SELECT COUNT(*) = 3 FROM sqlite_schema WHERE type = 'table' AND name IN ('codex_app_server_runtime', 'codex_dead_generation_incidents', 'codex_dead_generation_holds')",
  );
}

export function migrateDeadGeneration(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS codex_app_server_runtime (\n            singleton INTEGER PRIMARY KEY CHECK(singleton = 1), runtime_id TEXT NOT NULL);\n         CREATE TABLE IF NOT EXISTS codex_dead_generation_incidents (\n            runtime_id TEXT NOT NULL, generation INTEGER NOT NULL,\n            snapshot_json TEXT NOT NULL, queue_jobs_json TEXT NOT NULL,\n            created_at REAL NOT NULL, PRIMARY KEY(runtime_id, generation));\n         CREATE TABLE IF NOT EXISTS codex_dead_generation_holds (\n            target_thread_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL,\n            generation INTEGER NOT NULL, created_at REAL NOT NULL);",
  );
}
