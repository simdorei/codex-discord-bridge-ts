import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {MirrorOwnershipPendingError} from './ownership.ts';
import type {MirrorItem,MirrorKind} from './collect.ts';
export interface MirrorOwnershipReadLimits {readonly maxJobs:bigint;readonly maxValueBytes:bigint;readonly timeoutMs:number}
const slot=new OwnedWorkerSlot();
export function mirrorOwnershipReaderBusy():boolean{return slot.busy;}
export class MirrorOwnershipReadError extends Error{constructor(detail:string){super('Mirror ownership read failed: '+detail);this.name='MirrorOwnershipReadError';}}
/** Fresh target-scoped source gate on a fixed native readonly worker. No writes,
 * migrations, queue prefixes or automatic retries. Cancellation joins actual
 * native work before returning; observations alone never authorize cursor writes. */
export async function observeCurrentMirrorOwner(path:string,thread:string,input:MirrorItem,limits:MirrorOwnershipReadLimits,signal?:AbortSignal):Promise<boolean>{
 signal?.throwIfAborted();requireDiscordText(path);requireDiscordText(thread);
 if(path.includes('\0')||path.length>32768||Buffer.byteLength(path)>32768||thread.length>16384||Buffer.byteLength(thread)>16384)throw new RangeError('Invalid mirror ownership path or target budget');
 const kind=own(input,'kind'),text=own(input,'text'),turn=own(input,'turnId');requireDiscordText(text);if(turn!==null)requireDiscordText(turn);
 if(typeof kind!=='string'||!['User','Commentary','Final','Aborted','Failed'].includes(kind))throw new TypeError('Invalid mirror ownership kind');
 if(text.length>1048576||Buffer.byteLength(text)>1048576||(turn!==null&&(turn.length>16384||Buffer.byteLength(turn)>16384)))throw new RangeError('Mirror ownership item budget exceeded');
 const maxJobs=own(limits,'maxJobs'),maxValueBytes=own(limits,'maxValueBytes'),timeoutMs=own(limits,'timeoutMs');
 if(typeof maxJobs!=='bigint'||maxJobs<1n||maxJobs>4096n||typeof maxValueBytes!=='bigint'||maxValueBytes<1n||maxValueBytes>4194304n||typeof timeoutMs!=='number'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid mirror ownership read limits');
 const item:MirrorItem={kind:kind as MirrorKind,text,turnId:turn,digest:'',phase:'',dedupeRecentText:false};
 if(slot.busy)throw new OwnedWorkerBusyError();
 const pending=slot.run(new URL('./ownership-worker.ts',import.meta.url),{path,thread,item,maxJobs,maxValueBytes},timeoutMs,signal),exited=slot.join();
 let result:unknown;try{result=await pending;}finally{await exited;}signal?.throwIfAborted();
 if(own(result,'ok')!==true){if(own(result,'pending')===true)throw new MirrorOwnershipPendingError();const detail=own(result,'detail');throw new MirrorOwnershipReadError(typeof detail==='string'?detail:'invalid worker result');}
 const owned=own(result,'owned');if(typeof owned!=='boolean')throw new MirrorOwnershipReadError('invalid worker ownership flag');return owned;
}
