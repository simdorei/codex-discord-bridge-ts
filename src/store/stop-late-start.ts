import {latestStopScopeIn as latestScope} from "./stop-revision-read.ts";
import {validateStopBindingIn,stopHoldSnapshotIn as holdSnapshot} from "./stop-custody-common.ts";
import { getPromptIntakeIn } from "./prompt-intake.ts";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { parseSerdeValue } from "../core/serde-json-parse.ts";
import { serializeSerdeValue } from "../core/serde-json.ts";
import { selectJob, serializeStoredQueueJob } from "./queue-read.ts";
import type { StoredQueueJob } from "./queue-read.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";
import { decodeI64 } from "./sqlite-values.ts";
import { asI64, getOwn } from "./async-resolution-json-helpers.ts";
import { trimUnicodeWhitespace as trim } from "./queue-preflight-failure.ts";

type Row = Record<string, unknown>;
function one(db: DatabaseSync, sql: string, ...values: SQLInputValue[]): Row | undefined {
  const statement = db.prepare(sql); statement.setReadBigInts(true); return statement.get(...values);
}
function refused(): StoreIntegrityError {
  return new StoreIntegrityError("original stop control authority differs; no interrupt or replay");
}

// The shared reader decodes the full intake before this presence decision.
function hasDecodedIntake(db: DatabaseSync, job: string): boolean {
  return getPromptIntakeIn(db,job) !== null;
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
  validateStopBindingIn(db, before.targetThreadId, before.channelId, binding);
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
