import {AsyncLocalStorage} from "node:async_hooks";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {I64_MAX} from "../protocol/ids.ts";
import {ResidentStateError} from "./resident-state.ts";
import {serdeField,serdeObject,rustTrim} from "./value.ts";
const original=new AsyncLocalStorage<Readonly<{origin:unknown|null}>>();
export function hasStopOriginScope():boolean{return original.getStore()!==undefined;}
/** Immutable owned metadata; null inside a set scope is distinct from no scope. */
export function currentStopOrigin():unknown|null{return original.getStore()?.origin??null;}
/** First origin wins across nested requests and awaited work. This is internal
 * trusted metadata, never a client-selected revision or a queue execution grant. */
export async function withStopOrigin<T>(origin:unknown|null,operation:()=>Promise<T>):Promise<T>{
  if(typeof operation!=="function")throw new TypeError("Expected stop-origin operation");
  if(hasStopOriginScope())return operation();
  const snapshot=origin===null?null:cloneOwnedSerdeValue(origin);
  return original.run(Object.freeze({origin:snapshot}),operation);
}
/** Node async resources inherit ALS, unlike an unrelated Tokio spawned task.
 * Use this explicit boundary when creating independent work that must not inherit
 * a request's authority; pass any required captured origin as owned data instead. */
export function withoutStopOriginScope<T>(operation:()=>T):T{return original.exit(operation);}
function invalid():never{throw new ResidentStateError({kind:"MutationHeld",message:"archive subtree differs from the original admission; no refresh or retarget"});}
/** Only after the Archive adapter validated the server-side subtree. Children here
 * represent a Rust BTreeSet: duplicates collapse and ordering is UTF-8 byte order. */
export function archiveStopOrigin(root:string,children:readonly string[]):unknown|null{
  if(!hasStopOriginScope())return null;
  const snapshot=currentStopOrigin()??{target:root,stopRevision:0n};
  if(!serdeObject(snapshot)||Object.keys(snapshot).length!==2||serdeField(snapshot,"target")!==root)invalid();
  const revision=serdeField(snapshot,"stopRevision");
  if(typeof revision!=="bigint"||revision<0n||revision>I64_MAX||typeof root!=="string"||root===""||rustTrim(root)!==root||/[\uD800-\uDFFF]/u.test(root))invalid();
  const copied=cloneOwnedSerdeValue(children);if(!Array.isArray(copied)||copied.some(x=>typeof x!=="string"))invalid();
  const targets=new Set(copied as string[]);if(targets.size>100||targets.has(root)||[...targets].some(child=>child===""||rustTrim(child)!==child))invalid();
  targets.add(root);const ordered=[...targets].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  return cloneOwnedSerdeValue({target:root,stopRevision:revision,archiveTargets:ordered});
}
/** Archive deliberately replaces only this nested scope with its validated targets;
 * ordinary withStopOrigin nesting must never refresh the original revision. */
export async function withArchiveStopScope<T>(root:string,children:readonly string[],operation:()=>Promise<T>):Promise<T>{
  const expanded=archiveStopOrigin(root,children);if(expanded===null)return operation();
  return original.run(Object.freeze({origin:expanded}),operation);
}
