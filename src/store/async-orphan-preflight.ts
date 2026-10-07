import type {DatabaseSync} from "node:sqlite";
import {readAsyncObligationsIn,type AsyncObligation} from "./async-resolution-records.ts";
import {originalHistoricalQuestion,historicalQuestionDecodeFailure} from "./async-history-question.ts";
import {AsyncResolutionHeldError} from "./async-resolution-admission.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {decodeI64} from "./sqlite-values.ts";
const ROWS=128n,BYTES=2n*1024n*1024n;
const SIZES=`SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM (
  SELECT COALESCE(length(CAST(question_id AS BLOB)),0)+COALESCE(length(CAST(thread_id AS BLOB)),0)
    +COALESCE(length(CAST(origin_job_id AS BLOB)),0)+COALESCE(length(CAST(turn_id AS BLOB)),0)
    +COALESCE(length(CAST(answer_state AS BLOB)),0)+COALESCE(length(CAST(execution_state AS BLOB)),0)
    +COALESCE(length(CAST(admission_state AS BLOB)),0)+COALESCE(length(CAST(policy AS BLOB)),0)
    +COALESCE(length(CAST(original_seal AS BLOB)),0)+COALESCE(length(CAST(claim_json AS BLOB)),0)
    +COALESCE(length(CAST(owner_json AS BLOB)),0)+COALESCE(length(CAST(original_error AS BLOB)),0) AS bytes
  FROM cdr_async_unsettled_obligations WHERE thread_id=?1 ORDER BY question_id LIMIT ?2)`;
function refused(row:AsyncObligation):boolean{
  try{originalHistoricalQuestion(row);return false;}catch(error){
    if(error instanceof AsyncResolutionHeldError||historicalQuestionDecodeFailure(error)||
      (error instanceof StoreIntegrityError&&error.result==="invalid sealed answer option"))return true;
    throw error;
  }
}
/** Negative input positions only. Caller owns one read snapshot. No execution authority.
 * Row/byte probes precede all stored claim/seal materialization. */
export function unprovableAsyncOrphansIn(db:DatabaseSync,targets:readonly string[]):number[]{
  for(const target of targets)if(typeof target!=="string"||/[\uD800-\uDFFF]/u.test(target))throw new TypeError("Expected well-formed orphan target");
  let remainingRows=ROWS,remainingBytes=BYTES;const negative:number[]=[],sizes=db.prepare(SIZES);sizes.setReadBigInts(true);
  for(let index=0;index<targets.length;index++){
    if(remainingRows===0n)break;
    const row=sizes.get(targets[index]!,remainingRows+1n),count=decodeI64(row?.count,"orphan row count"),bytes=decodeI64(row?.bytes,"orphan byte count");
    if(count<0n)throw new StoreIntegrityError("orphan preflight row count is out of range");
    if(bytes<0n)throw new StoreIntegrityError("orphan preflight byte count is out of range");
    if(count>remainingRows){remainingRows=0n;continue;}
    remainingRows-=count;if(count===0n||bytes>remainingBytes)continue;
    const rows=readAsyncObligationsIn(db,targets[index]!);
    if(BigInt(rows.length)!==count)throw new StoreIntegrityError("orphan preflight evidence set changed inside its snapshot");
    remainingBytes-=bytes;
    for(const item of rows)if(refused(item)){negative.push(index);break;}
  }
  return negative;
}
