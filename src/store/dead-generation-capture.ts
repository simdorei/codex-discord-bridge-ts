import type {DatabaseSync} from "node:sqlite";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {parseSerdeValue} from "../core/serde-json-parse.ts";
import {I64_MIN,I64_MAX} from "../protocol/ids.ts";
import {rustTrim,compareUtf8Bytes} from "./restart-snapshot-pure.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {decodeTextField,textDecoderFor,decodeI64} from "./sqlite-values.ts";
import {allJobs,serializeStoredQueueJob,type StoredQueueJob} from "./queue-read.ts";
import {withStoreTransaction,commitStore,usingInitializedStore} from "./owned-scope.ts";

export interface DeadGenerationCapture {
  readonly runtimeId:string;
  readonly generation:bigint;
  readonly snapshotJson:string;
  readonly affectedTargets:readonly string[];
  readonly startupChannelId:bigint|null;
  readonly hasUnscopedRequests:boolean;
  readonly now:number;
}
function text(value:unknown):value is string{return typeof value==="string"&&!/[\uD800-\uDFFF]/u.test(value);}
function i64(value:unknown):value is bigint{return typeof value==="bigint"&&value>=I64_MIN&&value<=I64_MAX;}
function invalid(message:string):never{throw new StoreIntegrityError(message);}
function snapshot(input:DeadGenerationCapture):DeadGenerationCapture {
  const c=cloneOwnedSerdeValue(input) as DeadGenerationCapture;
  if(c===null||typeof c!=="object"||!text(c.runtimeId)||c.runtimeId.length===0||!i64(c.generation)||c.generation<=0n||!text(c.snapshotJson)||!Array.isArray(c.affectedTargets)||c.affectedTargets.some(t=>!text(t)||rustTrim(t)==="")||(c.startupChannelId!==null&&!i64(c.startupChannelId))||typeof c.hasUnscopedRequests!=="boolean"||typeof c.now!=="number"||!Number.isFinite(c.now)||c.now<0)invalid("invalid dead-generation capture identity");
  parseSerdeValue(c.snapshotJson); // Valid JSON only; preserve the exact supplied receipt bytes.
  return c;
}
function runtimeId(input:string):string{if(!text(input)||rustTrim(input)==="")invalid("empty app-server runtime identity");return input;}
export function activateDeadGenerationRuntimeIn(db:DatabaseSync,id:string):void {
  id=runtimeId(id);
  db.prepare("INSERT INTO codex_app_server_runtime (singleton, runtime_id) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET runtime_id = excluded.runtime_id").run(id);
}
export async function activateDeadGenerationRuntime(path:string,id:string):Promise<void>{id=runtimeId(id);return usingInitializedStore(path,db=>activateDeadGenerationRuntimeIn(db,id));}

function selectedText(row:Record<string,unknown>|undefined,column:string):string|undefined {
  if(row===undefined)return undefined;
  return decodeTextField(row[column],row.raw,column,false,textDecoderFor(row.encoding))!;
}
/** Borrow the connection but own one IMMEDIATE transaction. Repeated capture compares
 * only the original exact snapshot, as Rust does, and never restages delivered notices. */
export function captureDeadGenerationOn(db:DatabaseSync,input:DeadGenerationCapture):boolean{return captureOn(db,snapshot(input));}
function captureOn(db:DatabaseSync,c:DeadGenerationCapture):boolean {
  return withStoreTransaction(db,"IMMEDIATE",()=>{
    const active=db.prepare("SELECT runtime_id, CAST(runtime_id AS BLOB) AS raw, (SELECT encoding FROM pragma_encoding) AS encoding FROM codex_app_server_runtime WHERE singleton = 1").get();
    if(selectedText(active,"runtime_id")!==c.runtimeId)invalid("app-server incident runtime identity is stale");
    const previous=db.prepare("SELECT snapshot_json, CAST(snapshot_json AS BLOB) AS raw, (SELECT encoding FROM pragma_encoding) AS encoding FROM codex_dead_generation_incidents WHERE runtime_id = ? AND generation = ?").get(c.runtimeId,c.generation);
    if(previous!==undefined){if(selectedText(previous,"snapshot_json")!==c.snapshotJson)invalid("dead-generation receipt snapshot changed");return commitStore(false);}
    // Read/decode every source row before filtering. Corrupt unrelated jobs must not be hidden.
    const jobs=allJobs(db).filter(j=>j.appServerGeneration===c.generation&&(j.state==="Starting"||j.state==="Running"));
    const targets=[...new Set([...c.affectedTargets,...jobs.map(j=>j.targetThreadId)])].sort(compareUtf8Bytes);
    db.prepare("INSERT INTO codex_dead_generation_incidents (runtime_id, generation, snapshot_json, queue_jobs_json, created_at) VALUES (?, ?, ?, ?, ?)").run(c.runtimeId,c.generation,c.snapshotJson,`[${jobs.map(serializeStoredQueueJob).join(",")}]`,c.now);
    for(const [index,target]of targets.entries()){
      db.prepare("INSERT INTO codex_dead_generation_holds (target_thread_id, runtime_id, generation, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(target_thread_id) DO NOTHING").run(target,c.runtimeId,c.generation,c.now);
      stageNotice(db,c,target,index,jobs);
    }
    if(c.hasUnscopedRequests)stageNotice(db,c,"",targets.length,jobs);
    return commitStore(true);
  });
}
export async function captureDeadGeneration(path:string,input:DeadGenerationCapture):Promise<boolean>{const c=snapshot(input);return usingInitializedStore(path,db=>captureOn(db,c));}

function stageNotice(db:DatabaseSync,c:DeadGenerationCapture,target:string,index:number,jobs:readonly StoredQueueJob[]):void {
  const queued=jobs.find(j=>j.targetThreadId===target)?.channelId;
  // Always execute and decode mapping, even when an earlier queue channel exists.
  const statement=db.prepare("SELECT CASE WHEN discord_thread_id = 0 THEN discord_channel_id ELSE discord_thread_id END AS channel FROM mirror_threads WHERE codex_thread_id = ?");
  statement.setReadBigInts(true);const row=statement.get(target);
  const mapped=row===undefined?undefined:decodeI64(row.channel,"channel");
  // Source chooses the first present channel THEN checks positivity; invalid preferred
  // channels do not silently fall back to a different recipient.
  const channel=queued??mapped??c.startupChannelId;
  if(channel===null||channel===undefined||channel<=0n)invalid("dead-generation notice has no usable channel");
  const identity=`dead-generation:${c.runtimeId}:${c.generation}:${index}`;
  const content=target===""?"The Codex app-server stopped with an unresolved request that could not be assigned to a conversation. Its full details were saved locally for manual review; the request was not automatically replayed.":"The Codex app-server stopped while a request result was uncertain. This conversation is on hold; its saved requests were not retried. Manual review is required before continuing here. Other conversations can continue.";
  db.prepare("INSERT INTO codex_delivery_outbox (delivery_id, job_id, target_thread_id, turn_id, channel_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(identity,identity,target,identity,channel,content,c.now,c.now);
}
