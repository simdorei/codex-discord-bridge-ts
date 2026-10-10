import {openInitialized} from "./owned-driver.ts";
import {snapshotCompletionEntry,currentCompletionEntryIn,equalCompletionEntry,type CompletionEntry} from "./completion-metadata.ts";
import {MAX_COMPLETION_PAYLOAD_BYTES} from "./completion-metadata-sql.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {receiptRow,receiptText,receiptTextColumns} from "./delivery-receipt-key.ts";
import {decodeI64} from "./sqlite-values.ts";
import {selectDelivery,type StoredDelivery} from "./delivery.ts";
import {readAsyncQuestionIn,type StoredAsyncQuestion} from "./async-question-read.ts";
import type {PendingCommentary} from "./commentary-outbox.ts";
import type {PendingGoalProgress} from "./goal-progress.ts";
import type {StartNotice} from "./start-notice-outbox.ts";
export type CompletionPayload=
  |{kind:"Observed";generation:bigint;json:string}
  |{kind:"Commentary";value:PendingCommentary}|{kind:"Goal";value:PendingGoalProgress}
  |{kind:"StartFailure";value:StartNotice}|{kind:"Question";value:StoredAsyncQuestion}|{kind:"Final";value:StoredDelivery};
/** Revalidate exact source-head metadata and selected body byte bound before loading.
 * Metadata equality is not a content hash or receipt authorization. */
export async function loadCompletionPayload(path:string,input:CompletionEntry,runtime:string,generation:bigint):Promise<CompletionPayload|null>{
  const entry=snapshotCompletionEntry(input);for(const value of [path,runtime])if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed payload scope");
  if(typeof generation!=="bigint"||generation<-(1n<<63n)||generation>=(1n<<63n))throw new TypeError("Expected i64 payload generation");
  const db=await openInitialized(path);
  try{
    db.exec("BEGIN DEFERRED");const actual=currentCompletionEntryIn(db,entry,runtime,generation);
    if(actual===null||!equalCompletionEntry(actual,entry))return null;
    if(actual.bytes>BigInt(MAX_COMPLETION_PAYLOAD_BYTES))throw new StoreIntegrityError("completion payload exceeds in-memory budget; durable evidence retained");
    const required=(row:Record<string,unknown>|undefined):Record<string,unknown>=>{if(row===undefined)throw new StoreIntegrityError("completion payload disappeared inside read snapshot");return row;};
    switch(entry.source){
      case "Queue":case "AsyncOrphan":return null;
      case "Observed":{
        const row=required(receiptRow(db,`SELECT generation,payload,${receiptTextColumns("payload")} FROM codex_observed_completions WHERE thread_id=? AND turn_id=?`,entry.target,entry.turn));
        return {kind:"Observed",generation:decodeI64(row.generation,"generation"),json:receiptText(row,"payload")!};
      }
      case "Commentary":{
        const row=required(receiptRow(db,`SELECT sequence,job_id,target_thread_id,turn_id,channel_id,text,${receiptTextColumns("job_id","target_thread_id","turn_id","text")} FROM codex_commentary_outbox WHERE sequence=?`,entry.id));
        return {kind:"Commentary",value:{sequence:decodeI64(row.sequence,"sequence"),jobId:receiptText(row,"job_id")!,threadId:receiptText(row,"target_thread_id")!,turnId:receiptText(row,"turn_id")!,channelId:decodeI64(row.channel_id,"channel_id"),text:receiptText(row,"text")!}};
      }
      case "Goal":{
        const row=required(receiptRow(db,`SELECT thread,turn,channel,content,last_error,job_id,${receiptTextColumns("thread","turn","content","last_error","job_id")} FROM codex_goal_progress WHERE thread=? AND turn=?`,entry.target,entry.turn));
        return {kind:"Goal",value:{thread:receiptText(row,"thread")!,turn:receiptText(row,"turn")!,channel:decodeI64(row.channel,"channel"),content:receiptText(row,"content")!,lastError:receiptText(row,"last_error")!,jobId:receiptText(row,"job_id",true)}};
      }
      case "StartFailure":{
        const row=required(receiptRow(db,`SELECT job_id,target_thread_id,channel_id,content,${receiptTextColumns("job_id","target_thread_id","content")} FROM codex_reserve_start_notices WHERE job_id=?`,entry.id));
        return {kind:"StartFailure",value:{jobId:receiptText(row,"job_id")!,threadId:receiptText(row,"target_thread_id")!,channelId:decodeI64(row.channel_id,"channel_id"),content:receiptText(row,"content")!}};
      }
      case "Question":return {kind:"Question",value:readAsyncQuestionIn(db,entry.id)};
      case "Final":return {kind:"Final",value:selectDelivery(db,entry.id)};
      default:{const unexpected:never=entry.source;throw new StoreIntegrityError(`Unknown payload source: ${unexpected}`);}
    }
  }finally{if(db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close abandons read */}}db.close();}
}
