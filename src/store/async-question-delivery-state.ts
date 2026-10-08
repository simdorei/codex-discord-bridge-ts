import {openInitialized} from "./owned-driver.ts";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {usingInitializedStore,withStoreTransaction,commitStore,rollbackStore} from "./owned-scope.ts";
import {receiptRow,receiptText,receiptTextColumns} from "./delivery-receipt-key.ts";
import {decodeI64} from "./sqlite-values.ts";
import {readAsyncQuestionIn,AsyncQuestionNotFoundError,type StoredAsyncQuestion} from "./async-question-read.ts";
import {asyncQuestionRunningMatches,soleAsyncQuestionOwnerIn,validateAsyncQuestionMappingIn} from "./async-question-guard.ts";
import {selectJob} from "./queue-read.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
export const ASYNC_QUESTION_DELIVERY_DOMAIN="async-question-v1";
function text(v:unknown):asserts v is string{if(typeof v!=="string"||/[\uD800-\uDFFF]/u.test(v))throw new TypeError("Expected well-formed question identity");}
export async function getAsyncQuestion(path:string,id:string):Promise<StoredAsyncQuestion>{text(id);return usingInitializedStore(path,db=>readAsyncQuestionIn(db,id));}
export async function pendingAsyncQuestions(path:string,runtime:string):Promise<StoredAsyncQuestion[]>{
  text(runtime);return usingInitializedStore(path,db=>{
    const ids=db.prepare(`SELECT id,${receiptTextColumns("id")} FROM cdr_async_questions WHERE runtime_id=? AND state='observed' ORDER BY created_at,json_extract(body,'$.index'),id LIMIT 100`).all(runtime).map(r=>receiptText(r,"id")!);
    return ids.map(id=>readAsyncQuestionIn(db,id));
  });
}
/** Only original pinned row identity is needed. Never turns generationless outbox into ownership. */
export async function confirmAsyncQuestionOwner(path:string,id:string):Promise<boolean>{
  text(id);return usingInitializedStore(path,db=>withStoreTransaction(db,"IMMEDIATE",()=>{
    const row=receiptRow(db,"SELECT owner_confirmed FROM cdr_async_questions WHERE id=?",id);if(row===undefined)throw new AsyncQuestionNotFoundError();
    if(decodeI64(row.owner_confirmed,"owner_confirmed")!==0n)return rollbackStore(true);
    const q=readAsyncQuestionIn(db,id),confirmed=soleAsyncQuestionOwnerIn(db,q)&&asyncQuestionRunningMatches(selectJob(db,q.originJobId),q);
    if(confirmed)db.prepare("UPDATE cdr_async_questions SET owner_confirmed=1 WHERE id=?").run(id);
    return commitStore(confirmed);
  }));
}
export async function requireCurrentAsyncQuestionMapping(path:string,input:StoredAsyncQuestion):Promise<void>{
  const q=cloneOwnedSerdeValue(input) as StoredAsyncQuestion;return usingInitializedStore(path,db=>validateAsyncQuestionMappingIn(db,q));
}
export function asyncQuestionReceiptKey(q:Pick<StoredAsyncQuestion,"channelId"|"id">):string{
  const own=cloneOwnedSerdeValue(q) as typeof q;text(own.id);if(typeof own.channelId!=="bigint"||own.channelId<-(1n<<63n)||own.channelId>=(1n<<63n))throw new TypeError("Expected i64 question channel");
  return serializeSerdeValue([own.channelId,ASYNC_QUESTION_DELIVERY_DOMAIN,own.id,0n]);
}
/** Reads only a durable HTTP receipt. Keeps source outer read connection + separate
 * ownership transaction; a later state change prevents observed-only binding. */
export async function bindAsyncQuestionReceipt(path:string,id:string,interactive:boolean):Promise<void>{
  text(id);if(typeof interactive!=="boolean")throw new TypeError("Expected interactive flag");
  // Source keeps the outer connection open across owner confirmation. Owned scopes
  // are synchronous, so open ownership explicitly and close in finally around await.
  const db=await openInitialized(path);
  try{
    const q=readAsyncQuestionIn(db,id);if(!await confirmAsyncQuestionOwner(path,q.id))throw new StoreIntegrityError("question original turn ownership is not confirmed");
    const receipt=receiptRow(db,`SELECT message_id,${receiptTextColumns("message_id")} FROM codex_delivery_receipts WHERE receipt_key=?`,asyncQuestionReceiptKey(q));
    const message=receipt===undefined?null:receiptText(receipt,"message_id",true);if(message===null)throw new StoreIntegrityError("question message receipt is not confirmed");
    db.prepare("UPDATE cdr_async_questions SET message_id=?,state=? WHERE id=? AND state='observed'").run(message,interactive?"open":"unsupported",id);
  }finally{db.close();}
}
