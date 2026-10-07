import { isDeepStrictEqual } from "node:util";
import { parseSerdeValue } from "../core/serde-json-parse.ts";
import { getOwn,asI64,asU64 } from "./async-resolution-json-helpers.ts";
import { AsyncResolutionHeldError } from "./async-resolution-admission.ts";
import type { AsyncObligation } from "./async-resolution-records.ts";
import { decodeQuestionBody,answerPrompt,type SealedQuestion } from "./async-question-body.ts";

/** Pure validation of the complete immutable original question seal, never a live authority grant. */
export function originalHistoricalQuestion(row:AsyncObligation):SealedQuestion {
  const invalid=():never=>{throw new AsyncResolutionHeldError(row.thread_id,"historical review requires the complete immutable original question seal");};
  if(row.version!==1n||row.revision<0n) invalid();
  const claim:unknown=parseSerdeValue(row.claim);
  const seal:unknown=parseSerdeValue(row.original_seal ?? invalid());
  const string=(key:string):string=>{const value=getOwn(claim,key);return typeof value==="string"?value:invalid();};
  const integer=(key:string):bigint=>{const value=asI64(getOwn(claim,key));return value===undefined?invalid():value;};
  const body=decodeQuestionBody(string("body")),chosen=asU64(getOwn(claim,"chosen")) ?? invalid();
  const q:SealedQuestion={id:string("id"),runtime_id:string("runtime_id"),generation:integer("generation"),thread_id:string("thread_id"),
    turn_id:string("turn_id"),item_id:string("item_id"),origin_job_id:string("origin_job_id"),channel_id:integer("channel_id"),
    owner_user_id:integer("owner_user_id"),body,message_id:string("message_id"),chosen};
  const job=getOwn(getOwn(seal,"identity"),"job")??null;
  const identity={question:[q.runtime_id,q.thread_id,q.turn_id,q.item_id,q.origin_job_id],generation:q.generation,
    channel:q.channel_id,actor:q.owner_user_id,message:q.message_id,chosen:q.chosen,body:q.body,reply_job_id:null,job};
  if(q.id!==row.question_id||q.thread_id!==row.thread_id||q.turn_id!==row.turn_id||q.origin_job_id!==row.origin_job_id||
    getOwn(claim,"dispatch_mode")!=="steer"||q.generation<0n||q.channel_id<=0n||q.owner_user_id<=0n||
    !isDeepStrictEqual(getOwn(seal,"identity"),identity)||getOwn(job,"job_id")!==q.origin_job_id||
    getOwn(job,"target_thread_id")!==q.thread_id||getOwn(job,"channel_id")!==q.channel_id||
    getOwn(job,"owner_user_id")!==q.owner_user_id||getOwn(job,"turn_id")!==q.turn_id||Buffer.byteLength(answerPrompt(q,chosen))>65536) invalid();
  return q;
}
