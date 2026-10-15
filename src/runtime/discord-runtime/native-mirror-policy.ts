import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {InteractionAccessPolicy} from '../../discord/interaction-access.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError,takeOwnedWorkerAdmissionRefusal} from '../owned-worker-slot.ts';
export interface NativeMirrorPolicyLimits {
 readonly maxRows:bigint;readonly maxValueBytes:bigint;readonly maxOutputIds:number;readonly timeoutMs:number;
}
export class NativeMirrorPolicyError extends Error {
 constructor(detail:string){super('Native mirror policy refresh failed: '+detail);this.name='NativeMirrorPolicyError';}
}
const capacityOrigins=new WeakMap<object,object>();
const capacityRefusals=new WeakMap<Promise<InteractionAccessPolicy>,unknown>();
class NativeMirrorPolicyCapacityError extends OwnedWorkerBusyError {
 constructor(origin:object){super();this.name='NativeMirrorPolicyCapacityError';this.message='Native mirror policy capacity is occupied; no refresh submitted';capacityOrigins.set(this,origin);}
}
/** Consume proof for this exact refresh invocation. An old genuine error may be
 * propagated by a different operation, but cannot authorize event-local handling. */
export function takeMirrorPolicyCapacityRefusal(pending:Promise<InteractionAccessPolicy>|undefined,error:unknown):boolean{
 if(pending===undefined||!capacityRefusals.has(pending)||capacityRefusals.get(pending)!==error)return false;
 capacityRefusals.delete(pending);return true;
}
const slot=new OwnedWorkerSlot();
export function captureNativeMirrorPolicyLimits(limits:NativeMirrorPolicyLimits):NativeMirrorPolicyLimits{
 const maxRows=own(limits,'maxRows'),maxValueBytes=own(limits,'maxValueBytes'),maxOutputIds=own(limits,'maxOutputIds'),timeoutMs=own(limits,'timeoutMs');
 if(typeof maxRows!=='bigint'||maxRows<1n||maxRows>4096n||typeof maxValueBytes!=='bigint'||maxValueBytes<1n||maxValueBytes>4194304n||typeof maxOutputIds!=='number'||!Number.isSafeInteger(maxOutputIds)||maxOutputIds<1||maxOutputIds>16384||typeof timeoutMs!=='number'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid native policy limits');
 return Object.freeze({maxRows,maxValueBytes,maxOutputIds,timeoutMs});
}
function capturePath(path:string):string{
 requireDiscordText(path);if(path.includes('\0')||path.length>32768||Buffer.byteLength(path)>32768)throw new RangeError('Invalid native policy path');
 const resolved=pinNativeRuntimePath(path);if(resolved.length>32768||Buffer.byteLength(resolved)>32768)throw new RangeError('Invalid native policy path');return resolved;
}
/** Bind the original database and explicit live limits at installation. No pool,
 * stale cache or hidden queue is created per handler. */
export function createNativeMirrorPolicyRefresh(path:string,limits:NativeMirrorPolicyLimits){
 const fixed=capturePath(path),captured=captureNativeMirrorPolicyLimits(limits);
 return (policy:InteractionAccessPolicy,given:string,signal?:AbortSignal):Promise<InteractionAccessPolicy>=>{
  if(given!==path)throw new TypeError('Mirror policy belongs to another database');
  return refreshMirrorPolicyOffThread(policy,fixed,captured,signal);
 };
}
/** Explicit existing-only profile. Native DB reads, decoding, deduplication and
 * sorting run in a fixed worker. No new policy or stale fallback escapes failure.
 * Installed ordinary interaction, Gateway message and history ingress use this
 * profile; direct callers retain their separate compatibility defaults. One slot, no queue, shared native capacity; caller
 * cancellation retains ownership and awaits real exit before returning. */
export function refreshMirrorPolicyOffThread(policy:InteractionAccessPolicy,path:string,limits:NativeMirrorPolicyLimits,signal?:AbortSignal):Promise<InteractionAccessPolicy>{
 const origin={};
 const pending=refresh(origin,policy,path,limits,signal).catch((error:unknown)=>{
  if(error!==null&&typeof error==='object'&&capacityOrigins.get(error)===origin)capacityRefusals.set(pending,error);
  throw error;
 });
 return pending;
}
async function refresh(origin:object,policy:InteractionAccessPolicy,path:string,limits:NativeMirrorPolicyLimits,signal?:AbortSignal):Promise<InteractionAccessPolicy>{
 signal?.throwIfAborted();const resolved=capturePath(path),{maxRows,maxValueBytes,maxOutputIds,timeoutMs}=captureNativeMirrorPolicyLimits(limits);
 // Validate the private policy receiver before any native work, without reading
 // caller fields. This immutable probe does not grant its dynamic IDs to anyone.
 InteractionAccessPolicy.prototype.withMirroredChannelIds.call(policy,[]);
 if(slot.busy)throw new NativeMirrorPolicyCapacityError(origin);
 let response:unknown,pending:Promise<unknown>|undefined,admitted=false,joined=Promise.resolve();
 try{
  try{pending=slot.run(new URL('./mirror-policy-worker.ts',import.meta.url),{path:resolved,maxRows,maxValueBytes,maxOutputIds,timeoutMs},timeoutMs,signal);}
  finally{admitted=slot.busy;joined=slot.join();}
  response=await pending;
 }catch(error){if(!admitted&&takeOwnedWorkerAdmissionRefusal(slot,pending,error))throw new NativeMirrorPolicyCapacityError(origin);throw error;}finally{await joined;}
 signal?.throwIfAborted();
 if(own(response,'ok')!==true){const detail=own(response,'detail');throw new NativeMirrorPolicyError(typeof detail==='string'?detail:'invalid worker result');}
 const ids=own(response,'ids');if(!Array.isArray(ids)||ids.length>maxOutputIds)throw new NativeMirrorPolicyError('invalid output count');
 let previous=-1n;for(const id of ids){if(typeof id!=='bigint'||id<0n||id>=(1n<<63n)||id<=previous)throw new NativeMirrorPolicyError('invalid sorted policy ID');previous=id;}
 return InteractionAccessPolicy.prototype.withMirroredChannelIds.call(policy,ids);
}
