import {types} from 'node:util';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {snapshotCompletionEntry,equalCompletionEntry,type CompletionCursor,type CompletionEntry,type CompletionPosition} from '../../store/completion-metadata.ts';
import {requireCompletionSource,completionSourceIsState,type CompletionSource} from '../../store/completion-metadata-sql.ts';
import type {ReadyStateWork} from './scheduler/ready.ts';
import type {DiscoveryReport} from './scheduler/discovery.ts';
export interface CursorWire{readonly after:CompletionPosition|null;readonly upper:CompletionPosition|null;readonly finished:boolean}
export interface NativeScan<C>{readonly source:CompletionSource;readonly cursor:C;readonly next:number;readonly wake:boolean;readonly pending:readonly CompletionEntry[]}
export interface NativeDiscoverySnapshot{readonly rotation:number;readonly scans:readonly NativeScan<CursorWire>[]}
export class NativeCompletionDiscoveryUnavailable extends Error{constructor(){super('Completion discovery unavailable');this.name='NativeCompletionDiscoveryUnavailable';}}
export function discoveryText(value:unknown):asserts value is string{requireDiscordText(value);if(Buffer.byteLength(value)>32768)throw new RangeError('Discovery identity exceeds native boundary');}
export function discoveryI64(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<-(1n<<63n)||value>=(1n<<63n))throw new TypeError('Expected discovery i64');}
export function discoveryEntry(value:unknown):CompletionEntry{
 const e=snapshotCompletionEntry(value as CompletionEntry);if(!Number.isFinite(e.position.stamp)||Buffer.byteLength(e.position.id)+Buffer.byteLength(e.id)+Buffer.byteLength(e.target)+Buffer.byteLength(e.turn)>4096)throw new TypeError('Invalid discovery metadata');return e;
}
export function discoveryCursor(value:unknown):CursorWire{
 const position=(p:unknown):CompletionPosition|null=>{if(p===null)return null;const stamp=own(p,'stamp'),ordinal=own(p,'ordinal'),id=own(p,'id');if(typeof stamp!=='number'||!Number.isFinite(stamp))throw new TypeError('Invalid cursor timestamp');discoveryI64(ordinal);discoveryText(id);if(Buffer.byteLength(id)>4096)throw new TypeError('Invalid cursor identity');return Object.freeze({stamp,ordinal,id});};
 const finished=own(value,'finished');if(typeof finished!=='boolean')throw new TypeError('Invalid cursor flag');return Object.freeze({finished,after:position(own(value,'after')),upper:position(own(value,'upper'))});
}
export function discoveryScan<C>(value:unknown,cursor:(v:unknown)=>C):NativeScan<C>{
 const source=own(value,'source'),next=own(value,'next'),wake=own(value,'wake'),pending=own(value,'pending');requireCompletionSource(source);
 if(typeof next!=='number'||!Number.isFinite(next)||next<0||typeof wake!=='boolean'||!Array.isArray(pending)||pending.length>32)throw new TypeError('Invalid discovery scan');
 const entries=pending.map(discoveryEntry);if(entries.some(e=>e.source!==source))throw new TypeError('Invalid pending source');return Object.freeze({source,next,wake,cursor:cursor(own(value,'cursor')),pending:Object.freeze(entries)});
}
/** A whole synchronous discovery round lives in one worker. No database read lock
 * ever waits for a message or callback on the parent event loop. */
export class NativeCompletionDiscoveryReader{
 readonly #path:string;readonly #timeout:number;readonly #cursors=new WeakMap<object,CursorWire>();readonly #tasks=new Map<Promise<unknown>,AbortController>();#closed=false;
 constructor(path:string,timeoutMs=5000){discoveryText(path);if(path.includes('\0'))throw new TypeError('Invalid discovery path');this.#path=pinNativeRuntimePath(path);if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid discovery deadline');this.#timeout=timeoutMs;}
 get active():number{return this.#tasks.size;}
 #mint(wire:CursorWire):CompletionCursor{const cursor=Object.freeze({finished:wire.finished});this.#cursors.set(cursor,wire);return cursor;}
 initialCursor():CompletionCursor{return this.#mint(Object.freeze({after:null,upper:null,finished:false}));}
 discover<L>(runtime:string,generation:bigint,snapshot:{rotation:number;scans:readonly NativeScan<CompletionCursor>[]},state:readonly ReadyStateWork<L>[],http:readonly CompletionEntry[],active:ReadonlySet<string>,samples:readonly number[],signal?:AbortSignal):Promise<{state:readonly CompletionEntry[];http:readonly CompletionEntry[];scans:readonly NativeScan<CompletionCursor>[];reports:readonly DiscoveryReport[]}>{
  discoveryText(runtime);discoveryI64(generation);if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');signal?.throwIfAborted();
  if(this.#closed)throw new NativeCompletionDiscoveryUnavailable();if(this.#tasks.size!==0)throw new OwnedWorkerBusyError();
  if(!Array.isArray(snapshot.scans)||snapshot.scans.length<1||snapshot.scans.length>8||!Number.isSafeInteger(snapshot.rotation)||snapshot.rotation<0||snapshot.rotation>=snapshot.scans.length||state.length+http.length>128||samples.length<1||samples.length>8||samples.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0))throw new TypeError('Invalid discovery input');
  const stateCount=state.length,httpCount=http.length,rotation=snapshot.rotation;
  const scans=snapshot.scans.map(s=>discoveryScan(s,c=>{const wire=c!==null&&typeof c==='object'?this.#cursors.get(c):undefined;if(wire===undefined)throw new TypeError('Expected owned native cursor');return wire;}));
  const stateWire=state.map(w=>w.kind==='Live'?(discoveryText(w.live.target),{kind:'Live' as const,target:w.live.target}):{kind:'Durable' as const,entry:discoveryEntry(w.entry)}),httpWire=http.map(discoveryEntry),activeWire=[...active];
  if(activeWire.length>128||httpWire.some(e=>completionSourceIsState(e.source))||stateWire.some(w=>w.kind==='Durable'&&!completionSourceIsState(w.entry.source)))throw new TypeError('Invalid ready input');activeWire.forEach(discoveryText);
  const input={path:this.#path,runtime,generation,snapshot:{rotation,scans},state:stateWire,http:httpWire,active:activeWire,samples:[...samples]};if(boundedSerdeByteCount(input,16*1024*1024)===null)throw new RangeError('Discovery input exceeds boundary');
  const slot=new OwnedWorkerSlot('Discovery'),controller=new AbortController(),abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const task=(async()=>{try{
   const pending=slot.run(new URL('./native-discovery-worker.ts',import.meta.url),input,this.#timeout,controller.signal);let raw:unknown;try{raw=await pending;}finally{await slot.join();}controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,16*1024*1024)===null||own(raw,'ok')!==true)throw new NativeCompletionDiscoveryUnavailable();
   const newState=own(raw,'state'),newHttp=own(raw,'http'),rawScans=own(raw,'scans'),rawReports=own(raw,'reports');
   if(!Array.isArray(newState)||!Array.isArray(newHttp)||!Array.isArray(rawScans)||!Array.isArray(rawReports)||newState.length+newHttp.length+stateCount+httpCount>128||rawScans.length!==scans.length||rawReports.length!==scans.length)throw new NativeCompletionDiscoveryUnavailable();
   const addedState=newState.map(discoveryEntry),addedHttp=newHttp.map(discoveryEntry);if(addedState.some(e=>!completionSourceIsState(e.source))||addedHttp.some(e=>completionSourceIsState(e.source)))throw new NativeCompletionDiscoveryUnavailable();
   const checkedScans=rawScans.map(s=>discoveryScan(s,discoveryCursor));if(checkedScans.some((s,i)=>s.source!==scans[i]!.source))throw new NativeCompletionDiscoveryUnavailable();
   const reports:DiscoveryReport[]=rawReports.map((r,i)=>{
    const source=own(r,'source'),ok=own(r,'ok');if(source!==scans[(rotation+i)%scans.length]!.source)throw new NativeCompletionDiscoveryUnavailable();requireCompletionSource(source);
    if(ok===false)return {source,ok:false,error:new NativeCompletionDiscoveryUnavailable()};if(ok!==true)throw new NativeCompletionDiscoveryUnavailable();const m=own(r,'metadata');if(m===null)return {source,ok:true,metadata:null};
    const oversizedIdentity=own(m,'oversizedIdentity'),heldReceiptHeads=own(m,'heldReceiptHeads'),deferred=own(m,'deferred');if(typeof oversizedIdentity!=='boolean'||typeof heldReceiptHeads!=='bigint'||heldReceiptHeads<0n||heldReceiptHeads>=(1n<<63n)||!Array.isArray(deferred)||deferred.length>32)throw new NativeCompletionDiscoveryUnavailable();
    const ds=deferred.map(d=>{const index=own(d,'index'),entry=discoveryEntry(own(d,'entry'));if(source!=='AsyncOrphan'||entry.source!==source||typeof index!=='number'||!Number.isSafeInteger(index)||index<stateCount||index>=stateCount+addedState.length||!equalCompletionEntry(entry,addedState[index-stateCount]!))throw new NativeCompletionDiscoveryUnavailable();return {index,entry};});return {source,ok:true,metadata:Object.freeze({oversizedIdentity,heldReceiptHeads,deferred:Object.freeze(ds)})};
   });
   return {state:Object.freeze(addedState),http:Object.freeze(addedHttp),scans:Object.freeze(checkedScans.map(s=>Object.freeze({...s,cursor:this.#mint(s.cursor)}))),reports:Object.freeze(reports)};
  }finally{signal?.removeEventListener('abort',abort);}})();this.#tasks.set(task,controller);const clear=()=>{this.#tasks.delete(task);};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('Completion discovery stopped')):Promise<void>{this.#closed=true;for(const c of this.#tasks.values())c.abort(reason);await Promise.allSettled([...this.#tasks.keys()]);}
}
Object.freeze(NativeCompletionDiscoveryReader.prototype);
