import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {MirrorTarget} from '../../store/mirror-policy-read.ts';
import type {StoredQueueJob} from '../../store/queue-read.ts';
export interface MirrorStoreDiscoveryLimits{readonly maxTargets:bigint;readonly maxJobs:bigint;readonly maxValueBytes:bigint;readonly maxOutputBytes:number;readonly timeoutMs:number;}
export interface MirrorStoreSnapshot{readonly targets:readonly MirrorTarget[];readonly jobs:readonly Readonly<Omit<StoredQueueJob,'baselineTurnIds'>&{baselineTurnIds:readonly string[]}>[];}
const slot=new OwnedWorkerSlot();
export function mirrorStoreDiscoveryBusy():boolean{return slot.busy;}
export class MirrorStoreDiscoveryError extends Error{constructor(detail:string){super('Mirror store discovery failed: '+detail);this.name='MirrorStoreDiscoveryError';}}
/** Existing initialized bridge store only. Full source decoding stays in the
 * fixed owned worker; bounded structured-clone results are frozen here.
 * Not a startup initializer or a globally atomic Codex/mapping/queue snapshot.
 * Timeout/abort awaits actual native exit; no queued successor or partial result. */
export async function discoverMirrorStore(path:string,limits:MirrorStoreDiscoveryLimits,signal?:AbortSignal):Promise<MirrorStoreSnapshot>{
 signal?.throwIfAborted();requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new RangeError('Invalid mirror store path');
 const maxTargets=own(limits,'maxTargets'),maxJobs=own(limits,'maxJobs'),maxValueBytes=own(limits,'maxValueBytes'),maxOutputBytes=own(limits,'maxOutputBytes'),timeoutMs=own(limits,'timeoutMs');
 for(const n of [maxTargets,maxJobs])if(typeof n!=='bigint'||n<1n||n>4096n)throw new RangeError('Invalid mirror store row limit');
 if(typeof maxValueBytes!=='bigint'||maxValueBytes<1n||maxValueBytes>4194304n||typeof maxOutputBytes!=='number'||!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>4194304||typeof timeoutMs!=='number'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid mirror store resource limits');
 if(slot.busy)throw new OwnedWorkerBusyError();
 const pending=slot.run(new URL('./store-discovery-worker.ts',import.meta.url),{path,maxTargets,maxJobs,maxValueBytes,maxOutputBytes},timeoutMs,signal),exited=slot.join();let response:unknown;try{response=await pending;}finally{await exited;}signal?.throwIfAborted();
 if(own(response,'ok')!==true){const detail=own(response,'detail');throw new MirrorStoreDiscoveryError(typeof detail==='string'?detail:'invalid worker response');}
 const targets=own(response,'targets'),jobs=own(response,'jobs');
 if(!Array.isArray(targets)||!Array.isArray(jobs)||BigInt(targets.length)>(maxTargets as bigint)||BigInt(jobs.length)>(maxJobs as bigint))throw new MirrorStoreDiscoveryError('invalid worker row counts');
 // These values can only originate from the fixed native worker's strict source
 // decoders, never a caller-supplied transport, callback, or alternate worker URL.
 for(const target of targets)Object.freeze(target);for(const job of jobs){Object.freeze(job.baselineTurnIds);Object.freeze(job);}
 return Object.freeze({targets:Object.freeze(targets),jobs:Object.freeze(jobs)});
}
