import { trimUnicodeWhitespace, takeUnicodeScalarChars } from "./queue-preflight-failure.ts";
import type { DatabaseSync } from "node:sqlite";
import { openInitialized } from "./owned-driver.ts";
import { selectJob, snapshotStoredQueueJob, storedQueueJobsEqual, InvalidQueueStateError, type StoredQueueJob } from "./queue-read.ts";
import { targetIsHeldIn } from "./dead-generation-admission.ts";
import { DeadGenerationTargetHeldError } from "./fork-completed-target.ts";
import { recordJobOrigin } from "./mirror-origin.ts";
import { reconcileAsyncQuestionJobIn } from "./async-question-inbox.ts";
import { settleOwnedAsyncIn, retainAsyncTerminalJournalIn, type TerminalReleaseOwner } from "./async-resolution-terminal.ts";
import { stageIdleReleaseCandidateIn } from "./idle-release-admission.ts";
import { decodeI64, decodeTextField, decodeTimestamp, textDecoderFor } from "./sqlite-values.ts";

export interface StoredDelivery {
  deliveryId:string; jobId:string; targetThreadId:string; turnId:string; channelId:bigint;
  content:string; attemptCount:bigint; lastError:string; createdAt:number; updatedAt:number;
}
export class QueueJobHasNoTurnError extends Error {
  readonly kind="QueueJobHasNoTurn"; readonly jobId:string;
  constructor(jobId:string) { super(`durable queue job has no turn id: ${jobId}`);this.name="QueueJobHasNoTurnError";this.jobId=jobId; }
}
export class DeliveryNotFoundError extends Error {
  readonly kind="DeliveryNotFound"; readonly deliveryId:string;
  constructor(id:string) { super(`durable Discord delivery not found: ${id}`);this.name="DeliveryNotFoundError";this.deliveryId=id; }
}
const DELIVERY_TEXT = ["delivery_id","job_id","target_thread_id","turn_id","content","last_error"];
const DELIVERY_SELECT = `SELECT delivery_id,job_id,target_thread_id,turn_id,channel_id,content,attempt_count,last_error,created_at,updated_at,
  ${DELIVERY_TEXT.map(c=>`CAST(${c} AS BLOB) AS b_${c}`).join(",")},
  (SELECT encoding FROM pragma_encoding) AS encoding FROM codex_delivery_outbox`;
function decodeDelivery(row: Record<string, unknown>): StoredDelivery {
  const decoder=textDecoderFor(row.encoding);
  const text=(c:string):string=>decodeTextField(row[c],row["b_"+c],c,false,decoder)!;
  return {deliveryId:text("delivery_id"),jobId:text("job_id"),targetThreadId:text("target_thread_id"),turnId:text("turn_id"),
    channelId:decodeI64(row.channel_id,"channel_id"),content:text("content"),attemptCount:decodeI64(row.attempt_count,"attempt_count"),
    lastError:text("last_error"),createdAt:decodeTimestamp(row.created_at,"created_at"),updatedAt:decodeTimestamp(row.updated_at,"updated_at")};
}
function readDelivery(db:DatabaseSync,id:string):StoredDelivery {
  const stmt=db.prepare(DELIVERY_SELECT+" WHERE delivery_id=?");
  stmt.setReadBigInts(true);const row=stmt.get(id);if(!row) throw new DeliveryNotFoundError(id);
  return decodeDelivery(row);
}
function validText(text:unknown):asserts text is string {
  if(typeof text!=="string"||/[\uD800-\uDFFF]/u.test(text)) throw new TypeError("Expected well-formed text");
}
/** Exact owner check, outbox, inbox, terminal evidence and release candidate commit together. */
export async function stageOwnedQueueCompletion(
  path:string, expectedInput:StoredQueueJob, content:string, now:number, releaseInput:TerminalReleaseOwner|null=null,
):Promise<StoredDelivery> {
  validText(path);validText(content);if(typeof now!=="number") throw new TypeError("Expected timestamp number");
  const expected=snapshotStoredQueueJob(expectedInput);
  const release=releaseInput===null?null:{observer:releaseInput.observer,generation:releaseInput.generation};
  if(release!==null) {
    validText(release.observer);
    if(typeof release.generation!=="bigint"||release.generation<-(1n<<63n)||release.generation>=(1n<<63n)) throw new TypeError("Expected i64 generation");
  }
  const db=await openInitialized(path);let committed=false;
  try {
    db.exec("BEGIN IMMEDIATE");const job=selectJob(db,expected.jobId);
    const count=db.prepare("SELECT count(*) AS n FROM codex_turn_queue WHERE target_thread_id=? AND turn_id=? AND state='running'");
    count.setReadBigInts(true);
    const owners=decodeI64(count.get(expected.targetThreadId,expected.turnId)?.n,"owner count");
    if(!storedQueueJobsEqual(job,expected)||job.state!=="Running"||owners!==1n)
      throw new InvalidQueueStateError("completion ownership changed before commit");
    if(targetIsHeldIn(db,job.targetThreadId)) throw new DeadGenerationTargetHeldError(job.targetThreadId);
    recordJobOrigin(db,job);
    if(job.turnId===null) throw new QueueJobHasNoTurnError(job.jobId);
    reconcileAsyncQuestionJobIn(db,job.jobId);
    settleOwnedAsyncIn(db,expected,release);
    db.prepare(`INSERT OR IGNORE INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(job.jobId,job.jobId,job.targetThreadId,job.turnId,job.channelId,content,now,now);
    db.prepare("INSERT OR IGNORE INTO codex_session_mirror_events(event_digest,codex_thread_id,created_at) VALUES(?,?,?)")
      .run(`discord-origin:v1:${job.targetThreadId}:${job.turnId}`,job.targetThreadId,now);
    db.prepare("DELETE FROM codex_turn_queue WHERE job_id=?").run(job.jobId);
    if(!retainAsyncTerminalJournalIn(db,job.targetThreadId,job.turnId))
      db.prepare("DELETE FROM codex_observed_completions WHERE thread_id=? AND turn_id=?").run(job.targetThreadId,job.turnId);
    db.prepare("DELETE FROM codex_observed_final_answers WHERE thread_id=? AND turn_id=?").run(job.targetThreadId,job.turnId);
    const delivery=readDelivery(db,job.jobId);
    if(release!==null&&job.appServerGeneration===release.generation) stageIdleReleaseCandidateIn(db,job,release.observer);
    db.exec("COMMIT");committed=true;return delivery;
  } finally {
    if(!committed&&db.isTransaction) { try {db.exec("ROLLBACK");} catch { /* close abandons uncommitted work */ } }
    db.close();
  }
}


export async function listPendingDeliveries(path: string): Promise<StoredDelivery[]> {
  const db=await openInitialized(path);
  try {
    const stmt=db.prepare(DELIVERY_SELECT+" ORDER BY created_at,delivery_id");stmt.setReadBigInts(true);
    const result: StoredDelivery[]=[];
    for(const row of stmt.iterate()) result.push(decodeDelivery(row));
    return result;
  } finally {db.close();}
}
export async function recordDeliveryFailure(path: string,id: string,error: string,now: number): Promise<StoredDelivery> {
  validText(path);validText(id);validText(error);if(typeof now!=="number") throw new TypeError("Expected timestamp number");
  const bounded=takeUnicodeScalarChars(trimUnicodeWhitespace(error),1000);
  const db=await openInitialized(path);let committed=false;
  try {
    db.exec("BEGIN IMMEDIATE");
    const changed=db.prepare("UPDATE codex_delivery_outbox SET attempt_count=attempt_count+1,last_error=?,updated_at=? WHERE delivery_id=?").run(bounded,now,id).changes;
    if(BigInt(changed)!==1n) throw new DeliveryNotFoundError(id);
    const delivery=readDelivery(db,id);db.exec("COMMIT");committed=true;return delivery;
  } finally {
    if(!committed&&db.isTransaction) {try{db.exec("ROLLBACK");}catch{/* close rolls back */}}
    db.close();
  }
}
export async function completeDelivery(path: string,id: string): Promise<boolean> {
  validText(path);validText(id);const db=await openInitialized(path);
  try {return BigInt(db.prepare("DELETE FROM codex_delivery_outbox WHERE delivery_id=?").run(id).changes)===1n;}
  finally {db.close();}
}
