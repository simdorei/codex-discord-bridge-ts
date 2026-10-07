import type { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { I64_MIN, I64_MAX } from "../protocol/ids.ts";
import { rustDebugString } from "../core/rust-debug.ts";
import { openInitialized } from "./owned-driver.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";
import { selectJob, QueueJobNotFoundError } from "./queue-read.ts";
import type { StoredQueueJob } from "./queue-read.ts";
import { decodeTextField, textDecoderFor } from "./sqlite-values.ts";
import { beforeEnqueue } from "./idle-release-admission.ts";
import { requireUnheldOriginIn, asyncQuestionDispatchHeldIn } from "./queue-admission-guards.ts";
import { ensureNoUnresolvedHandoff, ensureSourceNotMoved } from "./fork-handoff-admission.ts";

export interface NewQueueJob {
  jobId: string; targetThreadId: string; channelId: bigint;
  ownerUserId: bigint | null; discordMessageId: bigint | null;
  appServerGeneration: bigint; prompt: string; queued: boolean;
  ackSent: boolean; createdAt: number;
}
export interface ExpectedMirrorMapping { discordChannelId: bigint; targetThreadId: string; }
export interface QueueEnqueueResult { job: StoredQueueJob; created: boolean; }
export class MirrorMappingChangedError extends Error {
  readonly kind="MirrorMappingChanged" as const;
  readonly discordChannelId: bigint;
  readonly expectedTargetThreadId: string;
  readonly actualTargetThreadId: string | null;
  constructor(channel: bigint, expected: string, actual: string | null) {
    super(`mirror mapping changed for Discord channel ${channel}: expected ${expected}, actual ${actual===null?"None":"Some("+rustDebugString(actual)+")"}`);
    this.name="MirrorMappingChangedError";
    this.discordChannelId=channel;
    this.expectedTargetThreadId=expected;
    this.actualTargetThreadId=actual;
  }
}
function text(value: unknown): string {
  if(typeof value!=="string") throw new TypeError("Expected a well-formed string");
  for(const c of value) {
    const p=c.codePointAt(0)!;
    if(p>=0xd800&&p<=0xdfff) throw new TypeError("Expected a well-formed string");
  }
  return value;
}
function integer(value: unknown): bigint {
  if(typeof value!=="bigint"||value<I64_MIN||value>I64_MAX) throw new TypeError("Expected a signed i64 bigint");
  return value;
}
function optionalInteger(value: unknown): bigint | null { return value===null?null:integer(value); }
function boolean(value: unknown): boolean {
  if(typeof value!=="boolean") throw new TypeError("Expected a boolean");
  return value;
}
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if(value===null||typeof value!=="object"||types.isProxy(value)||Array.isArray(value)) throw new TypeError("Expected a plain data object");
  const proto=Object.getPrototypeOf(value);
  if(proto!==Object.prototype&&proto!==null) throw new TypeError("Expected a plain data object");
  const result: Record<string, unknown>={};
  for(const name of names) {
    const d=Object.getOwnPropertyDescriptor(value,name);
    if(d===undefined||!("value" in d)||!d.enumerable) throw new TypeError("Expected own enumerable data fields");
    result[name]=d.value;
  }
  return result;
}
function snapshotJob(input: NewQueueJob): NewQueueJob {
  const f=fields(input,["jobId","targetThreadId","channelId","ownerUserId","discordMessageId","appServerGeneration","prompt","queued","ackSent","createdAt"]);
  if(typeof f.createdAt!=="number") throw new TypeError("Expected a numeric timestamp");
  return {
    jobId:text(f.jobId),targetThreadId:text(f.targetThreadId),channelId:integer(f.channelId),
    ownerUserId:optionalInteger(f.ownerUserId),discordMessageId:optionalInteger(f.discordMessageId),
    appServerGeneration:integer(f.appServerGeneration),prompt:text(f.prompt),
    queued:boolean(f.queued),ackSent:boolean(f.ackSent),createdAt:f.createdAt,
  };
}
function snapshotMapping(input: ExpectedMirrorMapping): ExpectedMirrorMapping {
  const f=fields(input,["discordChannelId","targetThreadId"]);
  return {discordChannelId:integer(f.discordChannelId),targetThreadId:text(f.targetThreadId)};
}
function selectByMessage(db: DatabaseSync, message: bigint): StoredQueueJob {
  const row=db.prepare(`SELECT job_id,CAST(job_id AS BLOB) AS raw,
    (SELECT encoding FROM pragma_encoding) AS encoding FROM codex_turn_queue WHERE discord_message_id=?`).get(message);
  if(row===undefined) throw new QueueJobNotFoundError(message.toString());
  const id=decodeTextField(row.job_id,row.raw,"job_id",false,textDecoderFor(row.encoding))!;
  return selectJob(db,id);
}
function enqueueOwnedValues(db: DatabaseSync, job: NewQueueJob): QueueEnqueueResult {
  beforeEnqueue(db,job.targetThreadId);
  requireUnheldOriginIn(db,job.discordMessageId);
  if(asyncQuestionDispatchHeldIn(db,job.targetThreadId)) {
    throw new StoreIntegrityError("async question reply outcome is unconfirmed; target held without automatic retry");
  }
  ensureNoUnresolvedHandoff(db,job.targetThreadId);
  ensureSourceNotMoved(db,job.targetThreadId);
  const result=db.prepare(`INSERT OR IGNORE INTO codex_turn_queue
    (job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,app_server_generation,
      prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'pending',0,'[]',?,?)`).run(
      job.jobId,job.targetThreadId,job.channelId,job.ownerUserId,job.discordMessageId,
      job.appServerGeneration,job.prompt,job.queued?1n:0n,job.ackSent?1n:0n,
      job.createdAt,job.createdAt);
  const created=BigInt(result.changes)===1n;
  const stored=created||job.discordMessageId===null?selectJob(db,job.jobId):selectByMessage(db,job.discordMessageId);
  return {job:stored,created};
}
/** Caller owns transaction and connection. */
export function enqueueInTransaction(db: DatabaseSync, input: NewQueueJob): QueueEnqueueResult {
  return enqueueOwnedValues(db,snapshotJob(input));
}
function mirrorCandidates(db: DatabaseSync, where: string, channel: bigint): string[] {
  return db.prepare(`SELECT codex_thread_id,CAST(codex_thread_id AS BLOB) AS raw,
    (SELECT encoding FROM pragma_encoding) AS encoding FROM mirror_threads ${where}`)
    .all(channel).map(row=>decodeTextField(row.codex_thread_id,row.raw,"codex_thread_id",false,textDecoderFor(row.encoding))!);
}
function strictMirrorTarget(db: DatabaseSync, channel: bigint): string | null {
  const exact=mirrorCandidates(db,"WHERE discord_thread_id=? LIMIT 2",channel);
  if(exact.length===1) return exact[0]!;
  if(exact.length!==0) return null;
  const project=mirrorCandidates(db,"WHERE discord_channel_id=? ORDER BY updated_at DESC LIMIT 2",channel);
  return project.length===1?project[0]!:null;
}
function checkMirror(db: DatabaseSync, job: NewQueueJob, expected: ExpectedMirrorMapping): void {
  const actual=strictMirrorTarget(db,expected.discordChannelId);
  if(actual!==expected.targetThreadId||job.channelId!==expected.discordChannelId||job.targetThreadId!==expected.targetThreadId) {
    throw new MirrorMappingChangedError(expected.discordChannelId,expected.targetThreadId,actual);
  }
}
export function ensureMirrorMatches(db: DatabaseSync, input: NewQueueJob, mapping: ExpectedMirrorMapping): void {
  checkMirror(db,snapshotJob(input),snapshotMapping(mapping));
}
async function ownedEnqueue(path: string, job: NewQueueJob, mapping: ExpectedMirrorMapping | null): Promise<QueueEnqueueResult> {
  const db=await openInitialized(text(path));
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      if(mapping!==null) checkMirror(db,job,mapping);
      const result=enqueueOwnedValues(db,job);
      db.exec("COMMIT");
      return result;
    } catch(error) {
      try { if(db.isTransaction) db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  } finally { try { db.close(); } catch {} }
}
export async function enqueue(path: string, input: NewQueueJob): Promise<QueueEnqueueResult> {
  return ownedEnqueue(path,snapshotJob(input),null);
}
export async function enqueueIfMirrorMatches(path: string, input: NewQueueJob, mapping: ExpectedMirrorMapping): Promise<QueueEnqueueResult> {
  return ownedEnqueue(path,snapshotJob(input),snapshotMapping(mapping));
}
