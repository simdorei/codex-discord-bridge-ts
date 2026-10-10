import {StoreIntegrityError} from "./schema-assembly.ts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { parseSerdeValue } from "../core/serde-json-parse.ts";
import { decodeOwnershipHandoff, type ExecutionOwner } from "./async-resolution-proof.ts";
import { AsyncResolutionHeldError } from "./async-resolution-admission.ts";
import type { AsyncObligation } from "./async-resolution-records.ts";
import { completionEvidenceGeneration, selectJob, serializeStoredQueueJob, type StoredQueueJob } from "./queue-read.ts";
import { decodeI64, decodeTextField, textDecoderFor } from "./sqlite-values.ts";
import { trimUnicodeWhitespace as trim } from "./queue-preflight-failure.ts";
import { asI64, getOwn } from "./async-resolution-json-helpers.ts";

export const ASYNC_QUESTION_CLAIM_SQL = `json_object('id',q.id,'runtime_id',q.runtime_id,'generation',q.generation,
 'thread_id',q.thread_id,'turn_id',q.turn_id,'item_id',q.item_id,'origin_job_id',q.origin_job_id,
 'channel_id',q.channel_id,'owner_user_id',q.owner_user_id,'body',q.body,'chosen',q.chosen,
 'message_id',q.message_id,'dispatch_mode',q.dispatch_mode)`;
function text(db: DatabaseSync, row: Record<string, unknown>, column: string, optional = false): string | null {
  return decodeTextField(row[column], row[column + "_raw"], column, optional,
    textDecoderFor(db.prepare("PRAGMA encoding").get()?.encoding));
}
function held(row: AsyncObligation, reason: string): never { throw new AsyncResolutionHeldError(row.thread_id, reason); }
function bitPattern(n: number): bigint {
  const b = Buffer.alloc(8); b.writeDoubleLE(n); return b.readBigUInt64LE();
}
export function executionOwnerJobValue(job: StoredQueueJob): Record<string, unknown> {
  const value = parseSerdeValue<Record<string, unknown>>(serializeStoredQueueJob(job));
  value.created_at = bitPattern(job.createdAt); value.updated_at = bitPattern(job.updatedAt);
  return value;
}
export function asyncExecutionOwnerIn(db: DatabaseSync, row: AsyncObligation): ExecutionOwner {
  const stmt = db.prepare(`SELECT revision,evidence_json,CAST(evidence_json AS BLOB) AS evidence_json_raw,
    evidence_sha256,CAST(evidence_sha256 AS BLOB) AS evidence_sha256_raw
    FROM cdr_async_execution_handoffs WHERE question_id=? ORDER BY revision DESC LIMIT 1`);
  stmt.setReadBigInts(true);
  const stored = stmt.get(row.question_id);
  let owner: ExecutionOwner;
  if (stored) {
    const revision = decodeI64(stored.revision, "revision"), raw = text(db, stored, "evidence_json")!, digest = text(db, stored, "evidence_sha256")!;
    if (Buffer.byteLength(raw) > 131072 || createHash("sha256").update(raw).digest("hex") !== digest) held(row, "invalid Goal ownership evidence");
    const handoff = decodeOwnershipHandoff(raw);
    if (handoff.version !== 1n || handoff.revision !== revision || revision !== row.revision ||
        handoff.claim_sha256 !== row.claim_sha256 || Buffer.byteLength(handoff.previous_terminal) > 131072) held(row, "stale Goal ownership evidence");
    owner = handoff.owner;
  } else {
    const claim: unknown = parseSerdeValue(row.claim);
    if (row.original_seal === null) held(row, "missing original preparation");
    if (Buffer.byteLength(row.original_seal) > 131072) held(row, "oversized original preparation");
    const seal: unknown = parseSerdeValue(row.original_seal);
    const generation = asI64(getOwn(claim, "generation"));
    if (generation === undefined) held(row, "missing original generation");
    const observer = getOwn(claim, "runtime_id");
    if (typeof observer !== "string") held(row, "missing original observer");
    const job = getOwn(getOwn(seal, "identity"), "job");
    if (job === undefined) held(row, "missing sealed owner");
    owner = {turn_id: row.turn_id, generation, observer, job};
  }
  if (owner.generation < 0n || trim(owner.observer) === "" || Buffer.byteLength(owner.observer) > 256 || trim(owner.turn_id) === "" ||
      getOwn(owner.job, "job_id") !== row.origin_job_id || getOwn(owner.job, "target_thread_id") !== row.thread_id ||
      getOwn(owner.job, "turn_id") !== owner.turn_id) held(row, "invalid execution owner identity");
  return owner;
}
export function asyncClaimIsCurrentIn(db: DatabaseSync, row: AsyncObligation): boolean {
  const stmt = db.prepare(`SELECT ${ASYNC_QUESTION_CLAIM_SQL} AS claim,CAST(${ASYNC_QUESTION_CLAIM_SQL} AS BLOB) AS claim_raw,
    q.preparation_json AS seal,CAST(q.preparation_json AS BLOB) AS seal_raw
    FROM cdr_async_questions q WHERE q.id=? AND EXISTS(SELECT 1 FROM mirror_threads m
      WHERE m.codex_thread_id=q.thread_id AND (m.discord_thread_id=q.channel_id OR m.discord_channel_id=q.channel_id))`);
  stmt.setReadBigInts(true);
  const current = stmt.get(row.question_id);
  if (!current) return false;
  const claim = text(db, current, "claim"), seal = text(db, current, "seal", true);
  return claim === row.claim && seal === row.original_seal;
}
export function exactAsyncOwnerIn(db: DatabaseSync, row: AsyncObligation): boolean {
  if (!asyncClaimIsCurrentIn(db,row)) return false;
  const exists = db.prepare("SELECT EXISTS(SELECT 1 FROM codex_turn_queue WHERE job_id=?) AS present");
  exists.setReadBigInts(true);
  if (decodeI64(exists.get(row.origin_job_id)?.present, "present") === 0n) return false;
  const owner = asyncExecutionOwnerIn(db, row), job = selectJob(db, row.origin_job_id);
  return job.state === "Running" && !job.goalWaiting && completionEvidenceGeneration(job) === owner.generation &&
    isDeepStrictEqual(executionOwnerJobValue(job), owner.job);
}

import {readAsyncObligationsIn} from "./async-resolution-records.ts";
import {verifiedAsyncTerminalProofIn} from "./async-resolution-terminal.ts";
import {serializeOwnershipHandoff} from "./async-resolution-proof.ts";
import {serdeValueEqual} from "../core/serde-value-equal.ts";
/** After the exact waiting-owner update, in the same caller-owned transaction. */
export function handoffOwnedAsyncIn(db:DatabaseSync,previous:StoredQueueJob):void{
  if(!db.isTransaction)throw new StoreIntegrityError("Borrowed mutation requires an active transaction");
  const next=selectJob(db,previous.jobId);
  for(const row of readAsyncObligationsIn(db,previous.targetThreadId)){
    if(row.origin_job_id!==previous.jobId||row.execution_state!=="unresolved")continue;
    const owner=asyncExecutionOwnerIn(db,row),waiting=executionOwnerJobValue(previous);
    waiting.goal_waiting=false;waiting.updated_at=getOwn(owner.job,"updated_at")??null;
    if(!previous.goalWaiting||previous.state!=="Running"||previous.turnId!==owner.turn_id||!serdeValueEqual(waiting,owner.job)||!asyncClaimIsCurrentIn(db,row))
      held(row,"Goal handoff lost the original execution owner");
    const proof=verifiedAsyncTerminalProofIn(db,row,owner);
    if(proof===null)held(row,"Goal handoff has no exact owned terminal evidence");
    const expectedNext=executionOwnerJobValue(previous),nextValue=executionOwnerJobValue(next);
    expectedNext.turn_id=next.turnId;expectedNext.turn_observation_generation=next.turnObservationGeneration;
    expectedNext.goal_waiting=false;expectedNext.updated_at=nextValue.updated_at;
    if(!serdeValueEqual(expectedNext,nextValue)||next.turnId===previous.turnId||next.state!=="Running"||next.goalWaiting)
      held(row,"Goal successor snapshot is not an exact owned handoff");
    const countQuery=db.prepare("SELECT count(*) AS n FROM cdr_async_execution_handoffs WHERE question_id=?");countQuery.setReadBigInts(true);
    const count=decodeI64(countQuery.get(row.question_id)?.n,"handoff count");
    if(count<0n||count>=128n)held(row,"Goal evidence chain needs bounded reconciliation");
    if(row.revision===9223372036854775807n)held(row,"execution revision overflow");
    if(next.turnId===null)held(row,"missing Goal successor turn");
    const revision=row.revision+1n,raw=serializeOwnershipHandoff({version:1n,revision,claim_sha256:row.claim_sha256,previous_terminal:proof[0],
      owner:{turn_id:next.turnId,generation:completionEvidenceGeneration(next),observer:owner.observer,job:nextValue}});
    if(Buffer.byteLength(raw)>131072)held(row,"Goal handoff evidence exceeds bound");
    db.prepare("INSERT INTO cdr_async_execution_handoffs(question_id,revision,evidence_json,evidence_sha256) VALUES(?,?,?,?)")
      .run(row.question_id,revision,raw,createHash("sha256").update(raw).digest("hex"));
    if(BigInt(db.prepare("UPDATE cdr_async_execution_obligations SET revision=?,terminal_proof_json=NULL WHERE question_id=? AND revision=? AND terminal_proof_json=? AND execution_state='unresolved'")
      .run(revision,row.question_id,row.revision,proof[0]).changes)!==1n)held(row,"Goal handoff lost the exact policy revision");
  }
}
