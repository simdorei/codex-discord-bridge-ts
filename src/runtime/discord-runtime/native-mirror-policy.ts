import {resolve} from 'node:path';
import {InteractionAccessPolicy} from '../../discord/interaction-access.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
export interface NativeMirrorPolicyLimits {
 readonly maxRows:bigint;readonly maxValueBytes:bigint;readonly maxOutputIds:number;readonly timeoutMs:number;
}
export class NativeMirrorPolicyError extends Error {
 constructor(detail:string){super('Native mirror policy refresh failed: '+detail);this.name='NativeMirrorPolicyError';}
}
const slot=new OwnedWorkerSlot();
/** Explicit existing-only profile. Native DB reads, decoding, deduplication and
 * sorting run in a fixed worker. No new policy or stale fallback escapes failure.
 * This does not replace legacy initialized-store callers until their startup and
 * overload handling are bound. One slot, no queue, shared native capacity; caller
 * cancellation retains ownership and awaits real exit before returning. */
export async function refreshMirrorPolicyOffThread(policy:InteractionAccessPolicy,path:string,limits:NativeMirrorPolicyLimits,signal?:AbortSignal):Promise<InteractionAccessPolicy>{
 signal?.throwIfAborted();requireDiscordText(path);
 if(path.includes('\0')||path.length>32768||Buffer.byteLength(path)>32768)throw new RangeError('Invalid native policy path');
 const resolved=resolve(path);if(resolved.length>32768||Buffer.byteLength(resolved)>32768)throw new RangeError('Invalid native policy path');
 const maxRows=own(limits,'maxRows'),maxValueBytes=own(limits,'maxValueBytes'),maxOutputIds=own(limits,'maxOutputIds'),timeoutMs=own(limits,'timeoutMs');
 if(typeof maxRows!=='bigint'||maxRows<1n||maxRows>4096n||typeof maxValueBytes!=='bigint'||maxValueBytes<1n||maxValueBytes>4194304n||typeof maxOutputIds!=='number'||!Number.isSafeInteger(maxOutputIds)||maxOutputIds<1||maxOutputIds>16384||typeof timeoutMs!=='number'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid native policy limits');
 // Validate the private policy receiver before any native work, without reading
 // caller fields. This immutable probe does not grant its dynamic IDs to anyone.
 InteractionAccessPolicy.prototype.withMirroredChannelIds.call(policy,[]);
 if(slot.busy)throw new OwnedWorkerBusyError();
 const pending=slot.run(new URL('./mirror-policy-worker.ts',import.meta.url),{path:resolved,maxRows,maxValueBytes,maxOutputIds,timeoutMs},timeoutMs,signal),joined=slot.join();
 let response:unknown;try{response=await pending;}finally{await joined;}signal?.throwIfAborted();
 if(own(response,'ok')!==true){const detail=own(response,'detail');throw new NativeMirrorPolicyError(typeof detail==='string'?detail:'invalid worker result');}
 const ids=own(response,'ids');if(!Array.isArray(ids)||ids.length>maxOutputIds)throw new NativeMirrorPolicyError('invalid output count');
 let previous=-1n;for(const id of ids){if(typeof id!=='bigint'||id<0n||id>=(1n<<63n)||id<=previous)throw new NativeMirrorPolicyError('invalid sorted policy ID');previous=id;}
 return InteractionAccessPolicy.prototype.withMirroredChannelIds.call(policy,ids);
}
