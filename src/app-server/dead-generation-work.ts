import {types} from "node:util";
import {ServerRequestOccurrence,validateRequestId} from "../protocol/ids.ts";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {serdeValueEqual} from "../core/serde-value-equal.ts";
import type {PendingServerRequest} from "./server-request-state.ts";
export interface DeadGenerationWork{readonly generation:bigint;readonly closedReason:string;readonly activeTurns:readonly {readonly threadId:string;readonly turnId:string}[];readonly serverRequests:readonly PendingServerRequest[]}
export type DeadGenerationSettleResult="Settled"|"AlreadySettled"|"NotEligible"|"SnapshotChanged";
function record(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(value===null||typeof value!=="object"||types.isProxy(value)||Array.isArray(value))throw new TypeError("Expected dead-generation record");
  const own=Reflect.ownKeys(value);if(own.length!==keys.length||own.some(k=>typeof k!=="string"||!keys.includes(k)))throw new TypeError("Unexpected dead-generation fields");
  const fields:Record<string,unknown>=Object.create(null);for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own dead-generation data");fields[key]=d.value;}return fields;
}
function text(value:unknown):string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed dead-generation text");return value;}
function vector(value:unknown):unknown[]{
  if(value===null||typeof value!=="object"||types.isProxy(value)||!Array.isArray(value))throw new TypeError("Expected dead-generation vector");
  const length=Object.getOwnPropertyDescriptor(value,"length")!.value as number;if(Reflect.ownKeys(value).length!==length+1)throw new TypeError("Expected dense dead-generation vector");const out:unknown[]=[];
  for(let i=0;i<length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own vector data");out.push(d.value);}return out;
}
/** Validate and copy an internal snapshot. Order is significant, as in Rust Vec Eq.
 * Occurrence remains a branded value; this is NOT a wire JSON decoder or durable proof. */
export function cloneDeadGenerationWork(input:unknown):DeadGenerationWork{
  const r=record(input,["generation","closedReason","activeTurns","serverRequests"]),generation=r.generation;
  if(typeof generation!=="bigint"||generation<0n||generation>=(1n<<64n))throw new TypeError("Expected u64 dead generation");
  const activeTurns=vector(r.activeTurns).map(value=>{const t=record(value,["threadId","turnId"]);return Object.freeze({threadId:text(t.threadId),turnId:text(t.turnId)});});
  const serverRequests=vector(r.serverRequests).map(value=>{const q=record(value,["id","occurrence","method","params"]);const occurrence=ServerRequestOccurrence.fromBytes(ServerRequestOccurrence.prototype.asBytes.call(q.occurrence));Object.freeze(occurrence);return Object.freeze({id:validateRequestId(q.id),occurrence,method:text(q.method),params:cloneOwnedSerdeValue(q.params)});});
  return Object.freeze({generation,closedReason:text(r.closedReason),activeTurns:Object.freeze(activeTurns),serverRequests:Object.freeze(serverRequests)});
}
/** Only for validated owned snapshots, never arbitrary object inspection. */
export function deadGenerationWorkEqual(a:DeadGenerationWork,b:DeadGenerationWork):boolean{
  return a.generation===b.generation&&a.closedReason===b.closedReason&&a.activeTurns.length===b.activeTurns.length&&a.activeTurns.every((t,i)=>t.threadId===b.activeTurns[i]!.threadId&&t.turnId===b.activeTurns[i]!.turnId)&&a.serverRequests.length===b.serverRequests.length&&a.serverRequests.every((q,i)=>{const r=b.serverRequests[i]!;return q.id===r.id&&Buffer.compare(ServerRequestOccurrence.prototype.asBytes.call(q.occurrence),ServerRequestOccurrence.prototype.asBytes.call(r.occurrence))===0&&q.method===r.method&&serdeValueEqual(q.params,r.params);});
}
export function deadGenerationWorkIsEmpty(work:DeadGenerationWork):boolean{return work.activeTurns.length===0&&work.serverRequests.length===0;}
