import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import type {ArchiveRows,ArchiveRowLimits} from './row-digests.ts';
export interface NativeArchiveRowLimits extends ArchiveRowLimits{readonly timeoutMs:number;}
export class NativeArchiveEvidenceError extends Error{constructor(detail:string){super('Native archive evidence failed: '+detail);this.name='NativeArchiveEvidenceError';}}
const slot=new OwnedWorkerSlot();
/** Diagnostic/read-only snapshot only: opens an existing DB in a native owner,
 * captures rows under one read transaction, then joins its actual exit. No
 * deletion approval: a later write still needs backup identity and original
 * write-transaction verification. One slot shares global Background capacity.
 * Timeout is not hard SQL preemption; this promise waits for real cleanup. */
export async function readArchiveRowsOffThread(path:string,kind:ArchiveRows,id:string,limits:NativeArchiveRowLimits,signal?:AbortSignal):Promise<readonly string[]>{
 signal?.throwIfAborted();requireDiscordText(path);requireDiscordText(id);
 if(path.includes('\0')||path.length>32768||Buffer.byteLength(path)>32768||id.length>4096||Buffer.byteLength(id)>4096)throw new RangeError('Invalid archive evidence input');
 const full=pinNativeRuntimePath(path);if(full.length>32768||Buffer.byteLength(full)>32768)throw new RangeError('Invalid archive evidence path');
 if(kind!=='thread'&&kind!=='edges'&&kind!=='logs')throw new TypeError('Unknown archive evidence query');
 const maxRows=own(limits,'maxRows'),maxBytes=own(limits,'maxBytes'),timeoutMs=own(limits,'timeoutMs');
 if(typeof maxRows!=='number'||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>4096||typeof maxBytes!=='number'||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4194304||typeof timeoutMs!=='number'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid native archive evidence limits');
 if(slot.busy)throw new OwnedWorkerBusyError();
 const pending=slot.run(new URL('./row-digest-worker.ts',import.meta.url),{path:full,kind,id,maxRows,maxBytes},timeoutMs,signal),joined=slot.join();let result:unknown;
 try{result=await pending;}finally{await joined;}signal?.throwIfAborted();
 if(own(result,'ok')!==true){const detail=own(result,'detail');throw new NativeArchiveEvidenceError(typeof detail==='string'?detail:'invalid response');}
 const raw=own(result,'digests');
 if(!Array.isArray(raw)||raw.length>maxRows||raw.some(v=>typeof v!=='string'||!/^[0-9a-f]{64}$/.test(v)))throw new NativeArchiveEvidenceError('invalid digest set');
 const digests=raw as string[];for(let i=1;i<digests.length;i++)if(digests[i-1]!>digests[i]!)throw new NativeArchiveEvidenceError('unsorted digest set');
 return Object.freeze([...digests]);
}
