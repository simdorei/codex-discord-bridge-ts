import type { DatabaseSync } from "node:sqlite";

import {
  migrateAsyncResolution,
  schemaCurrentAsyncResolution,
} from "./schema-async-resolution.ts";
import {
  migrateAbandonment,
  schemaCurrentAbandonment,
} from "./schema-abandonment.ts";
import {
  migrateAdmissionOrder,
  schemaCurrentAdmissionOrder,
} from "./schema-admission-order.ts";
import {
  migratePublicationConsent,
  schemaCurrentPublicationConsent,
} from "./schema-publication-consent.ts";
import {
  migrateAsyncQuestion,
  migrateControlBinding,
  migrateGoalProgress,
  migrateIdleRelease,
  migrateMutationAttempt,
  migrateObservationGap,
  migrateObservedCompletion,
  migrateObservedFinalAnswer,
  schemaCurrentAsyncQuestion,
  schemaCurrentControlBinding,
  schemaCurrentGoalProgress,
  schemaCurrentIdleRelease,
  schemaCurrentMutationAttempt,
  schemaCurrentObservationGap,
  schemaCurrentObservedCompletion,
  schemaCurrentObservedFinalAnswer,
} from "./schema-extensions-a.ts";
import {
  migrateClaims,
  migrateCommentaryOutbox,
  migrateDeadGeneration,
  migrateDeliveryReceipt,
  migrateMirrorContext,
  migratePromptIntake,
  schemaCurrentClaims,
  schemaCurrentCommentaryOutbox,
  schemaCurrentDeadGeneration,
  schemaCurrentDeliveryReceipt,
  schemaCurrentMirrorContext,
  schemaCurrentPromptIntake,
} from "./schema-extensions-b1.ts";
import {
  migrateCancellation,
  migrateContainerCreation,
  migrateIngress,
  migrateMappingCreation,
  migrateNewReply,
  schemaCurrentCancellation,
  schemaCurrentContainerCreation,
  schemaCurrentIngress,
  schemaCurrentMappingCreation,
  schemaCurrentNewReply,
} from "./schema-extensions-b2.ts";
import {
  migrateRoomCleanup,
  schemaCurrentRoomCleanup,
} from "./schema-extensions-b3.ts";
import {
  migrateArchiveFence,
  migrateExecutionHold,
  migrateFinalRecovery,
  migrateReservePolicy,
  migrateReserveRetirement,
  migrateServerResponse,
  schemaCurrentArchiveFence,
  schemaCurrentExecutionHold,
  schemaCurrentFinalRecovery,
  schemaCurrentReservePolicy,
  schemaCurrentReserveRetirement,
  schemaCurrentServerResponse,
} from "./schema-extensions-c.ts";

export const LATEST_STORE_SCHEMA_VERSION = 2n;

const MIN_I64 = -9223372036854775808n;
const MAX_I64 = 9223372036854775807n;

export class StoreIntegrityError extends Error {
  readonly kind = "Integrity" as const;
  readonly result: string;

  constructor(result: string) {
    super(`SQLite integrity check failed: ${result}`);
    this.name = "StoreIntegrityError";
    this.result = result;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UnsupportedVersionError extends Error {
  readonly kind = "UnsupportedVersion" as const;
  readonly found: bigint;
  readonly supported: bigint;

  constructor(found: bigint, supported: bigint) {
    super(`store schema version ${found} is newer than supported version ${supported}`);
    this.name = "UnsupportedVersionError";
    this.found = found;
    this.supported = supported;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const V1_SCHEMA: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS mirror_projects (project_key TEXT PRIMARY KEY, project_name TEXT NOT NULL, discord_channel_id INTEGER NOT NULL, updated_at REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS mirror_threads (codex_thread_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, thread_title TEXT NOT NULL, discord_channel_id INTEGER NOT NULL, discord_thread_id INTEGER NOT NULL, updated_at REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS session_mirror_details (codex_thread_id TEXT PRIMARY KEY, detail_mode TEXT NOT NULL CHECK(detail_mode IN ('send', 'all')))",
  "CREATE TABLE IF NOT EXISTS busy_choices (choice_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, channel_id INTEGER NOT NULL, target_thread_id TEXT, prompt TEXT NOT NULL, allow_steer INTEGER NOT NULL, created_at REAL NOT NULL, expires_at REAL NOT NULL, claimed_at REAL)",
  "CREATE TABLE IF NOT EXISTS persistent_component_claims (claim_key TEXT PRIMARY KEY, created_at REAL NOT NULL, expires_at REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS discord_processed_messages (message_id INTEGER PRIMARY KEY, seen_at REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS codex_session_mirror_offsets (codex_thread_id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cursor INTEGER NOT NULL, updated_at REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS codex_session_mirror_events (event_digest TEXT PRIMARY KEY, codex_thread_id TEXT NOT NULL, created_at REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS codex_turn_queue (job_id TEXT PRIMARY KEY, target_thread_id TEXT NOT NULL, channel_id INTEGER NOT NULL, owner_user_id INTEGER, discord_message_id INTEGER, prompt TEXT NOT NULL, queued INTEGER NOT NULL, ack_sent INTEGER NOT NULL, state TEXT NOT NULL, attempt_count INTEGER NOT NULL, turn_id TEXT, baseline_turn_ids TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS codex_turn_queue_message_id ON codex_turn_queue(discord_message_id) WHERE discord_message_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS codex_turn_queue_target_order ON codex_turn_queue(target_thread_id, created_at, job_id)",
];

function decodeBool(value: unknown): boolean {
  return value === 1 || value === 1n;
}

function getTableColumns(db: DatabaseSync, tableName: string): string[] {
  const statement = db.prepare(`PRAGMA table_info(${tableName})`);
  const rows = statement.all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    if (typeof row.name !== "string") {
      throw new TypeError(`Invalid column name type: ${typeof row.name}`);
    }
    return row.name;
  });
}

function migrateGoalWaiting(db: DatabaseSync): void {
  const columns = getTableColumns(db, "codex_turn_queue");
  if (!columns.includes("goal_waiting")) {
    db.exec(
      "ALTER TABLE codex_turn_queue ADD COLUMN goal_waiting INTEGER NOT NULL DEFAULT 0",
    );
  }
}

function migrateDeliveryOutbox(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS codex_delivery_outbox (" +
      "delivery_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, " +
      "target_thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, " +
      "channel_id INTEGER NOT NULL, content TEXT NOT NULL, " +
      "attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', " +
      "created_at REAL NOT NULL, updated_at REAL NOT NULL" +
    ")",
  );
}

function migrateQueueGeneration(db: DatabaseSync): void {
  const columns = getTableColumns(db, "codex_turn_queue");
  if (!columns.includes("app_server_generation")) {
    db.exec(
      "ALTER TABLE codex_turn_queue ADD COLUMN app_server_generation INTEGER NOT NULL DEFAULT 0",
    );
  }
}

function migrateQueueExecutionGeneration(db: DatabaseSync): void {
  const columns = getTableColumns(db, "codex_turn_queue");
  if (!columns.includes("execution_generation")) {
    db.exec(
      "ALTER TABLE codex_turn_queue ADD COLUMN execution_generation INTEGER",
    );
  }
}

function migrateTurnObservationGeneration(db: DatabaseSync): void {
  const statement = db.prepare(
    "SELECT EXISTS(SELECT 1 FROM pragma_table_info('codex_turn_queue') WHERE name='turn_observation_generation')",
  );
  const row = statement.get() as Record<string, unknown> | undefined;
  const present = row ? decodeBool(Object.values(row)[0]) : false;
  if (!present) {
    db.exec(
      "ALTER TABLE codex_turn_queue ADD COLUMN turn_observation_generation INTEGER;",
    );
  }
}

export function schemaVersion(db: DatabaseSync): bigint {
  const statement = db.prepare("PRAGMA user_version");
  statement.setReadBigInts(true);
  const row = statement.get() as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error("Failed to query PRAGMA user_version");
  }
  const rawValue = Object.values(row)[0];
  if (typeof rawValue !== "bigint") {
    throw new TypeError(`Invalid user_version scalar type: ${typeof rawValue}`);
  }

  if (rawValue < MIN_I64 || rawValue > MAX_I64) {
    throw new RangeError(`user_version out of i64 range: ${rawValue}`);
  }
  return rawValue;
}

export function assertStoreIntegrity(db: DatabaseSync): void {
  const statement = db.prepare("PRAGMA integrity_check");
  const row = statement.get() as Record<string, unknown> | undefined;
  const result = row ? Object.values(row)[0] : undefined;
  if (typeof result !== "string") {
    throw new TypeError(`Invalid integrity_check result type: ${typeof result}`);
  }
  if (result.toLowerCase() === "ok") {
    return;
  }
  throw new StoreIntegrityError(result);
}

export function migrateSchemaVersion(db: DatabaseSync, version: bigint): void {
  if (version === 1n) {
    for (const statement of V1_SCHEMA) {
      db.exec(statement);
    }
    return;
  }
  if (version === 2n) {
    migrateQueueGeneration(db);
    return;
  }
  throw new UnsupportedVersionError(version, LATEST_STORE_SCHEMA_VERSION);
}

export function migrateSchemaExtensions(db: DatabaseSync): void {
  for (const statement of V1_SCHEMA) {
    db.exec(statement);
  }
  migrateGoalProgress(db);
  migrateObservedCompletion(db);
  migrateObservedFinalAnswer(db);
  migrateAsyncQuestion(db);
  migrateIdleRelease(db);
  migrateObservationGap(db);
  migrateMutationAttempt(db);
  migrateControlBinding(db);
  migrateClaims(db);
  migrateDeliveryReceipt(db);
  migrateCommentaryOutbox(db);
  migrateMirrorContext(db);
  migrateDeliveryOutbox(db);
  migrateGoalWaiting(db);
  migrateQueueExecutionGeneration(db);
  migrateTurnObservationGeneration(db);
  migratePromptIntake(db);
  migrateDeadGeneration(db);
  migrateIngress(db);
  migrateNewReply(db);
  migrateCancellation(db);
  migrateRoomCleanup(db);
  migrateMappingCreation(db);
  migrateContainerCreation(db);
  migrateArchiveFence(db);
  migrateReservePolicy(db);
  migrateExecutionHold(db);
  migrateFinalRecovery(db);
  migrateAsyncResolution(db);
  migratePublicationConsent(db);
  migrateAbandonment(db);
  migrateAdmissionOrder(db);
  migrateServerResponse(db);
  migrateReserveRetirement(db);
}

export function schemaExtensionsCurrent(db: DatabaseSync): boolean {
  const outboxStatement = db.prepare(
    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'codex_delivery_outbox')",
  );
  const outboxRow = outboxStatement.get() as Record<string, unknown> | undefined;
  const hasOutbox = outboxRow ? decodeBool(Object.values(outboxRow)[0]) : false;
  if (!hasOutbox) {
    return false;
  }

  const columns = getTableColumns(db, "codex_turn_queue");
  if (!columns.includes("goal_waiting")) {
    return false;
  }
  if (!columns.includes("execution_generation")) {
    return false;
  }
  if (!columns.includes("turn_observation_generation")) {
    return false;
  }

  return (
    schemaCurrentObservedCompletion(db) &&
    schemaCurrentObservedFinalAnswer(db) &&
    schemaCurrentAsyncQuestion(db) &&
    schemaCurrentIdleRelease(db) &&
    schemaCurrentObservationGap(db) &&
    schemaCurrentMutationAttempt(db) &&
    schemaCurrentGoalProgress(db) &&
    schemaCurrentControlBinding(db) &&
    schemaCurrentClaims(db) &&
    schemaCurrentDeliveryReceipt(db) &&
    schemaCurrentCommentaryOutbox(db) &&
    schemaCurrentPromptIntake(db) &&
    schemaCurrentDeadGeneration(db) &&
    schemaCurrentIngress(db) &&
    schemaCurrentNewReply(db) &&
    schemaCurrentCancellation(db) &&
    schemaCurrentRoomCleanup(db) &&
    schemaCurrentMappingCreation(db) &&
    schemaCurrentContainerCreation(db) &&
    schemaCurrentMirrorContext(db) &&
    schemaCurrentArchiveFence(db) &&
    schemaCurrentReservePolicy(db) &&
    schemaCurrentExecutionHold(db) &&
    schemaCurrentFinalRecovery(db) &&
    schemaCurrentAsyncResolution(db) &&
    schemaCurrentPublicationConsent(db) &&
    schemaCurrentAbandonment(db) &&
    schemaCurrentAdmissionOrder(db) &&
    schemaCurrentServerResponse(db) &&
    schemaCurrentReserveRetirement(db)
  );
}
