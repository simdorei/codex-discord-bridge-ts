import type {DatabaseSync,SQLInputValue} from "node:sqlite";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {sha256SerdeValue,serializeSerdeValue} from "../core/serde-json.ts";
import {I64_MIN,I64_MAX} from "../protocol/ids.ts";
import {getOwn} from "./async-resolution-json-helpers.ts";
import {rustTrim} from "./restart-snapshot-pure.ts";
import {selectJob,serializeStoredQueueJob} from "./queue-read.ts";
import {mirroredThreadIdIn} from "./busy-choice.ts";
import {ownerIsCurrent,unblocked} from "./mutation-attempt.ts";
import {requireUnheldIn as requireExecutionUnheldIn} from "./execution-hold.ts";
import {decodeI64,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {usingExistingStore,withStoreTransaction,commitStore} from "./owned-scope.ts";

export interface ResponseCustodyScope {readonly runtime:string;readonly resident:string;readonly generation:bigint;readonly request:unknown}
interface Authority {
  readonly key:string;readonly runtime:string;readonly resident:string;readonly generation:bigint;
  readonly request_sha256:string;readonly thread:string;readonly turn:string;readonly job:string;
  readonly original_job:string;readonly mapping:string|null;readonly stop_sequence:bigint;
}
const keys=["key","runtime","resident","generation","request_sha256","thread","turn","job","original_job","mapping","stop_sequence"] as const;
function refused():never{throw new StoreIntegrityError("original response custody changed or is held; no response or replay");}
function text(v:unknown):v is string{return typeof v==="string"&&!/[\uD800-\uDFFF]/u.test(v);}
function integer(v:unknown):v is bigint{return typeof v==="bigint"&&v>=I64_MIN&&v<=I64_MAX;}
function cloneScope(input:ResponseCustodyScope):ResponseCustodyScope{
  const s=cloneOwnedSerdeValue(input) as ResponseCustodyScope;
  if(s===null||typeof s!=="object"||!text(s.runtime)||!text(s.resident)||!integer(s.generation))refused();return s;
}
function identity(s:ResponseCustodyScope):{key:string;thread:string;turn:string}{
  const params=getOwn(s.request,"params"),thread=getOwn(params,"threadId"),turn=getOwn(params,"turnId"),id=getOwn(s.request,"id"),occurrence=getOwn(s.request,"occurrence"),method=getOwn(s.request,"method");
  if(!text(thread)||thread===""||rustTrim(thread)!==thread||!text(turn)||turn===""||rustTrim(turn)!==turn||s.runtime===""||s.resident===""||s.generation<1n||id==null||occurrence==null||typeof method!=="string"||method==="")refused();
  return {key:sha256SerdeValue([s.runtime,s.resident,s.generation,id,occurrence]),thread,turn};
}
function authority(input:unknown):Authority{
  const value=cloneOwnedSerdeValue(input);
  if(value===null||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!(keys as readonly string[]).includes(k)))refused();
  const fields=Object.create(null) as Record<string,unknown>;
  for(const key of keys){const v=getOwn(value,key);fields[key]=key==="mapping"&&v===undefined?null:v;}
  for(const key of keys)if(key==="generation"||key==="stop_sequence"){if(!integer(fields[key]))refused();}else if(key==="mapping"){if(fields[key]!==null&&!text(fields[key]))refused();}else if(!text(fields[key]))refused();
  return Object.freeze(fields) as unknown as Authority;
}
// Struct field order, not Value map order. original_job remains an opaque string.
function original(a:Authority):string{return `{${keys.map(k=>`${JSON.stringify(k)}:${serializeSerdeValue(a[k])}`).join(",")}}`;}
function scalar(db:DatabaseSync,sql:string,...args:SQLInputValue[]):bigint{const q=db.prepare(sql);q.setReadBigInts(true);return decodeI64(q.get(...args)?.n,"response custody scalar");}
function unheldExcept(db:DatabaseSync,thread:string,own:string):void{if(scalar(db,"SELECT EXISTS(SELECT 1 FROM cdr_server_responses WHERE target_thread_id=? AND phase='admitted' AND request_key<>?) AS n",thread,own)!==0n)refused();}
export function requireResponseUnheldIn(db:DatabaseSync,thread:string):void{if(!text(thread))refused();unheldExcept(db,thread,"");}
export function requireAllResponsesResolvedIn(db:DatabaseSync):void{if(scalar(db,"SELECT EXISTS(SELECT 1 FROM cdr_server_responses WHERE phase='admitted') AS n")!==0n)refused();}
export function checkResponseCustody(path:string,thread:string):void{usingExistingStore(path,db=>requireResponseUnheldIn(db,thread));}
export function checkAllResponseCustody(path:string):void{usingExistingStore(path,requireAllResponsesResolvedIn);}
function stopSequence(db:DatabaseSync,thread:string):bigint{return scalar(db,"SELECT COALESCE(MAX(sequence),0) AS n FROM cdr_stop_controls WHERE target_thread_id=?",thread);}
function checkIdentity(s:ResponseCustodyScope,a:Authority):void{
  const i=identity(s);if(a.key!==i.key||a.runtime!==s.runtime||a.resident!==s.resident||a.generation!==s.generation||a.thread!==i.thread||a.turn!==i.turn||a.request_sha256!==sha256SerdeValue(s.request))refused();
}
function validate(db:DatabaseSync,s:ResponseCustodyScope,a:Authority,own:string):void{
  checkIdentity(s,a);ownerIsCurrent(db,s.runtime);unblocked(db,a.thread);unheldExcept(db,a.thread,own);
  if(scalar(db,"SELECT EXISTS(SELECT 1 FROM cdr_stop_controls WHERE target_thread_id=? AND phase<>'settled') AS n",a.thread)!==0n)throw new StoreIntegrityError("original stop control authority differs; no interrupt or replay");
  requireExecutionUnheldIn(db,a.job);const job=selectJob(db,a.job);
  if(serializeStoredQueueJob(job)!==a.original_job||job.state!=="Running"||job.goalWaiting||job.appServerGeneration!==s.generation||job.channelId<=0n||job.ownerUserId===null||job.ownerUserId<=0n||mirroredThreadIdIn(db,job.channelId)!==a.mapping||(a.mapping!==null&&a.mapping!==a.thread)||stopSequence(db,a.thread)!==a.stop_sequence)refused();
  if(scalar(db,`SELECT
    (SELECT count(*) FROM codex_turn_queue WHERE target_thread_id=?1 AND turn_id=?2)=1
    AND NOT EXISTS(SELECT 1 FROM codex_request_cancellations WHERE job_id=?3 OR (?4 IS NOT NULL AND discord_message_id=?4))
    AND NOT EXISTS(SELECT 1 FROM codex_archive_fences WHERE target_thread_id=?1)
    AND NOT EXISTS(SELECT 1 FROM codex_dead_generation_holds WHERE target_thread_id=?1)
    AND NOT EXISTS(SELECT 1 FROM codex_dead_generation_incidents WHERE runtime_id=?5 AND generation=?6)
    AND NOT EXISTS(SELECT 1 FROM codex_observed_completions WHERE thread_id=?1 AND turn_id=?2) AS n`,a.thread,a.turn,a.job,job.discordMessageId,s.runtime,s.generation)===0n)refused();
}
export function captureResponseCustodyOn(db:DatabaseSync,input:ResponseCustodyScope):unknown{
  const s=cloneScope(input),i=identity(s);
  return withStoreTransaction(db,"DEFERRED",()=>{
    const ids=db.prepare("SELECT job_id,CAST(job_id AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM codex_turn_queue WHERE target_thread_id=? AND turn_id=? LIMIT 2").all(i.thread,i.turn).map(r=>decodeTextField(r.job_id,r.raw,"job_id",false,textDecoderFor(r.encoding))!);
    if(ids.length!==1)refused();const job=selectJob(db,ids[0]!);
    const a:Authority={...i,runtime:s.runtime,resident:s.resident,generation:s.generation,request_sha256:sha256SerdeValue(s.request),job:job.jobId,original_job:serializeStoredQueueJob(job),mapping:mirroredThreadIdIn(db,job.channelId),stop_sequence:stopSequence(db,job.targetThreadId)};
    validate(db,s,a,"");return commitStore(Object.freeze(a));
  });
}
export function captureResponseCustody(path:string,s:ResponseCustodyScope):unknown{const owned=cloneScope(s);identity(owned);return usingExistingStore(path,db=>captureResponseCustodyOn(db,owned));}
function retained(db:DatabaseSync,a:Authority,hash:string,phase:string):boolean{return scalar(db,`SELECT EXISTS(SELECT 1 FROM cdr_server_responses
  WHERE request_key=? AND runtime_id=? AND resident_owner=? AND generation=? AND authority_json=? AND response_sha256=? AND phase=?
  AND target_thread_id=json_extract(authority_json,'$.thread') AND turn_id=json_extract(authority_json,'$.turn') AND job_id=json_extract(authority_json,'$.job')) AS n`,a.key,a.runtime,a.resident,a.generation,original(a),hash,phase)!==0n;}
export function beginResponseCustodyOn(db:DatabaseSync,input:ResponseCustodyScope,value:unknown,payload:unknown):void{
  const s=cloneScope(input),a=authority(value),body=cloneOwnedSerdeValue(payload);
  withStoreTransaction(db,"IMMEDIATE",()=>{
    validate(db,s,a,"");db.exec("DELETE FROM cdr_server_responses WHERE request_key IN (SELECT request_key FROM cdr_server_responses WHERE phase='terminal' ORDER BY updated_at DESC,request_key DESC LIMIT -1 OFFSET 256)");
    if(scalar(db,"SELECT count(*) AS n FROM cdr_server_responses")>=1024n)refused();const now=Date.now()/1000;if(!Number.isFinite(now)||now<0)refused();const hash=sha256SerdeValue(body);
    const r=db.prepare(`INSERT INTO cdr_server_responses(request_key,runtime_id,resident_owner,generation,target_thread_id,turn_id,job_id,authority_json,response_sha256,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'admitted',?,?)`).run(a.key,a.runtime,a.resident,a.generation,a.thread,a.turn,a.job,original(a),hash,now,now);
    if(BigInt(r.changes)!==1n)refused();validate(db,s,a,a.key);if(!retained(db,a,hash,"admitted"))refused();return commitStore(undefined);
  });
}
export function beginResponseCustody(path:string,s:ResponseCustodyScope,value:unknown,payload:unknown):void{const owned=cloneScope(s),a=authority(value),body=cloneOwnedSerdeValue(payload);usingExistingStore(path,db=>beginResponseCustodyOn(db,owned,a,body));}
export function finishResponseCustodyOn(db:DatabaseSync,input:ResponseCustodyScope,value:unknown,payload:unknown,outcome:string):void{
  if(outcome!=="flushed"&&outcome!=="not_sent")refused();const s=cloneScope(input),a=authority(value),body=cloneOwnedSerdeValue(payload);checkIdentity(s,a);
  withStoreTransaction(db,"IMMEDIATE",()=>{
    ownerIsCurrent(db,s.runtime);const hash=sha256SerdeValue(body);if(!retained(db,a,hash,"admitted")&&!retained(db,a,hash,"terminal"))refused();
    const r=db.prepare("UPDATE cdr_server_responses SET phase=CASE WHEN phase='terminal' THEN phase ELSE ? END,updated_at=unixepoch() WHERE request_key=? AND phase IN ('admitted','terminal')").run(outcome,a.key);
    if(BigInt(r.changes)!==1n)refused();ownerIsCurrent(db,s.runtime);if(!retained(db,a,hash,outcome)&&!retained(db,a,hash,"terminal"))refused();return commitStore(undefined);
  });
}
export function finishResponseCustody(path:string,s:ResponseCustodyScope,value:unknown,payload:unknown,outcome:string):void{if(outcome!=="flushed"&&outcome!=="not_sent")refused();const owned=cloneScope(s),a=authority(value),body=cloneOwnedSerdeValue(payload);checkIdentity(owned,a);usingExistingStore(path,db=>finishResponseCustodyOn(db,owned,a,body,outcome));}
