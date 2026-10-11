import type {MirrorDetailMode} from '../../store/mirror-policy-read.ts';
import {captureMirrorPollJobs,type MirrorStoreSnapshot} from './store-discovery.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {MirrorOwnershipPendingError,snapshotMirrorSkippedItems,type CurrentMirrorDisposition,type SourceMirrorDisposition} from './ownership.ts';
import type {MirrorItem,MirrorKind} from './collect.ts';
export interface MirrorOwnershipReadLimits {readonly maxJobs:bigint;readonly maxValueBytes:bigint;readonly timeoutMs:number}
const slot=new OwnedWorkerSlot();
export function mirrorOwnershipReaderBusy():boolean{return slot.busy;}
export class MirrorOwnershipReadError extends Error{constructor(detail:string){super('Mirror ownership read failed: '+detail);this.name='MirrorOwnershipReadError';}}
/** Fresh target-scoped source gate on a fixed native readonly worker. No writes,
 * migrations, queue prefixes or automatic retries. Cancellation joins actual
 * native work before returning; observations alone never authorize cursor writes. */
export async function observeCurrentMirrorOwner(path:string,thread:string,input:MirrorItem,limits:MirrorOwnershipReadLimits,signal?:AbortSignal):Promise<boolean>{
 return await read(path,thread,input,limits,false,signal) as boolean;
}
/** Fresh owner plus durable marker observation. Unclaimed is not a send permit
 * and the other variants are not permanent skip or cursor-advance authority. */
export async function observeCurrentMirrorDisposition(path:string,thread:string,input:MirrorItem,limits:MirrorOwnershipReadLimits,signal?:AbortSignal):Promise<CurrentMirrorDisposition>{
 return await read(path,thread,input,limits,true,signal) as CurrentMirrorDisposition;
}
/** Historical snapshot is accepted only from fixed native discovery of this DB.
 * HistoricalOwner means hold, never permission to skip/advance or to send. */
export async function observeSourceMirrorDisposition(path:string,thread:string,input:MirrorItem,limits:MirrorOwnershipReadLimits,jobs:MirrorStoreSnapshot['jobs'],signal?:AbortSignal):Promise<SourceMirrorDisposition>{
 signal?.throwIfAborted();const captured=captureMirrorPollJobs(path,thread,jobs);
 return await read(path,thread,input,limits,true,signal,captured) as SourceMirrorDisposition;
}
async function read(path:string,thread:string,input:MirrorItem,limits:MirrorOwnershipReadLimits,disposition:boolean,signal?:AbortSignal,pollJobs?:MirrorStoreSnapshot['jobs']):Promise<boolean|SourceMirrorDisposition>{
 signal?.throwIfAborted();requireDiscordText(path);requireDiscordText(thread);
 if(path.includes('\0')||path.length>32768||Buffer.byteLength(path)>32768||thread.length>16384||Buffer.byteLength(thread)>16384)throw new RangeError('Invalid mirror ownership path or target budget');
 const kind=own(input,'kind'),text=own(input,'text'),turn=own(input,'turnId');requireDiscordText(text);if(turn!==null)requireDiscordText(turn);
 if(typeof kind!=='string'||!['User','Commentary','Final','Aborted','Failed'].includes(kind))throw new TypeError('Invalid mirror ownership kind');
 if(text.length>1048576||Buffer.byteLength(text)>1048576||(turn!==null&&(turn.length>16384||Buffer.byteLength(turn)>16384)))throw new RangeError('Mirror ownership item budget exceeded');
 const maxJobs=own(limits,'maxJobs'),maxValueBytes=own(limits,'maxValueBytes'),timeoutMs=own(limits,'timeoutMs');
 if(typeof maxJobs!=='bigint'||maxJobs<1n||maxJobs>4096n||typeof maxValueBytes!=='bigint'||maxValueBytes<1n||maxValueBytes>4194304n||typeof timeoutMs!=='number'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid mirror ownership read limits');
 const digest=disposition?own(input,'digest'):'';requireDiscordText(digest);if(digest.length>1024||Buffer.byteLength(digest)>1024)throw new RangeError('Mirror digest budget exceeded');
 const item:MirrorItem={kind:kind as MirrorKind,text,turnId:turn,digest,phase:'',dedupeRecentText:false};
 const owned=await runNativeRead({path,thread,item,maxJobs,maxValueBytes,disposition,pollJobs},timeoutMs,signal);if(disposition){if(pollJobs!==undefined&&owned==='HistoricalOwner')return owned;if(owned==='CurrentOwner'||owned==='TurnOrigin'||owned==='RecordedEvent'||owned==='Unclaimed')return owned;throw new MirrorOwnershipReadError('invalid worker disposition');}
 if(typeof owned!=='boolean')throw new MirrorOwnershipReadError('invalid worker ownership flag');return owned;
}

/** Detail lookup shares the fixed native read owner and resource accounting.
 * Existing DB only; absent row defaults to Send, corrupt schema/value never does. */
export async function observeMirrorDetailMode(path:string,thread:string,timeoutMs=5000,signal?:AbortSignal):Promise<MirrorDetailMode>{
 signal?.throwIfAborted();requireDiscordText(path);requireDiscordText(thread);
 if(path.includes('\0')||path.length>32768||Buffer.byteLength(path)>32768||thread.length>16384||Buffer.byteLength(thread)>16384)throw new RangeError('Invalid mirror detail path or target budget');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid mirror detail deadline');
 const value=await runNativeRead({path,thread,detailMode:true},timeoutMs,signal);
 if(value!=='Send'&&value!=='All')throw new MirrorOwnershipReadError('invalid worker detail mode');return value;
}
async function runNativeRead(request:unknown,timeoutMs:number,signal?:AbortSignal):Promise<unknown>{
 if(slot.busy)throw new OwnedWorkerBusyError();
 const pending=slot.run(new URL('./ownership-worker.ts',import.meta.url),request,timeoutMs,signal),exited=slot.join();
 let result:unknown;try{result=await pending;}finally{await exited;}signal?.throwIfAborted();
 if(own(result,'ok')!==true){if(own(result,'pending')===true)throw new MirrorOwnershipPendingError();const detail=own(result,'detail');throw new MirrorOwnershipReadError(typeof detail==='string'?detail:'invalid worker result');}
 return own(result,'owned');
}

/** Same source policy, one provisional native snapshot for the complete batch.
 * The fixed worker returns bounded enums only; fresh pre-send and final cursor
 * checks remain mandatory. Uses the same read slot, no additional worker queue. */
export async function observeSourceMirrorDispositions(path:string,thread:string,input:readonly MirrorItem[],limits:MirrorOwnershipReadLimits,jobs:MirrorStoreSnapshot['jobs'],signal?:AbortSignal):Promise<readonly SourceMirrorDisposition[]>{
 signal?.throwIfAborted();const captured=captureMirrorPollJobs(path,thread,jobs),items=snapshotMirrorSkippedItems(thread,input);
 const maxJobs=own(limits,'maxJobs'),maxValueBytes=own(limits,'maxValueBytes'),timeoutMs=own(limits,'timeoutMs');
 if(typeof maxJobs!=='bigint'||maxJobs<1n||maxJobs>4096n||typeof maxValueBytes!=='bigint'||maxValueBytes<1n||maxValueBytes>4194304n||typeof timeoutMs!=='number'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid mirror ownership read limits');
 if(items.length===0)return Object.freeze([]);
 const result=await runNativeRead({path,thread,items,maxJobs,maxValueBytes,pollJobs:captured,batch:true},timeoutMs,signal);
 if(!Array.isArray(result)||result.length!==items.length||result.some(v=>!['CurrentOwner','HistoricalOwner','TurnOrigin','RecordedEvent','Unclaimed'].includes(v)))throw new MirrorOwnershipReadError('invalid native batch policy result');
 return Object.freeze(result as SourceMirrorDisposition[]);
}
