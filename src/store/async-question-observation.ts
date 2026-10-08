import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {rustTrim} from "../app-server/value.ts";
import {decodeQuestionBody,type QuestionBody} from "./async-question-body.ts";
import {receiptRow,receiptText,receiptTextColumns} from "./delivery-receipt-key.ts";
import {decodeI64,decodeOptionalI64} from "./sqlite-values.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {usingInitializedStore,withStoreTransaction,commitStore,rollbackStore} from "./owned-scope.ts";
import {reconcileAsyncQuestionsIn} from "./async-question-inbox.ts";
export interface NewAsyncQuestion{readonly runtime_id:string;readonly generation:bigint;readonly thread_id:string;readonly turn_id:string;readonly item_id:string;readonly body:QuestionBody;readonly now:number}
const text=(v:unknown):v is string=>typeof v==="string"&&!/[\uD800-\uDFFF]/u.test(v);
/** Rust tuple SHA; pinned 64-bit usize profile. Content and owner are deliberately not part of identity. */
export function asyncQuestionOccurrenceId(thread:string,turn:string,item:string,index:bigint):string{
  if(!text(thread)||!text(turn)||!text(item)||typeof index!=="bigint"||index<0n||index>=(1n<<64n))throw new TypeError("Expected original question occurrence identity");
  return createHash("sha256").update(serializeSerdeValue([thread,turn,item,index])).digest("hex");
}
function snapshot(input:NewAsyncQuestion):{n:NewAsyncQuestion;body:string;id:string}{
  const n=cloneOwnedSerdeValue(input) as NewAsyncQuestion;
  // Typed QuestionBody admission followed by exact derived-struct field order, not Value key order.
  const b=decodeQuestionBody(serializeSerdeValue(n.body));
  const body=`{"index":${serializeSerdeValue(b.index)},"source_text":${serializeSerdeValue(b.source_text)},"title":${serializeSerdeValue(b.title)},"options":${serializeSerdeValue(b.options)}}`;
  if(Buffer.byteLength(body)>32768||!text(n.runtime_id)||n.runtime_id.length===0||typeof n.now!=="number"||!Number.isFinite(n.now)||typeof n.generation!=="bigint"||n.generation<0n||n.generation>=(1n<<63n)||![n.thread_id,n.turn_id,n.item_id].every(v=>text(v)&&rustTrim(v)!==""))throw new StoreIntegrityError("invalid or oversized async question");
  return {n:{...n,body:b},body,id:asyncQuestionOccurrenceId(n.thread_id,n.turn_id,n.item_id,b.index)};
}
/** Observation is immutable candidate data, never permission to display or dispatch. */
export async function recordAsyncQuestionObservation(path:string,input:NewAsyncQuestion):Promise<void>{
  const {n,body,id}=snapshot(input);
  await usingInitializedStore(path,db=>withStoreTransaction(db,"IMMEDIATE",()=>{
    const existing=receiptRow(db,`SELECT body,${receiptTextColumns("body")} FROM (SELECT body FROM cdr_async_questions WHERE id=? UNION ALL SELECT body FROM cdr_async_question_inbox WHERE id=? LIMIT 1)`,id,id);
    if(existing!==undefined){if(!isDeepStrictEqual(decodeQuestionBody(receiptText(existing,"body")!),n.body))throw new StoreIntegrityError("async question occurrence changed its content");return rollbackStore(undefined);}
    const q=db.prepare(`SELECT job_id,channel_id,owner_user_id,app_server_generation,execution_generation,attempt_count,${receiptTextColumns("job_id")} FROM codex_turn_queue WHERE target_thread_id=? AND state!='pending'`);q.setReadBigInts(true);
    // Decode every row before testing uniqueness, matching Rust collect-before-match.
    const jobs=q.all(n.thread_id).map(row=>({job:receiptText(row,"job_id")!,channel:decodeI64(row.channel_id,"channel_id"),owner:decodeOptionalI64(row.owner_user_id,"owner_user_id"),generation:decodeI64(row.app_server_generation,"app_server_generation"),execution:decodeOptionalI64(row.execution_generation,"execution_generation"),attempt:decodeI64(row.attempt_count,"attempt_count")}));
    if(jobs.length!==1||jobs[0]!.owner===null)throw new StoreIntegrityError("async question has no unique original Discord job candidate; no controls sent");
    const owner=jobs[0]!;
    db.prepare("INSERT INTO cdr_async_question_inbox (id,runtime_id,generation,thread_id,turn_id,item_id,candidate_job_id,candidate_channel_id,candidate_owner_id,body,created_at,candidate_generation,candidate_execution_generation,candidate_attempt_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,n.runtime_id,n.generation,n.thread_id,n.turn_id,n.item_id,owner.job,owner.channel,owner.owner,body,n.now,owner.generation,owner.execution,owner.attempt);
    return commitStore(undefined);
  }));
}
export async function reconcileAsyncQuestionObservations(path:string,runtime:string,generation:bigint):Promise<bigint>{
  if(!text(runtime)||typeof generation!=="bigint"||generation<-(1n<<63n)||generation>=(1n<<63n))throw new TypeError("Expected typed observation scope");
  return usingInitializedStore(path,db=>withStoreTransaction(db,"IMMEDIATE",()=>commitStore(reconcileAsyncQuestionsIn(db,runtime,generation,null))));
}
export async function observeAsyncQuestion(path:string,input:NewAsyncQuestion):Promise<string>{
  const {n,id}=snapshot(input);await recordAsyncQuestionObservation(path,n);await reconcileAsyncQuestionObservations(path,n.runtime_id,n.generation);return id;
}
