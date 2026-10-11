import {resolve} from 'node:path';
import {requireDiscordText} from '../discord/text.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../runtime/owned-worker-slot.ts';
import {ThreadResolveError} from './thread-reference.ts';
import type {ThreadInfo} from './thread.ts';
const slot=new OwnedWorkerSlot();
function text(value:unknown,max:number):asserts value is string{requireDiscordText(value);if(value.length>max||Buffer.byteLength(value)>max)throw new RangeError('Thread reference text exceeds budget');}
/** Exact ID first, then complete bounded original-order inventory. Never resolve
 * an alias from a truncated list. Existing DB only, no writes or target changes.
 * Native exit joins timeout/abort. POSIX reference profile only. */
export async function resolveThreadReferenceOffThread(path:string,reference:string,selected:string|null,archived:boolean,signal?:AbortSignal,timeoutMs=6000,bridgePath?:string):Promise<ThreadInfo>{
 signal?.throwIfAborted();if(process.platform==='win32')throw new Error('Windows action reference resolution is not yet qualified');
 text(path,32768);if(path.includes('\0'))throw new TypeError('Invalid state path');text(reference,16384);if(bridgePath!==undefined){text(bridgePath,32768);if(bridgePath.includes('\0'))throw new TypeError('Invalid bridge path');}if(selected!==null)text(selected,16384);if(typeof archived!=='boolean')throw new TypeError('Expected archived flag');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid native reference timeout');
 const full=resolve(path);text(full,32768);if(slot.busy)throw new OwnedWorkerBusyError();
 const pending=slot.run(new URL('./reference-worker.ts',import.meta.url),{path:full,reference,selected,archived,bridgePath},timeoutMs,signal),joined=slot.join();let raw:unknown;
 try{raw=await pending;}finally{await joined;}signal?.throwIfAborted();
 if(boundedSerdeByteCount(raw,1048576)===null)throw new RangeError('Native reference response exceeds budget');const response=cloneOwnedSerdeValue(raw);
 if(own(response,'ok')!==true){
  const r=Object.hasOwn(response as object,'resolve')?own(response,'resolve'):undefined;
  if(r!==undefined){const kind=own(r,'kind'),ref=own(r,'reference'),isArchived=own(r,'archived'),options=own(r,'options');if(['NoThreads','NoAlternate','IndexOutOfRange','Ambiguous','NotFound'].includes(kind as string)&&typeof ref==='string'&&typeof isArchived==='boolean'&&typeof options==='string')throw new ThreadResolveError(kind as ThreadResolveError['kind'],ref,isArchived,options);}
  const detail=own(response,'detail');throw new Error(typeof detail==='string'?detail:'Native reference lookup failed');
 }
 const value=own(response,'value');for(const key of ['id','title','cwd','rolloutPath','model','reasoningEffort'])requireDiscordText(own(value,key));
 for(const key of ['updatedAt','archivedAt'])if(typeof own(value,key)!=='bigint')throw new TypeError('Invalid native thread integer');
 const tokens=own(value,'tokensUsed');if(tokens!==null&&typeof tokens!=='bigint')throw new TypeError('Invalid native thread token count');
 return value as ThreadInfo;
}


/** Complete bounded inventory for list rendering; preserves all source rows or
 * fails as a whole. Shares the same native reader slot and original DB ordering. */
export async function readThreadInventoryOffThread(path:string,archived:boolean,signal?:AbortSignal):Promise<readonly ThreadInfo[]>{
 signal?.throwIfAborted();text(path,32768);if(path.includes('\0'))throw new TypeError('Invalid state path');if(typeof archived!=='boolean')throw new TypeError('Expected archived flag');
 const full=resolve(path);text(full,32768);if(slot.busy)throw new OwnedWorkerBusyError();
 const pending=slot.run(new URL('./reference-worker.ts',import.meta.url),{path:full,archived,inventory:true},6000,signal),joined=slot.join();let raw:unknown;
 try{raw=await pending;}finally{await joined;}signal?.throwIfAborted();
 if(boundedSerdeByteCount(raw,4194304)===null)throw new RangeError('Native inventory exceeds output budget');
 const response=cloneOwnedSerdeValue(raw);if(own(response,'ok')!==true){const detail=own(response,'detail');throw new Error(typeof detail==='string'?detail:'Native inventory failed');}
 const value=own(response,'value');if(!Array.isArray(value)||value.length>4096)throw new TypeError('Invalid native thread inventory');
 for(const row of value){
  for(const key of ['id','title','cwd','rolloutPath','model','reasoningEffort'])requireDiscordText(own(row,key));
  for(const key of ['updatedAt','archivedAt'])if(typeof own(row,key)!=='bigint')throw new TypeError('Invalid native thread integer');
  const tokens=own(row,'tokensUsed');if(tokens!==null&&typeof tokens!=='bigint')throw new TypeError('Invalid native thread token count');
 }
 return value as readonly ThreadInfo[];
}
