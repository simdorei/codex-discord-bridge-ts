import {pinNativeRuntimePath} from '../runtime/runtime-paths/path-text.ts';
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
 const full=pinNativeRuntimePath(path);text(full,32768);if(slot.busy)throw new OwnedWorkerBusyError();
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
 const full=pinNativeRuntimePath(path);text(full,32768);if(slot.busy)throw new OwnedWorkerBusyError();
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

/** Exact identity only: no trim, alias, inventory scan or selected-state access.
 * Shares the existing reader slot. This helper alone installs no runtime caller. */
export async function readThreadExactOffThread(path:string,id:string,archived:boolean,signal?:AbortSignal,timeoutMs=6000):Promise<ThreadInfo|null>{
 signal?.throwIfAborted();if(process.platform==='win32')throw new Error('Windows action reference resolution is not yet qualified');
 text(path,32768);if(path.includes('\0'))throw new TypeError('Invalid state path');text(id,16384);if(typeof archived!=='boolean')throw new TypeError('Expected archived flag');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid native reference timeout');
 const full=pinNativeRuntimePath(path);text(full,32768);if(slot.busy)throw new OwnedWorkerBusyError();
 const binding=Object.freeze({mode:'Exact',path:full,id,archived});const pending=slot.run(new URL('./reference-worker.ts',import.meta.url),{path:full,id,archived,exact:true},timeoutMs,signal),joined=slot.join();let raw:unknown;
 try{raw=await pending;}finally{await joined;}signal?.throwIfAborted();
 if(boundedSerdeByteCount(raw,1048576)===null)throw new RangeError('Native exact thread response exceeds budget');const response=cloneOwnedSerdeValue(raw),returned=own(response,'binding');
 for(const key of ['mode','path','id','archived'] as const)if(own(returned,key)!==binding[key])throw new TypeError('Exact thread response differs from original request');
 if(own(response,'ok')!==true){const detail=own(response,'detail');throw new Error(typeof detail==='string'?detail:'Native exact thread lookup failed');}
 const value=own(response,'value');if(value===null)return null;
 for(const key of ['id','title','cwd','rolloutPath','model','reasoningEffort'])requireDiscordText(own(value,key));
 if(own(value,'id')!==id)throw new TypeError('Exact thread row differs from requested identity');
 for(const key of ['updatedAt','archivedAt']){const n=own(value,key);if(typeof n!=='bigint'||n<-(1n<<63n)||n>=(1n<<63n))throw new TypeError('Invalid native exact thread integer');}
 const tokens=own(value,'tokensUsed');if(tokens!==null&&(typeof tokens!=='bigint'||tokens<-(1n<<63n)||tokens>=(1n<<63n)))throw new TypeError('Invalid native exact token count');
 if(!archived&&own(value,'archivedAt')!==0n)throw new TypeError('Active exact thread has unexpected archive time');return value as ThreadInfo;
}

/** One read-only batch, not one transactional snapshot. Every original member is
 * decoded using the existing bounded exact archived-row decoder. Missing IDs are
 * the ordered subset, never partial success. Shares the existing native slot. */
export async function readArchivedScopeOffThread(path:string,input:readonly string[],signal?:AbortSignal,timeoutMs=3000):Promise<readonly string[]>{
 signal?.throwIfAborted();if(process.platform==='win32')throw new Error('Windows archive scope resolution is not yet qualified');
 text(path,32768);if(path.includes('\0'))throw new TypeError('Invalid state path');
 if(boundedSerdeByteCount(input,4194304)===null)throw new TypeError('Expected bounded archive scope');
 const scope=cloneOwnedSerdeValue(input);if(!Array.isArray(scope)||scope.length===0||scope.length>101)throw new TypeError('Expected bounded archive scope');
 for(const id of scope){text(id,16384);if(id==='')throw new TypeError('Expected nonempty archive identity');}if(new Set(scope).size!==scope.length)throw new TypeError('Expected unique archive scope');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3000)throw new RangeError('Invalid archive scope timeout');
 const full=pinNativeRuntimePath(path);text(full,32768);if(slot.busy)throw new OwnedWorkerBusyError();
 const pending=slot.run(new URL('./reference-worker.ts',import.meta.url),{path:full,archiveScope:scope},timeoutMs,signal),joined=slot.join();let raw:unknown;
 try{raw=await pending;}finally{await joined;}signal?.throwIfAborted();
 if(boundedSerdeByteCount(raw,4194304)===null)throw new RangeError('Native archive scope response exceeds budget');
 const response=cloneOwnedSerdeValue(raw),binding=own(response,'binding'),returned=own(binding,'scope');
 if(own(binding,'mode')!=='ArchiveScope'||own(binding,'path')!==full||!Array.isArray(returned)||returned.length!==scope.length||returned.some((id,i)=>id!==scope[i]))throw new TypeError('Archive scope response differs from original request');
 if(own(response,'ok')!==true){const detail=own(response,'detail');throw new Error(typeof detail==='string'?detail:'Native archive scope lookup failed');}
 const missing=own(response,'value');if(!Array.isArray(missing)||missing.length>scope.length)throw new TypeError('Invalid missing archive scope');
 let previous=-1;for(const id of missing){requireDiscordText(id);const at=scope.indexOf(id);if(at<=previous)throw new TypeError('Missing archive scope must be an ordered original subset');previous=at;}
 return missing as readonly string[];
}

/** Context's eager store-open error must precede single-target mapping. This
 * probe opens existing readonly state only, without querying any table. */
export async function probeContextStoreOffThread(path:string,signal?:AbortSignal):Promise<void>{await contextStoreRead(path,null,signal);}
/** SQL LIMIT is applied before complete selected-row decoding, never JS slicing
 * of a larger inventory. Zero means full selected set or whole-read refusal. */
export async function readContextInventoryOffThread(path:string,limit:bigint,signal?:AbortSignal):Promise<readonly ThreadInfo[]>{if(typeof limit!=='bigint'||limit<0n||limit>0xffffffffn)throw new TypeError('Expected u32 Context limit');return contextStoreRead(path,limit,signal);}
async function contextStoreRead(path:string,limit:bigint|null,signal?:AbortSignal):Promise<readonly ThreadInfo[]>{
 signal?.throwIfAborted();if(process.platform==='win32')throw new Error('Windows Context store reads are not yet qualified');
 text(path,32768);if(path.includes('\0'))throw new TypeError('Invalid state path');if(limit!==null&&(typeof limit!=='bigint'||limit<0n||limit>0xffffffffn))throw new TypeError('Expected u32 Context limit');
 const full=pinNativeRuntimePath(path);text(full,32768);if(slot.busy)throw new OwnedWorkerBusyError();const mode=limit===null?'ContextProbe':'ContextRecent';
 const pending=slot.run(new URL('./reference-worker.ts',import.meta.url),{path:full,contextRead:mode,limit},6000,signal),joined=slot.join();let raw:unknown;
 try{raw=await pending;}finally{await joined;}signal?.throwIfAborted();
 if(boundedSerdeByteCount(raw,4194304)===null)throw new RangeError('Native Context store response exceeds budget');const response=cloneOwnedSerdeValue(raw),binding=own(response,'binding');
 if(own(binding,'mode')!==mode||own(binding,'path')!==full||own(binding,'limit')!==limit)throw new TypeError('Context store response differs from original request');
 if(own(response,'ok')!==true){const detail=own(response,'detail');throw new Error(typeof detail==='string'?detail:'Native Context store lookup failed');}
 const rows=own(response,'value');if(!Array.isArray(rows)||rows.length>4096||(limit===null?rows.length!==0:limit>0n&&BigInt(rows.length)>limit))throw new TypeError('Invalid native Context inventory size');
 for(const row of rows){for(const key of ['id','title','cwd','rolloutPath','model','reasoningEffort'])requireDiscordText(own(row,key));for(const key of ['updatedAt','archivedAt']){const n=own(row,key);if(typeof n!=='bigint'||n<-(1n<<63n)||n>=(1n<<63n))throw new TypeError('Invalid Context thread integer');}if(own(row,'archivedAt')!==0n)throw new TypeError('Context inventory contains archived row');const tokens=own(row,'tokensUsed');if(tokens!==null&&(typeof tokens!=='bigint'||tokens<-(1n<<63n)||tokens>=(1n<<63n)))throw new TypeError('Invalid Context thread token count');}
 return rows as readonly ThreadInfo[];
}
