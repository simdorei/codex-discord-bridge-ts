import type {DatabaseSync} from "node:sqlite";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {parseSerdeStruct} from "../core/serde-struct-json.ts";
import {serdeValueEqual} from "../core/serde-value-equal.ts";
import {getOwn} from "./async-resolution-json-helpers.ts";
import {readAsyncQuestionIn,type StoredAsyncQuestion} from "./async-question-read.ts";
import {selectJob,completionEvidenceGeneration,type StoredQueueJob} from "./queue-read.ts";
import {executionOwnerJobValue} from "./async-resolution-ownership.ts";
import {guardAsyncMutationIn,certifiedAsyncSuccessorIn} from "./async-resolution-guards.ts";
import {receiptRow,receiptText,receiptTextColumns} from "./delivery-receipt-key.ts";
import {decodeI64} from "./sqlite-values.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {withStoreTransaction,rollbackStore,usingInitializedStore,usingExistingStore} from "./owned-scope.ts";
function invalid(message:string):never{throw new StoreIntegrityError(message);}
function scalar(db:DatabaseSync,sql:string,...args:(string|bigint)[]):bigint{const q=db.prepare(sql);q.setReadBigInts(true);return decodeI64(q.get(...args)?.n,"async question guard scalar");}
export function validateAsyncQuestionMappingIn(db:DatabaseSync,q:StoredAsyncQuestion):void{
  const matches=scalar(db,"SELECT COUNT(*)=1 AND MIN(codex_thread_id)=?2 AS n FROM mirror_threads WHERE discord_thread_id=?1",q.channelId,q.threadId);
  const fenced=scalar(db,"SELECT EXISTS(SELECT 1 FROM cdr_cleanup_fences WHERE channel_id=?1) OR EXISTS(SELECT 1 FROM codex_dead_generation_holds WHERE target_thread_id=?2) OR EXISTS(SELECT 1 FROM codex_archive_fences WHERE target_thread_id=?2) AS n",q.channelId,q.threadId);
  if(matches===0n||fenced!==0n)invalid("question mapping changed or target is fenced; no answer sent");
}
export function asyncQuestionRunningMatches(job:StoredQueueJob,q:StoredAsyncQuestion):boolean{return job.jobId===q.originJobId&&job.targetThreadId===q.threadId&&job.channelId===q.channelId&&job.ownerUserId===q.ownerUserId&&job.state==="Running"&&!job.goalWaiting&&job.turnId===q.turnId&&completionEvidenceGeneration(job)===q.generation;}
function ids(db:DatabaseSync,sql:string,...args:string[]):string[]{return db.prepare(sql).all(...args).map(r=>receiptText(r,"id")!);}
export function soleAsyncQuestionOwnerIn(db:DatabaseSync,q:StoredAsyncQuestion):boolean{
  const found=ids(db,`SELECT job_id AS id,CAST(job_id AS BLOB) AS raw_id,(SELECT encoding FROM pragma_encoding) AS encoding FROM codex_turn_queue WHERE target_thread_id=? AND state!='pending'`,q.threadId);
  return found.length===1&&found[0]===q.originJobId;
}
function identity(db:DatabaseSync,q:StoredAsyncQuestion):unknown{
  validateAsyncQuestionMappingIn(db,q);const job=selectJob(db,q.replyJobId??q.originJobId);
  if(job.targetThreadId!==q.threadId||job.channelId!==q.channelId||job.ownerUserId!==q.ownerUserId)invalid("async reply exact job ownership changed");
  if(q.replyJobId!==null){if(scalar(db,"SELECT COUNT(*) AS n FROM codex_turn_queue WHERE target_thread_id=?",q.threadId)!==1n||job.state!=="Quarantined"||job.appServerGeneration!==q.generation)invalid("async reply reservation changed or successor appeared");}
  else if(!asyncQuestionRunningMatches(job,q)||!soleAsyncQuestionOwnerIn(db,q)||!asyncQuestionRunningMatches(selectJob(db,q.originJobId),q))invalid("async steer original turn changed");
  return {question:[q.runtimeId,q.threadId,q.turnId,q.itemId,q.originJobId],generation:q.generation,channel:q.channelId,actor:q.ownerUserId,message:q.messageId,chosen:q.chosen,body:q.body,reply_job_id:q.replyJobId,job:executionOwnerJobValue(job)};
}
export function sealAsyncQuestionIn(db:DatabaseSync,id:string):void{
  const q=readAsyncQuestionIn(db,id),seal={identity:identity(db,q)};db.prepare("UPDATE cdr_async_questions SET preparation_json=? WHERE id=? AND state='dispatching'").run(serializeSerdeValue(seal),id);
}
function verify(db:DatabaseSync,q:StoredAsyncQuestion):void{
  const row=receiptRow(db,`SELECT preparation_json,${receiptTextColumns("preparation_json")} FROM cdr_async_questions WHERE id=?`,q.id);
  if(row===undefined)invalid("async question row not found");const raw=receiptText(row,"preparation_json",true);if(raw===null)invalid("legacy async dispatch has no confirmed preparation; held");
  const wanted=parseSerdeStruct(raw,{fields:[["identity","value"]]}).identity;
  if(!serdeValueEqual(identity(db,q),wanted))invalid("async reply exact identity changed after claim");
}
export function verifyAsyncQuestionIdentityIn(db:DatabaseSync,id:string):void{verify(db,readAsyncQuestionIn(db,id));}
/** Caller supplies one snapshot. Historical submitted questions are not live authority. */
export function validateAsyncDispatchGuardsIn(db:DatabaseSync,thread:string):void{
  guardAsyncMutationIn(db,thread);
  const selected=ids(db,`SELECT q.id,CAST(q.id AS BLOB) AS raw_id,(SELECT encoding FROM pragma_encoding) AS encoding FROM cdr_async_questions q WHERE q.thread_id=? AND (q.state='dispatching' OR EXISTS(SELECT 1 FROM cdr_async_unsettled_obligations o WHERE o.thread_id=q.thread_id AND o.question_id=q.id))`,thread);
  for(const id of selected){const q=readAsyncQuestionIn(db,id);if(certifiedAsyncSuccessorIn(db,thread,id)){validateAsyncQuestionMappingIn(db,q);if(!soleAsyncQuestionOwnerIn(db,q))invalid("async successor current execution ownership is not unique");}else verify(db,q);}
}
/** Source read guard drops its Deferred transaction; it never commits mutations. */
function on(db:DatabaseSync,thread:string):void{withStoreTransaction(db,"DEFERRED",()=>{validateAsyncDispatchGuardsIn(db,thread);return rollbackStore(undefined);});}
export function validateAsyncDispatchGuardsExisting(path:string,thread:string):void{usingExistingStore(path,db=>on(db,thread));}
export async function validateAsyncDispatchGuards(path:string,thread:string):Promise<void>{return usingInitializedStore(path,db=>on(db,thread));}
