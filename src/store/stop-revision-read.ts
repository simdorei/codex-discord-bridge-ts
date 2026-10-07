import {types} from "node:util";
import {DatabaseSync} from "node:sqlite";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {decodeI64,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {asI64,getOwn} from "./async-resolution-json-helpers.ts";
import type {StoredIngress} from "./ingress-read.ts";
const refused=()=>new StoreIntegrityError("original RPC predates stop or stop revision evidence differs; no dispatch");
function requireText(value:unknown):asserts value is string{
  if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed text");
}
function requireTarget(target:unknown):void{if(target!==null)requireText(target);}
function originRevision(origin:unknown,target:string|null):bigint{
  if(origin===null||typeof origin!=="object"||types.isProxy(origin)||Array.isArray(origin)||Reflect.ownKeys(origin).length!==2)throw refused();
  const t=Object.getOwnPropertyDescriptor(origin,"target"),r=Object.getOwnPropertyDescriptor(origin,"stopRevision");
  if(!t||!r||!Object.hasOwn(t,"value")||!Object.hasOwn(r,"value")||t.value!==target)throw refused();
  const value=asI64(r.value);if(value===undefined)throw refused();return value;
}
export function currentStopRevisionIn(db:DatabaseSync):bigint{
  const q=db.prepare(`SELECT count(*) AS n,COALESCE(max(revision),-1) AS current,(SELECT COALESCE(max(revision),0) FROM cdr_stop_revision_receipts) AS maximum FROM cdr_stop_clock WHERE singleton=1`);q.setReadBigInts(true);const row=q.get();
  const count=decodeI64(row?.n,"count"),current=decodeI64(row?.current,"revision"),maximum=decodeI64(row?.maximum,"maximum");
  if(count!==1n||current<0n||current!==maximum)throw refused();return current;
}
export function targetStopRevisionIn(db:DatabaseSync,target:string):bigint{
  requireText(target);
  const pair=(table:string,tail:string):readonly [bigint,string]|null=>{const q=db.prepare(`SELECT revision,operation_id,CAST(operation_id AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM ${table} WHERE target_thread_id=? ${tail}`);q.setReadBigInts(true);const row=q.get(target);
    return row===undefined?null:[decodeI64(row.revision,"revision"),decodeTextField(row.operation_id,row.raw,"operation_id",false,textDecoderFor(row.encoding))!];};
  const latest=pair("cdr_stop_revisions",""),history=pair("cdr_stop_revision_receipts","ORDER BY revision DESC LIMIT 1");
  if(latest===null?history!==null:history===null||latest[0]!==history[0]||latest[1]!==history[1])throw refused();return latest?.[0]??0n;
}
function requireTransaction(db:DatabaseSync):void{if(!db.isTransaction)throw new StoreIntegrityError("Borrowed mutation requires an active transaction");}
export function captureStopOriginIn(db:DatabaseSync,target:string|null):{target:string|null;stopRevision:bigint}{
  requireTarget(target);requireTransaction(db);const stopRevision=currentStopRevisionIn(db);if(target!==null)targetStopRevisionIn(db,target);return {target,stopRevision};
}
export function latestStopScopeIn(db:DatabaseSync,target:string):readonly [string,string]|null{
  requireText(target);requireTransaction(db);currentStopRevisionIn(db);targetStopRevisionIn(db,target);
  const row=db.prepare(`SELECT operation_id,scope_json,CAST(operation_id AS BLOB) AS op_raw,CAST(scope_json AS BLOB) AS scope_raw,(SELECT encoding FROM pragma_encoding) AS encoding
    FROM cdr_stop_revision_receipts WHERE target_thread_id=? ORDER BY revision DESC LIMIT 1`).get(target);
  if(row===undefined)return null;const decoder=textDecoderFor(row.encoding);return [decodeTextField(row.operation_id,row.op_raw,"operation_id",false,decoder)!,decodeTextField(row.scope_json,row.scope_raw,"scope_json",false,decoder)!];
}
/** undefined is absent legacy evidence. Explicit JSON null is malformed, not absence. */
export function stopOriginForIngress(record:StoredIngress):unknown|undefined{
  const origin=getOwn(record.payload,"stop_origin");if(origin===undefined)return undefined;
  requireTarget(record.targetThreadId);const revision=originRevision(origin,record.targetThreadId);if(revision<0n)throw refused();
  return {target:record.targetThreadId,stopRevision:revision};
}
/** Ordinary two-field origin contract only. Archive subtree validation is a separate adapter. */
export function validateStopRevisionIn(db:DatabaseSync,target:string|null,origin:unknown=undefined):void{
  requireTarget(target);const revision=origin===undefined?0n:originRevision(origin,target);
  if(revision<0n||revision>currentStopRevisionIn(db))throw refused();if(target!==null&&targetStopRevisionIn(db,target)>revision)throw refused();
}
/** Read-only open: never initializes or migrates the database. */
export function captureStopOrigin(path:string,target:string|null):{target:string|null;stopRevision:bigint}{
  requireText(path);requireTarget(target);const db=new DatabaseSync(path,{readOnly:true});try{db.exec("PRAGMA busy_timeout=500; BEGIN");const value=captureStopOriginIn(db,target);db.exec("COMMIT");return value;}
  finally{if(db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close rolls back */}}db.close();}
}
