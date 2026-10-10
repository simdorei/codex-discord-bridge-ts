import type {DatabaseSync} from "node:sqlite";
import {decodeQuestionBody,type QuestionBody} from "./async-question-body.ts";
import {receiptRow,receiptText,receiptTextColumns} from "./delivery-receipt-key.ts";
import {decodeI64,decodeOptionalI64} from "./sqlite-values.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
export interface StoredAsyncQuestion{
  readonly id:string;readonly runtimeId:string;readonly generation:bigint;readonly threadId:string;readonly turnId:string;readonly itemId:string;readonly originJobId:string;
  readonly channelId:bigint;readonly ownerUserId:bigint;readonly body:QuestionBody;readonly state:string;readonly messageId:string|null;readonly chosen:bigint|null;readonly replyJobId:string|null;readonly error:string;
}
/** Node get() returns undefined for absence; this typed adapter is not a native SQLite exception. */
export class AsyncQuestionNotFoundError extends Error{readonly kind="QueryReturnedNoRows";constructor(){super("async question row not found");this.name="AsyncQuestionNotFoundError";}}
/** Borrowed immutable occurrence read only; does not confirm ownership or authorize dispatch. */
export function readAsyncQuestionIn(db:DatabaseSync,id:string):StoredAsyncQuestion{
  if(typeof id!=="string"||/[\uD800-\uDFFF]/u.test(id))throw new TypeError("Expected well-formed question identity");
  const row=receiptRow(db,`SELECT runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,state,message_id,chosen,reply_job_id,error,
    ${receiptTextColumns("runtime_id","thread_id","turn_id","item_id","origin_job_id","body","state","message_id","reply_job_id","error")} FROM cdr_async_questions WHERE id=?`,id);
  if(row===undefined)throw new AsyncQuestionNotFoundError();
  // Preserve row decoder order: body JSON is parsed only after every scalar column.
  const runtimeId=receiptText(row,"runtime_id")!,generation=decodeI64(row.generation,"generation"),threadId=receiptText(row,"thread_id")!,turnId=receiptText(row,"turn_id")!,itemId=receiptText(row,"item_id")!,originJobId=receiptText(row,"origin_job_id")!,channelId=decodeI64(row.channel_id,"channel_id"),ownerUserId=decodeI64(row.owner_user_id,"owner_user_id");
  const state=receiptText(row,"state")!,messageId=receiptText(row,"message_id",true),chosen=decodeOptionalI64(row.chosen,"chosen");
  if(chosen!==null&&(chosen<0n||chosen>65535n))throw new StoreIntegrityError("async question chosen is outside u16 range");
  const replyJobId=receiptText(row,"reply_job_id",true),error=receiptText(row,"error")!,payload=receiptText(row,"body")!;
  return {id,runtimeId,generation,threadId,turnId,itemId,originJobId,channelId,ownerUserId,body:decodeQuestionBody(payload),state,messageId,chosen,replyJobId,error};
}
