import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { parseSerdeValue } from "../core/serde-json-parse.ts";
import { serializeSerdeValue } from "../core/serde-json.ts";
import { selectJob, serializeStoredQueueJob } from "./queue-read.ts";
import type { StoredQueueJob } from "./queue-read.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";
import { ActiveTransactionError } from "./owned-driver.ts";
import { decodeTextField, textDecoderFor, decodeI64, decodeOptionalI64, decodeTimestamp } from "./sqlite-values.ts";
import { asI64, getOwn, isJsonObject } from "./async-resolution-json-helpers.ts";
import { trimUnicodeWhitespace as trim } from "./queue-preflight-failure.ts";

type Row = Record<string, unknown>;
const encoding = "(SELECT encoding FROM pragma_encoding) AS encoding";
const raw = (name: string): string => `CAST(${name} AS BLOB) AS ${name}_raw`;
function all(db: DatabaseSync, sql: string, ...values: SQLInputValue[]): Row[] {
  const statement = db.prepare(sql); statement.setReadBigInts(true); return statement.all(...values);
}
function one(db: DatabaseSync, sql: string, ...values: SQLInputValue[]): Row | undefined {
  const statement = db.prepare(sql); statement.setReadBigInts(true); return statement.get(...values);
}
function text(row: Row, name: string, optional = false): string | null {
  return decodeTextField(row[name], row[`${name}_raw`], name, optional, textDecoderFor(row.encoding));
}
function refused(): StoreIntegrityError {
  return new StoreIntegrityError("original stop control authority differs; no interrupt or replay");
}
function revisionRefused(): StoreIntegrityError {
  return new StoreIntegrityError("original RPC predates stop or stop revision evidence differs; no dispatch");
}

function latestScope(db: DatabaseSync, target: string): readonly [string, string] | null {
  if (!db.isTransaction) throw new ActiveTransactionError();
  const clock = one(db, `SELECT count(*) AS n,COALESCE(max(revision),-1) AS current,
    (SELECT COALESCE(max(revision),0) FROM cdr_stop_revision_receipts) AS maximum
    FROM cdr_stop_clock WHERE singleton=1`)!;
  const current = decodeI64(clock.current, "revision");
  if (decodeI64(clock.n, "count") !== 1n || current < 0n || current !== decodeI64(clock.maximum, "maximum")) throw revisionRefused();
  const columns = `revision,operation_id,${raw("operation_id")},${encoding}`;
  const indexed = one(db, `SELECT ${columns} FROM cdr_stop_revisions WHERE target_thread_id=?`, target);
  const history = one(db, `SELECT ${columns} FROM cdr_stop_revision_receipts WHERE target_thread_id=? ORDER BY revision DESC LIMIT 1`, target);
  const pair = (row: Row | undefined): unknown => row === undefined ? null : [decodeI64(row.revision, "revision"), text(row, "operation_id")];
  if (!isDeepStrictEqual(pair(indexed), pair(history))) throw revisionRefused();
  const scope = one(db, `SELECT operation_id,scope_json,${raw("operation_id")},${raw("scope_json")},${encoding}
    FROM cdr_stop_revision_receipts WHERE target_thread_id=? ORDER BY revision DESC LIMIT 1`, target);
  return scope === undefined ? null : [text(scope, "operation_id")!, text(scope, "scope_json")!];
}

function mirroredTarget(db: DatabaseSync, channel: bigint): string | null {
  if (channel === 0n) return null;
  const count = one(db, "SELECT COUNT(*) AS n FROM mirror_threads WHERE discord_thread_id=?", channel)!;
  if (decodeI64(count.n, "count") > 1n) throw new StoreIntegrityError(`Discord room ${channel} is mapped to multiple Codex threads; routing refused`);
  const columns = `codex_thread_id,${raw("codex_thread_id")},${encoding}`;
  const exact = one(db, `SELECT ${columns} FROM mirror_threads WHERE discord_thread_id=?`, channel);
  if (exact !== undefined) return text(exact, "codex_thread_id");
  const rows = all(db, `SELECT ${columns} FROM mirror_threads WHERE discord_channel_id=? ORDER BY updated_at DESC LIMIT 2`, channel);
  const values = rows.map(row => text(row, "codex_thread_id"));
  return values.length === 1 ? values[0]! : null;
}

function validateBinding(db: DatabaseSync, before: StoredQueueJob, binding: unknown): void {
  const command = getOwn(binding, "command"); const fields = getOwn(command, "Stop");
  const reference = getOwn(fields, "reference");
  const explicit = typeof reference === "string" && trim(reference) !== "";
  if (!isJsonObject(command) || Object.keys(command).length !== 1 || !isJsonObject(fields)
    || Object.keys(fields).length !== 1 || (!explicit && reference !== null)
    || getOwn(binding, "target") !== before.targetThreadId) throw new StoreIntegrityError("stop custody differs or could not be preserved; no stop acceptance");
  const route = getOwn(binding, "route");
  const valid = route === "Explicit" ? explicit : !explicit && (
    route === "Mapped" ? mirroredTarget(db, before.channelId) === before.targetThreadId
      : route === "Selected" && mirroredTarget(db, before.channelId) === null);
  if (!valid) throw new StoreIntegrityError("stop custody differs or could not be preserved; no stop acceptance");
}

function holdSnapshot(db: DatabaseSync, job: string): readonly string[] | null {
  const names = ["target_thread_id", "reason", "evidence_json"];
  const row = one(db, `SELECT ${names.join(",")},${names.map(raw).join(",")},${encoding}
    FROM cdr_execution_holds WHERE job_id=?`, job);
  return row === undefined ? null : names.map(name => text(row, name)!);
}

// Rust get_in decodes the full record even though this caller only needs presence.
function hasDecodedIntake(db: DatabaseSync, job: string): boolean {
  const names = ["job_id", "target_thread_id", "channel_id", "owner_user_id", "discord_message_id",
    "raw_prompt", "auto_queue_when_busy", "require_current_mirror", "attempt_count", "last_error",
    "retry_after", "claim_token", "claim_expires_at", "created_at", "updated_at"];
  const strings = ["job_id", "target_thread_id", "raw_prompt", "last_error", "claim_token"];
  const row = one(db, `SELECT ${names.join(",")},${strings.map(raw).join(",")},${encoding}
    FROM codex_prompt_intakes WHERE job_id=?`, job);
  if (row === undefined) return false;
  for (const name of names) {
    if (strings.includes(name)) text(row, name, name === "claim_token");
    else if (name === "owner_user_id" || name === "discord_message_id") decodeOptionalI64(row[name], name);
    else if (["retry_after", "claim_expires_at", "created_at", "updated_at"].includes(name)) decodeTimestamp(row[name], name);
    else decodeI64(row[name], name);
  }
  return true;
}

function sameOriginal(before: StoredQueueJob, after: StoredQueueJob): boolean {
  const bits = (value: number): bigint => { const b = Buffer.allocUnsafe(8); b.writeDoubleLE(value); return b.readBigUInt64LE(); };
  const keys = ["jobId", "targetThreadId", "channelId", "ownerUserId", "discordMessageId", "prompt",
    "lastError", "attemptCount", "appServerGeneration", "executionGeneration"] as const;
  return before.state === "Starting" && before.turnId === null && !before.goalWaiting
    && before.attemptCount > 0n && before.appServerGeneration > 0n
    && before.executionGeneration === before.appServerGeneration && after.state === "Running"
    && !after.goalWaiting && after.turnObservationGeneration === before.appServerGeneration
    && keys.every(key => before[key] === after[key]) && bits(before.createdAt) === bits(after.createdAt)
    && isDeepStrictEqual(before.baselineTurnIds, after.baselineTurnIds);
}

/** Call inside the exact ACK writer transaction; never starts or interrupts a turn. */
export function bindLateStartIn(db: DatabaseSync, before: StoredQueueJob, running: StoredQueueJob, resident: string): void {
  const latest = latestScope(db, before.targetThreadId);
  if (latest === null) return;
  const [operation, scopeText] = latest;
  const scope: unknown = parseSerdeValue(scopeText); const jobs = getOwn(scope, "jobs");
  if (!Array.isArray(jobs)) throw refused();
  if (!jobs.some(id => id === before.jobId)) return;
  if (decodeI64(one(db, "SELECT EXISTS(SELECT 1 FROM cdr_stop_controls WHERE operation_id=?) AS n", operation)?.n, "exists") !== 0n) return;
  if (trim(resident) === "" || !sameOriginal(before, running) || jobs.length > 128
    || getOwn(scope, "target") !== before.targetThreadId || asI64(getOwn(scope, "channel")) !== before.channelId
    || (asI64(getOwn(scope, "owner")) ?? null) !== before.ownerUserId) throw refused();
  if (before.ownerUserId === null) throw refused();
  const binding = getOwn(scope, "binding");
  if (binding === undefined) throw refused();
  validateBinding(db, before, binding);
  const hold = holdSnapshot(db, before.jobId);
  if (hold === null || hold[0] !== before.targetThreadId) throw refused();
  const turn = running.turnId;
  if (turn === null || turn === "" || trim(turn) !== turn || before.baselineTurnIds.includes(turn)) throw refused();
  const ingresses = getOwn(scope, "ingresses");
  const canSettle = jobs.length === 1 && getOwn(scope, "hadPreparing") === false
    && Array.isArray(ingresses) && ingresses.length === 0 && !hasDecodedIntake(db, before.jobId);
  const values: [string, unknown][] = [["operation_id", operation], ["target", before.targetThreadId],
    ["channel", before.channelId], ["owner", before.ownerUserId], ["resident", resident],
    ["generation", before.appServerGeneration], ["turn", turn], ["binding", binding],
    ["jobs", [serializeStoredQueueJob(running)]], ["can_settle", canSettle]];
  const record = `{${values.map(([key, value]) => `${JSON.stringify(key)}:${serializeSerdeValue(value)}`).join(",")}}`;
  const changed = db.prepare(`INSERT INTO cdr_stop_controls(operation_id,target_thread_id,resident_owner,
    generation,turn_id,record_json,phase) VALUES(?,?,?,?,?,?,'accepted')`).run(operation,
    before.targetThreadId, resident, before.appServerGeneration, turn, record).changes;
  if (changed !== 1 && changed !== 1n) throw refused();
  const pristine = one(db, `SELECT EXISTS(SELECT 1 FROM cdr_stop_controls WHERE operation_id=?
    AND phase='accepted' AND claim_token IS NULL AND wire_attempt IS NULL AND wire_id IS NULL AND terminal_json IS NULL) AS n`, operation)?.n;
  const retained = one(db, `SELECT EXISTS(SELECT 1 FROM cdr_stop_controls WHERE operation_id=?
    AND target_thread_id=? AND resident_owner=? AND generation=? AND turn_id=? AND record_json=?) AS n`,
    operation, before.targetThreadId, resident, before.appServerGeneration, turn, record)?.n;
  const stored = selectJob(db, before.jobId);
  const sameJob = (Object.keys(running) as (keyof StoredQueueJob)[]).every(key => key === "baselineTurnIds"
    ? isDeepStrictEqual(stored[key], running[key]) : stored[key] === running[key]);
  if (pristine !== 1n || retained !== 1n || !isDeepStrictEqual(holdSnapshot(db, before.jobId), hold)
    || !sameJob || !isDeepStrictEqual(latestScope(db, before.targetThreadId), latest)) throw refused();
}
