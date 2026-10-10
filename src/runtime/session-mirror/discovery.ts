import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
export interface MirrorThreadHint{readonly id:string;readonly rolloutPath:string;}
export interface MirrorDiscoveryLimits{readonly maxRows:bigint;readonly maxValueBytes:bigint;readonly maxOutputBytes:number;readonly timeoutMs:number;}
const slot=new OwnedWorkerSlot();
export function mirrorDiscoveryBusy():boolean{return slot.busy;}
export class MirrorDiscoveryError extends Error{constructor(detail:string){super(`Mirror thread discovery failed: ${detail}`);this.name='MirrorDiscoveryError';}}
/** One owned native SQLite reader, zero waiting queue. Complete active-thread
 * metadata is validated off-thread, then only bounded routing fields return.
 * Does not read mirror mappings/queue, mutate a cursor or initialize either DB.
 * Timeout requests no fictitious termination: caller also waits for worker exit. */
export async function discoverMirrorThreads(path:string,limits:MirrorDiscoveryLimits,signal?:AbortSignal):Promise<readonly MirrorThreadHint[]>{
 signal?.throwIfAborted();requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new RangeError('Invalid mirror discovery path');
 const maxRows=own(limits,'maxRows'),maxValueBytes=own(limits,'maxValueBytes'),maxOutputBytes=own(limits,'maxOutputBytes'),timeoutMs=own(limits,'timeoutMs');
 if(typeof maxRows!=='bigint'||maxRows<1n||maxRows>65536n||typeof maxValueBytes!=='bigint'||maxValueBytes<1n||maxValueBytes>16777216n||typeof maxOutputBytes!=='number'||!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>16777216||typeof timeoutMs!=='number'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid mirror discovery limits');
 if(slot.busy)throw new OwnedWorkerBusyError();const pending=slot.run(new URL('./discovery-worker.ts',import.meta.url),{path,maxRows,maxValueBytes,maxOutputBytes},timeoutMs,signal),exited=slot.join();let response:unknown;try{response=await pending;}finally{await exited;}signal?.throwIfAborted();
 if(own(response,'ok')!==true){const detail=own(response,'detail');throw new MirrorDiscoveryError(typeof detail==='string'?detail:'invalid worker response');}
 const hints=own(response,'hints');if(!Array.isArray(hints)||BigInt(hints.length)>maxRows)throw new MirrorDiscoveryError('invalid worker hint count');let bytes=0;const result:MirrorThreadHint[]=[];
 for(const row of hints){const id=own(row,'id'),rolloutPath=own(row,'rolloutPath');requireDiscordText(id);requireDiscordText(rolloutPath);const a=Buffer.byteLength(id),b=Buffer.byteLength(rolloutPath);bytes+=a+b+16;if(a>16384||b>32768||bytes>maxOutputBytes)throw new MirrorDiscoveryError('invalid worker hint size');result.push(Object.freeze({id,rolloutPath}));}
 return Object.freeze(result);
}
