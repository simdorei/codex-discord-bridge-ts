import {parseSerdeStruct,type StructShape} from "../core/serde-struct-json.ts";
import {randomUUID} from "node:crypto";
import type {DatabaseSync,SQLInputValue} from "node:sqlite";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {parseSerdeValue} from "../core/serde-json-parse.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {invokeSynchronousVoid} from "../core/synchronous-void.ts";
import {I64_MIN,I64_MAX} from "../protocol/ids.ts";
import {getOwn} from "./async-resolution-json-helpers.ts";
import {selectJob,serializeStoredQueueJob,completionEvidenceGeneration} from "./queue-read.ts";
import {validateStopBindingIn,stopHoldSnapshotIn} from "./stop-custody-common.ts";
import {usingExistingStore,withStoreTransaction,commitStore,rollbackStore} from "./owned-scope.ts";
import {decodeI64} from "./sqlite-values.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";

export interface StopControl {readonly operation_id:string;readonly target:string;readonly channel:bigint;readonly owner:bigint;readonly resident:string;readonly generation:bigint;readonly turn:string;readonly binding:unknown;readonly jobs:readonly string[];readonly can_settle:boolean}
export interface StopClaim{readonly control:StopControl;readonly token:string}
export interface StopWireOwner{readonly resident:string;readonly generation:bigint}
export interface StopWireRequest{readonly attempt:string;readonly wire:string}
const fields=["operation_id","target","channel","owner","resident","generation","turn","binding","jobs","can_settle"] as const;
function refused():never{throw new StoreIntegrityError("original stop control authority differs; no interrupt or replay");}
function text(v:unknown):v is string{return typeof v==="string"&&!/[\uD800-\uDFFF]/u.test(v);}
function i64(v:unknown):v is bigint{return typeof v==="bigint"&&v>=I64_MIN&&v<=I64_MAX;}
/** Rust derives Deserialize without deny_unknown_fields; ignore extras after a safe copy. */
function control(input:unknown):StopControl{
  const value=cloneOwnedSerdeValue(input),result=Object.create(null) as Record<string,unknown>;
  for(const key of fields)result[key]=getOwn(value,key);
  for(const key of ["operation_id","target","resident","turn"])if(!text(result[key]))refused();
  for(const key of ["channel","owner","generation"])if(!i64(result[key]))refused();
  if(result.binding===undefined||!Array.isArray(result.jobs)||result.jobs.some(v=>!text(v))||typeof result.can_settle!=="boolean")refused();
  return Object.freeze(result) as unknown as StopControl;
}
function claimValue(input:unknown):StopClaim{const value=cloneOwnedSerdeValue(input),c=control(getOwn(value,"control")),token=getOwn(value,"token");if(!text(token))refused();return Object.freeze({control:c,token});}
function original(c:StopControl):string{return `{${fields.map(k=>`${JSON.stringify(k)}:${serializeSerdeValue(c[k])}`).join(",")}}`;}
function scalar(db:DatabaseSync,sql:string,...args:SQLInputValue[]):bigint{const q=db.prepare(sql);q.setReadBigInts(true);return decodeI64(q.get(...args)?.n,"stop control scalar");}
function retained(db:DatabaseSync,c:StopControl):boolean{return scalar(db,"SELECT EXISTS(SELECT 1 FROM cdr_stop_controls WHERE operation_id=? AND target_thread_id=? AND resident_owner=? AND generation=? AND turn_id=? AND record_json=?) AS n",c.operation_id,c.target,c.resident,c.generation,c.turn,original(c))!==0n;}
function validateOriginal(db:DatabaseSync,c:StopControl):void{
  if(!retained(db,c))refused();validateStopBindingIn(db,c.target,c.channel,c.binding);
  if(scalar(db,"SELECT EXISTS(SELECT 1 FROM codex_archive_fences WHERE target_thread_id=?1) OR EXISTS(SELECT 1 FROM codex_observed_completions WHERE thread_id=?1 AND turn_id=?2) AS n",c.target,c.turn)!==0n)refused();
  const jobs=c.jobs.map(raw=>({raw,value:parseSerdeValue(raw)})),running=jobs.filter(j=>getOwn(j.value,"state")==="Running");
  if(running.length!==1)refused();const selected=running[0]!,id=getOwn(selected.value,"job_id");if(typeof id!=="string")refused();const current=selectJob(db,id);
  if(serializeStoredQueueJob(current)!==selected.raw||completionEvidenceGeneration(current)!==c.generation||current.turnId!==c.turn||current.channelId!==c.channel||current.ownerUserId!==c.owner)refused();
  for(const j of jobs){const id=getOwn(j.value,"job_id");if(typeof id!=="string"||stopHoldSnapshotIn(db,id)?.[0]!==c.target)refused();}
}
function owner(input:StopWireOwner):StopWireOwner{const v=cloneOwnedSerdeValue(input) as StopWireOwner;if(v===null||typeof v!=="object"||!text(v.resident)||!i64(v.generation))refused();return v;}
function wire(input:StopWireRequest):StopWireRequest{const v=cloneOwnedSerdeValue(input) as StopWireRequest;if(v===null||typeof v!=="object"||!text(v.attempt)||!text(v.wire))refused();return v;}
function validate(db:DatabaseSync,c:StopClaim,o:StopWireOwner,params:unknown):void{
  if(c.control.resident!==o.resident||c.control.generation!==o.generation||getOwn(params,"threadId")!==c.control.target||getOwn(params,"turnId")!==c.control.turn||c.token==="")refused();
  validateOriginal(db,c.control);if(scalar(db,"SELECT EXISTS(SELECT 1 FROM cdr_stop_controls WHERE operation_id=? AND phase='dispatching' AND claim_token=?) AS n",c.control.operation_id,c.token)===0n)refused();
}
export function validateStopClaimIn(db:DatabaseSync,input:unknown,owned:StopWireOwner,inputParams:unknown):StopClaim{const c=claimValue(input),o=owner(owned),params=cloneOwnedSerdeValue(inputParams);validate(db,c,o,params);return c;}
function existing<T>(path:string,operation:(db:DatabaseSync)=>T):T{return usingExistingStore(path,db=>{db.exec("PRAGMA busy_timeout=500");return operation(db);});}
export function claimStopControl(path:string,input:unknown,checkSelected:()=>void):StopClaim|null{
  const c=control(input);
  return existing(path,db=>withStoreTransaction(db,"IMMEDIATE",()=>{
    validateOriginal(db,c);invokeSynchronousVoid(checkSelected,{},[]);const claim=Object.freeze({control:c,token:randomUUID()});
    const r=db.prepare("UPDATE cdr_stop_controls SET phase='dispatching',claim_token=? WHERE operation_id=? AND phase='accepted' AND NOT EXISTS(SELECT 1 FROM cdr_stop_controls WHERE target_thread_id=? AND resident_owner=? AND generation=? AND turn_id=? AND claim_token IS NOT NULL)").run(claim.token,c.operation_id,c.target,c.resident,c.generation,c.turn);
    if(BigInt(r.changes)!==1n)return rollbackStore(null);
    validate(db,claim,{resident:c.resident,generation:c.generation},{threadId:c.target,turnId:c.turn});invokeSynchronousVoid(checkSelected,{},[]);return commitStore(claim);
  }));
}
function wireMatches(db:DatabaseSync,c:StopClaim,o:StopWireOwner,r:StopWireRequest):boolean{return scalar(db,"SELECT EXISTS(SELECT 1 FROM cdr_stop_controls WHERE operation_id=? AND resident_owner=? AND generation=? AND claim_token=? AND wire_attempt=? AND wire_id=?) AS n",c.control.operation_id,o.resident,o.generation,c.token,r.attempt,r.wire)!==0n;}
export function beginStopWire(path:string,value:unknown,inputOwner:StopWireOwner,inputRequest:StopWireRequest,inputParams:unknown):void{
  const c=claimValue(value),o=owner(inputOwner),r=wire(inputRequest),params=cloneOwnedSerdeValue(inputParams);
  existing(path,db=>withStoreTransaction(db,"IMMEDIATE",()=>{
    validate(db,c,o,params);
    if(r.attempt===""||r.wire===""||BigInt(db.prepare("UPDATE cdr_stop_controls SET wire_attempt=?,wire_id=? WHERE operation_id=? AND claim_token=? AND phase='dispatching' AND wire_attempt IS NULL AND wire_id IS NULL").run(r.attempt,r.wire,c.control.operation_id,c.token).changes)!==1n)refused();
    validate(db,c,o,params);if(!wireMatches(db,c,o,r))refused();return commitStore(undefined);
  }));
}
export function finishStopWire(path:string,value:unknown,inputOwner:StopWireOwner,inputRequest:StopWireRequest,outcome:string):void{
  if(!["not_sent","reply_ok","reply_error"].includes(outcome))refused();const c=claimValue(value),o=owner(inputOwner),r=wire(inputRequest);
  existing(path,db=>withStoreTransaction(db,"IMMEDIATE",()=>{
    if(!retained(db,c.control)||!wireMatches(db,c,o,r))refused();
    db.prepare("UPDATE cdr_stop_controls SET phase=CASE WHEN phase='settled' THEN phase ELSE ? END,last_error=? WHERE operation_id=? AND claim_token=?").run(outcome==="reply_ok"?"acknowledged":"unknown",outcome,c.control.operation_id,c.token);
    // Preserve source postcondition: exact wire identity, not a new current-job claim.
    if(!wireMatches(db,c,o,r))refused();return commitStore(undefined);
  }));
}
export function recordStopControlError(path:string,value:unknown,error:string):void{const c=claimValue(value);if(!text(error))refused();const bounded=Array.from(error).slice(0,1000).join("");existing(path,db=>{db.prepare("UPDATE cdr_stop_controls SET phase='unknown',last_error=? WHERE operation_id=? AND claim_token=? AND phase='dispatching'").run(bounded,c.control.operation_id,c.token);});}

/** Shared exact source struct serialization and retained receipt check. */
export function serializeStopControl(input:unknown):string{return original(control(input));}
export function retainedStopControlIn(db:DatabaseSync,input:unknown):boolean{return retained(db,control(input));}

const CONTROL_SHAPE:StructShape={fields:fields.map(key=>[key,key==="binding"?"value":key==="jobs"?"string[]":key==="can_settle"?"bool":["channel","owner","generation"].includes(key)?"i64":"string"] as const)};
/** Decode the raw derived struct, not a lossy Value intermediary. */
export function parseStopControlJson(raw:string):StopControl{return control(parseSerdeStruct(raw,CONTROL_SHAPE));}
