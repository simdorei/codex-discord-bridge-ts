import { textDecoderFor, decodeTextField, decodeI64, decodeOptionalI64, decodeBool, decodeTimestamp } from "./sqlite-values.ts";
import type { DatabaseSync } from "node:sqlite";
import { types, isDeepStrictEqual } from "node:util";
import { serializeSerdeValue } from "../core/serde-json.ts";
import { parseSerdeValue } from "../core/serde-json-parse.ts";
import { I64_MAX, I64_MIN } from "../protocol/ids.ts";
import { openInitialized } from "./owned-driver.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";

export type QueueJobState = "Pending" | "Starting" | "Running" | "Quarantined";

export interface StoredQueueJob {
  jobId: string;
  targetThreadId: string;
  channelId: bigint;
  ownerUserId: bigint | null;
  discordMessageId: bigint | null;
  appServerGeneration: bigint;
  executionGeneration: bigint | null;
  turnObservationGeneration: bigint | null;
  goalWaiting: boolean;
  prompt: string;
  queued: boolean;
  ackSent: boolean;
  state: QueueJobState;
  attemptCount: bigint;
  turnId: string | null;
  baselineTurnIds: string[];
  lastError: string;
  createdAt: number;
  updatedAt: number;
}

export class QueueJobNotFoundError extends Error {
  readonly kind = "QueueJobNotFound" as const;

  constructor(jobId: string) {
    super(`durable queue job not found: ${jobId}`);
    this.name = "QueueJobNotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidQueueStateError extends Error {
  readonly kind = "InvalidQueueState" as const;

  constructor(state: string) {
    super(`invalid durable queue state: ${state}`);
    this.name = "InvalidQueueStateError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export { StoreIntegrityError };

export const QUARANTINED_TURN_PREFIX = "cdr-quarantined:";
export const QUARANTINED_ERROR_PREFIX = "[cdr-rust:app-server-fork-quarantine:v1] ";

export const COLUMNS =
  "job_id, target_thread_id, channel_id, owner_user_id, " +
  "discord_message_id, app_server_generation, execution_generation, prompt, queued, ack_sent, state, " +
  "attempt_count, turn_id, baseline_turn_ids, last_error, created_at, updated_at, goal_waiting, turn_observation_generation";

const SELECT_FIELDS =
  `${COLUMNS}, ` +
  `CAST(job_id AS BLOB) AS _blob_job_id, ` +
  `CAST(target_thread_id AS BLOB) AS _blob_target_thread_id, ` +
  `CAST(prompt AS BLOB) AS _blob_prompt, ` +
  `CAST(state AS BLOB) AS _blob_state, ` +
  `CAST(turn_id AS BLOB) AS _blob_turn_id, ` +
  `CAST(baseline_turn_ids AS BLOB) AS _blob_baseline_turn_ids, ` +
  `CAST(last_error AS BLOB) AS _blob_last_error, ` +
  `(SELECT encoding FROM pragma_encoding) AS _text_encoding`;

function isWellFormedString(s: string): boolean {
  if (typeof (s as unknown as { isWellFormed?: () => boolean }).isWellFormed === "function") {
    return (s as unknown as { isWellFormed: () => boolean }).isWellFormed();
  }
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= s.length) return false;
      const next = s.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function isQuarantineEncoding(
  rawState: string,
  turn: string | null,
  lastError: string,
): boolean {
  return (
    rawState === "running" &&
    turn !== null &&
    turn.startsWith(QUARANTINED_TURN_PREFIX) &&
    lastError.startsWith(QUARANTINED_ERROR_PREFIX)
  );
}

export function queueJobStateAsString(state: QueueJobState): string {
  switch (state) {
    case "Pending":
      return "pending";
    case "Starting":
      return "starting";
    case "Running":
      return "running";
    case "Quarantined":
      return "quarantined";
    default: {
      const _exhaustive: never = state;
      throw new InvalidQueueStateError(String(_exhaustive));
    }
  }
}

export function completionEvidenceGeneration(job: StoredQueueJob): bigint {
  return job.turnObservationGeneration ?? job.appServerGeneration;
}

function decodeBaselineTurnIds(rawJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = parseSerdeValue<unknown>(rawJson);
  } catch (err) {
    throw new StoreIntegrityError(
      `Failed to parse baseline_turn_ids JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const result: string[] = [];
  for (const item of parsed) {
    if (typeof item === "string") {
      result.push(item);
    } else {
      result.push(serializeSerdeValue(item));
    }
  }
  return result;
}

function decodeRow(row: Record<string, unknown>): StoredQueueJob {
  const decoder = textDecoderFor(row._text_encoding);
  const jobId = decodeTextField(row.job_id, row._blob_job_id, "job_id", false, decoder)!;
  const targetThreadId = decodeTextField(row.target_thread_id, row._blob_target_thread_id, "target_thread_id", false, decoder)!;
  const channelId = decodeI64(row.channel_id, "channel_id");
  const ownerUserId = decodeOptionalI64(row.owner_user_id, "owner_user_id");
  const discordMessageId = decodeOptionalI64(row.discord_message_id, "discord_message_id");
  const appServerGeneration = decodeI64(row.app_server_generation, "app_server_generation");
  const executionGeneration = decodeOptionalI64(row.execution_generation, "execution_generation");
  const prompt = decodeTextField(row.prompt, row._blob_prompt, "prompt", false, decoder)!;
  const queued = decodeBool(row.queued, "queued");
  const ackSent = decodeBool(row.ack_sent, "ack_sent");
  const rawState = decodeTextField(row.state, row._blob_state, "state", false, decoder)!;
  const attemptCount = decodeI64(row.attempt_count, "attempt_count");
  const turnId = decodeTextField(row.turn_id, row._blob_turn_id, "turn_id", true, decoder);
  const rawBaselineTurnIds = decodeTextField(row.baseline_turn_ids, row._blob_baseline_turn_ids, "baseline_turn_ids", false, decoder)!;
  const lastError = decodeTextField(row.last_error, row._blob_last_error, "last_error", false, decoder)!;
  const createdAt = decodeTimestamp(row.created_at, "created_at");
  const updatedAt = decodeTimestamp(row.updated_at, "updated_at");
  const goalWaiting = decodeBool(row.goal_waiting, "goal_waiting");
  const turnObservationGeneration = decodeOptionalI64(row.turn_observation_generation, "turn_observation_generation");

  let state: QueueJobState;
  if (rawState === "pending") {
    state = "Pending";
  } else if (rawState === "starting") {
    state = "Starting";
  } else if (rawState === "running") {
    if (isQuarantineEncoding(rawState, turnId, lastError)) {
      state = "Quarantined";
    } else {
      state = "Running";
    }
  } else {
    throw new InvalidQueueStateError(rawState);
  }

  const baselineTurnIds = decodeBaselineTurnIds(rawBaselineTurnIds);

  return {
    jobId,
    targetThreadId,
    channelId,
    ownerUserId,
    discordMessageId,
    appServerGeneration,
    executionGeneration,
    turnObservationGeneration,
    goalWaiting,
    prompt,
    queued,
    ackSent,
    state,
    attemptCount,
    turnId,
    baselineTurnIds,
    lastError,
    createdAt,
    updatedAt,
  };
}

export function selectJob(db: DatabaseSync, id: string): StoredQueueJob {
  if (typeof id !== "string" || !isWellFormedString(id)) {
    throw new TypeError(`Invalid job id: ${String(id)}`);
  }
  const sql = `SELECT ${SELECT_FIELDS} FROM codex_turn_queue WHERE job_id = ?`;
  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  const row = stmt.get(id) as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new QueueJobNotFoundError(id);
  }
  return decodeRow(row);
}

export function allJobs(db: DatabaseSync): StoredQueueJob[] {
  const sql = `SELECT ${SELECT_FIELDS} FROM codex_turn_queue ORDER BY created_at, job_id`;
  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  const rows = stmt.all() as Array<Record<string, unknown>>;
  return rows.map(decodeRow);
}

export async function list(path: string): Promise<StoredQueueJob[]> {
  if (typeof path !== "string" || !isWellFormedString(path)) {
    throw new TypeError(`Invalid database path: ${String(path)}`);
  }
  const db = await openInitialized(path);
  try {
    return allJobs(db);
  } finally {
    try {
      db.close();
    } catch {
      // preserve primary error
    }
  }
}

export async function listFiltered(
  path: string,
  target: string | null,
  generation: bigint | null,
): Promise<StoredQueueJob[]> {
  if (typeof path !== "string" || !isWellFormedString(path)) {
    throw new TypeError(`Invalid database path: ${String(path)}`);
  }
  if (target !== null && (typeof target !== "string" || !isWellFormedString(target))) {
    throw new TypeError(`Invalid target: expected well-formed string or null`);
  }
  if (generation !== null) {
    if (typeof generation !== "bigint") {
      throw new TypeError(`Invalid generation: expected bigint or null`);
    }
    if (generation < I64_MIN || generation > I64_MAX) {
      throw new RangeError(`Generation out of signed i64 range: ${generation.toString()}`);
    }
  }

  const db = await openInitialized(path);
  try {
    if (target === null && generation === null) {
      return allJobs(db);
    }

    let sql: string;
    let params: Array<string | bigint>;

    if (target !== null && generation !== null) {
      sql = `SELECT ${SELECT_FIELDS} FROM codex_turn_queue WHERE target_thread_id = ? AND app_server_generation = ? ORDER BY created_at, job_id`;
      params = [target, generation];
    } else if (target !== null) {
      sql = `SELECT ${SELECT_FIELDS} FROM codex_turn_queue WHERE target_thread_id = ? ORDER BY created_at, job_id`;
      params = [target];
    } else {
      sql = `SELECT ${SELECT_FIELDS} FROM codex_turn_queue WHERE app_server_generation = ? ORDER BY created_at, job_id`;
      params = [generation!];
    }

    const stmt = db.prepare(sql);
    stmt.setReadBigInts(true);
    const rows = stmt.all(...params) as Array<Record<string, unknown>>;
    return rows.map(decodeRow);
  } finally {
    try {
      db.close();
    } catch {
      // preserve primary error
    }
  }
}

const STORED_QUEUE_JOB_PROPERTIES = [
  "jobId",
  "targetThreadId",
  "channelId",
  "ownerUserId",
  "discordMessageId",
  "appServerGeneration",
  "executionGeneration",
  "turnObservationGeneration",
  "goalWaiting",
  "prompt",
  "queued",
  "ackSent",
  "state",
  "attemptCount",
  "turnId",
  "baselineTurnIds",
  "lastError",
  "createdAt",
  "updatedAt",
] as const;

const EXPECTED_PROPERTY_SET = new Set<string>(STORED_QUEUE_JOB_PROPERTIES);

export function serializeStoredQueueJob(job: StoredQueueJob): string {
  if (job === null || typeof job !== "object" || Array.isArray(job)) {
    throw new TypeError("StoredQueueJob must be a non-null plain object");
  }
  if (types.isProxy(job)) {
    throw new TypeError("StoredQueueJob must not be a Proxy");
  }

  const proto = Object.getPrototypeOf(job);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError("StoredQueueJob must have Object.prototype or null prototype");
  }

  if (Object.getOwnPropertySymbols(job).length > 0) {
    throw new TypeError("StoredQueueJob must not contain symbol properties");
  }

  const propNames = Object.getOwnPropertyNames(job);
  if (propNames.length !== STORED_QUEUE_JOB_PROPERTIES.length) {
    throw new TypeError(
      `StoredQueueJob has invalid property count: expected ${STORED_QUEUE_JOB_PROPERTIES.length}, got ${propNames.length}`,
    );
  }

  for (const key of propNames) {
    if (!EXPECTED_PROPERTY_SET.has(key)) {
      throw new TypeError(`Unexpected property on StoredQueueJob: "${key}"`);
    }
  }

  const snapshot: Record<string, unknown> = {};
  for (const key of STORED_QUEUE_JOB_PROPERTIES) {
    const desc = Object.getOwnPropertyDescriptor(job, key);
    if (!desc || desc.get !== undefined || desc.set !== undefined || !("value" in desc)) {
      throw new TypeError(`Property "${key}" must be a plain data property without getter/setter`);
    }
    if (!desc.enumerable) {
      throw new TypeError(`Property "${key}" must be enumerable`);
    }
    snapshot[key] = desc.value;
  }

  const jobId = snapshot.jobId;
  if (typeof jobId !== "string" || !isWellFormedString(jobId)) {
    throw new TypeError("jobId must be a well-formed string");
  }

  const targetThreadId = snapshot.targetThreadId;
  if (typeof targetThreadId !== "string" || !isWellFormedString(targetThreadId)) {
    throw new TypeError("targetThreadId must be a well-formed string");
  }

  const channelId = snapshot.channelId;
  if (typeof channelId !== "bigint") {
    throw new TypeError("channelId must be a bigint");
  }
  if (channelId < I64_MIN || channelId > I64_MAX) {
    throw new RangeError(`channelId out of signed i64 range: ${channelId.toString()}`);
  }

  const ownerUserId = snapshot.ownerUserId;
  if (ownerUserId !== null) {
    if (typeof ownerUserId !== "bigint") {
      throw new TypeError("ownerUserId must be a bigint or null");
    }
    if (ownerUserId < I64_MIN || ownerUserId > I64_MAX) {
      throw new RangeError(`ownerUserId out of signed i64 range: ${ownerUserId.toString()}`);
    }
  }

  const discordMessageId = snapshot.discordMessageId;
  if (discordMessageId !== null) {
    if (typeof discordMessageId !== "bigint") {
      throw new TypeError("discordMessageId must be a bigint or null");
    }
    if (discordMessageId < I64_MIN || discordMessageId > I64_MAX) {
      throw new RangeError(`discordMessageId out of signed i64 range: ${discordMessageId.toString()}`);
    }
  }

  const appServerGeneration = snapshot.appServerGeneration;
  if (typeof appServerGeneration !== "bigint") {
    throw new TypeError("appServerGeneration must be a bigint");
  }
  if (appServerGeneration < I64_MIN || appServerGeneration > I64_MAX) {
    throw new RangeError(`appServerGeneration out of signed i64 range: ${appServerGeneration.toString()}`);
  }

  const executionGeneration = snapshot.executionGeneration;
  if (executionGeneration !== null) {
    if (typeof executionGeneration !== "bigint") {
      throw new TypeError("executionGeneration must be a bigint or null");
    }
    if (executionGeneration < I64_MIN || executionGeneration > I64_MAX) {
      throw new RangeError(`executionGeneration out of signed i64 range: ${executionGeneration.toString()}`);
    }
  }

  const turnObservationGeneration = snapshot.turnObservationGeneration;
  if (turnObservationGeneration !== null) {
    if (typeof turnObservationGeneration !== "bigint") {
      throw new TypeError("turnObservationGeneration must be a bigint or null");
    }
    if (turnObservationGeneration < I64_MIN || turnObservationGeneration > I64_MAX) {
      throw new RangeError(`turnObservationGeneration out of signed i64 range: ${turnObservationGeneration.toString()}`);
    }
  }

  const goalWaiting = snapshot.goalWaiting;
  if (typeof goalWaiting !== "boolean") {
    throw new TypeError("goalWaiting must be a boolean");
  }

  const prompt = snapshot.prompt;
  if (typeof prompt !== "string" || !isWellFormedString(prompt)) {
    throw new TypeError("prompt must be a well-formed string");
  }

  const queued = snapshot.queued;
  if (typeof queued !== "boolean") {
    throw new TypeError("queued must be a boolean");
  }

  const ackSent = snapshot.ackSent;
  if (typeof ackSent !== "boolean") {
    throw new TypeError("ackSent must be a boolean");
  }

  const state = snapshot.state;
  if (state !== "Pending" && state !== "Starting" && state !== "Running" && state !== "Quarantined") {
    throw new TypeError("Invalid QueueJobState enum value");
  }

  const attemptCount = snapshot.attemptCount;
  if (typeof attemptCount !== "bigint") {
    throw new TypeError("attemptCount must be a bigint");
  }
  if (attemptCount < I64_MIN || attemptCount > I64_MAX) {
    throw new RangeError(`attemptCount out of signed i64 range: ${attemptCount.toString()}`);
  }

  const turnId = snapshot.turnId;
  if (turnId !== null) {
    if (typeof turnId !== "string" || !isWellFormedString(turnId)) {
      throw new TypeError("turnId must be a well-formed string or null");
    }
  }

  const baselineTurnIds = snapshot.baselineTurnIds;
  if (!Array.isArray(baselineTurnIds)) {
    throw new TypeError("baselineTurnIds must be an array");
  }
  if (types.isProxy(baselineTurnIds)) {
    throw new TypeError("baselineTurnIds must not be a Proxy");
  }
  if (Object.getOwnPropertySymbols(baselineTurnIds).length > 0) {
    throw new TypeError("baselineTurnIds must not contain symbol properties");
  }
  const baselineProps = Object.getOwnPropertyNames(baselineTurnIds);
  if (baselineProps.length !== baselineTurnIds.length + 1) {
    throw new TypeError("baselineTurnIds must not be sparse or contain extra properties");
  }
  const copiedBaselineTurnIds: string[] = [];
  for (let i = 0; i < baselineTurnIds.length; i++) {
    const itemDesc = Object.getOwnPropertyDescriptor(baselineTurnIds, String(i));
    if (!itemDesc || itemDesc.get !== undefined || itemDesc.set !== undefined || !("value" in itemDesc)) {
      throw new TypeError(`baselineTurnIds element ${i} must not have getters/setters`);
    }
    if (!itemDesc.enumerable) {
      throw new TypeError(`baselineTurnIds element ${i} must be enumerable`);
    }
    const item = itemDesc.value;
    if (typeof item !== "string" || !isWellFormedString(item)) {
      throw new TypeError(`baselineTurnIds element ${i} must be a well-formed string`);
    }
    copiedBaselineTurnIds.push(item);
  }

  const lastError = snapshot.lastError;
  if (typeof lastError !== "string" || !isWellFormedString(lastError)) {
    throw new TypeError("lastError must be a well-formed string");
  }

  const createdAt = snapshot.createdAt;
  if (typeof createdAt !== "number") {
    throw new TypeError("createdAt must be a number");
  }

  const updatedAt = snapshot.updatedAt;
  if (typeof updatedAt !== "number") {
    throw new TypeError("updatedAt must be a number");
  }

  const pairs: string[] = [
    `"job_id":${serializeSerdeValue(jobId)}`,
    `"target_thread_id":${serializeSerdeValue(targetThreadId)}`,
    `"channel_id":${serializeSerdeValue(channelId)}`,
    `"owner_user_id":${serializeSerdeValue(ownerUserId)}`,
    `"discord_message_id":${serializeSerdeValue(discordMessageId)}`,
    `"app_server_generation":${serializeSerdeValue(appServerGeneration)}`,
    `"execution_generation":${serializeSerdeValue(executionGeneration)}`,
    `"turn_observation_generation":${serializeSerdeValue(turnObservationGeneration)}`,
    `"goal_waiting":${serializeSerdeValue(goalWaiting)}`,
    `"prompt":${serializeSerdeValue(prompt)}`,
    `"queued":${serializeSerdeValue(queued)}`,
    `"ack_sent":${serializeSerdeValue(ackSent)}`,
    `"state":${serializeSerdeValue(state)}`,
    `"attempt_count":${serializeSerdeValue(attemptCount)}`,
    `"turn_id":${serializeSerdeValue(turnId)}`,
    `"baseline_turn_ids":${serializeSerdeValue(copiedBaselineTurnIds)}`,
    `"last_error":${serializeSerdeValue(lastError)}`,
    `"created_at":${Number.isFinite(createdAt) ? serializeSerdeValue(createdAt) : "null"}`,
    `"updated_at":${Number.isFinite(updatedAt) ? serializeSerdeValue(updatedAt) : "null"}`,
  ];

  return `{${pairs.join(",")}}`;
}

/** Owned snapshot before an asynchronous mutation opens its connection. */
export function snapshotStoredQueueJob(claimed: StoredQueueJob): StoredQueueJob {
  if (claimed === null || typeof claimed !== "object" || types.isProxy(claimed) || Array.isArray(claimed))
    throw new TypeError("Expected a stored job data object");
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(claimed)) {
    const field = Object.getOwnPropertyDescriptor(claimed, key)!;
    if (!Object.hasOwn(field, "value") || !field.enumerable) throw new TypeError("Expected stored job data properties");
    copy[key] = field.value;
  }
  const baseline = copy.baselineTurnIds;
  if (!Array.isArray(baseline) || types.isProxy(baseline)) throw new TypeError("Expected baseline data array");
  const items: string[] = [];
  for (let i = 0; i < baseline.length; i++) {
    const field = Object.getOwnPropertyDescriptor(baseline, String(i));
    if (!field || !Object.hasOwn(field, "value") || typeof field.value !== "string" || !isWellFormedString(field.value))
      throw new TypeError("Expected baseline string data elements");
    items.push(field.value);
  }
  copy.baselineTurnIds = items;
  const result = copy as unknown as StoredQueueJob;
  serializeStoredQueueJob(result); // Reuse the exact full stored-job value validation.
  return result;
}

/** Rust StoredQueueJob PartialEq, including f64 zero/NaN behavior. */
export function storedQueueJobsEqual(a: StoredQueueJob, b: StoredQueueJob): boolean {
  return a.createdAt === b.createdAt && a.updatedAt === b.updatedAt &&
    isDeepStrictEqual({...a, createdAt: 0, updatedAt: 0}, {...b, createdAt: 0, updatedAt: 0});
}
