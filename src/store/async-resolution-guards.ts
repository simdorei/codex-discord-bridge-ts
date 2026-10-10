import type {DatabaseSync} from "node:sqlite";
import {parseSerdeValue} from "../core/serde-json-parse.ts";
import {asyncRecoveryPolicyHeldIn} from "./async-resolution-policy.ts";
import {readAsyncObligationsIn} from "./async-resolution-records.ts";
import {exactAsyncOwnerIn} from "./async-resolution-ownership.ts";
import {AsyncResolutionHeldError} from "./async-resolution-admission.ts";
import {decodeBool} from "./sqlite-values.ts";
function sealed(value:string|null):boolean{
  if(value===null||Buffer.byteLength(value)>131072)return false;
  try{const parsed=parseSerdeValue(value);return parsed!==null&&typeof parsed==="object"&&!Array.isArray(parsed)&&Object.keys(parsed).length>0;}catch{return false;}
}
/** Current execution may finish its lifecycle; this is not authority for a new answer. */
export function guardAsyncMutationIn(db:DatabaseSync,thread:string):void{
  if(asyncRecoveryPolicyHeldIn(db,thread))throw new AsyncResolutionHeldError(thread,"reviewed publishing recovery policy remains held; no unscoped mutation or replay");
  for(const row of readAsyncObligationsIn(db,thread)){
    if(row.version!==1n||row.revision<0n||Buffer.byteLength(row.claim)>131072||!sealed(row.original_seal))throw new AsyncResolutionHeldError(thread,"invalid or unsupported original claim evidence");
    if(row.policy!=="ordinary"||row.execution_state!=="unresolved"||row.admission_state!=="held"||!exactAsyncOwnerIn(db,row))throw new AsyncResolutionHeldError(thread,"originating execution has no exact live owner; terminal reconciliation required; no automatic retry");
  }
}
export function certifiedAsyncSuccessorIn(db:DatabaseSync,thread:string,question:string):boolean{
  if(typeof question!=="string"||/[\uD800-\uDFFF]/u.test(question))throw new TypeError("Expected question identity");
  const row=readAsyncObligationsIn(db,thread).find(r=>r.question_id===question);if(row===undefined||row.version!==1n||row.policy!=="ordinary"||row.execution_state!=="unresolved"||row.admission_state!=="held")return false;
  const q=db.prepare("SELECT EXISTS(SELECT 1 FROM cdr_async_execution_handoffs WHERE question_id=? AND revision=?) AS yes");q.setReadBigInts(true);
  return decodeBool(q.get(question,row.revision)?.yes,"certified handoff")&&exactAsyncOwnerIn(db,row);
}
