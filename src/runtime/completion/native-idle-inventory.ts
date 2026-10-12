import {types} from 'node:util';import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';import {requireDiscordText} from '../../discord/text.ts';
import {snapshotIdleIntent} from '../../store/idle-release-store.ts';import type {IdleIntent} from '../../store/idle-release-row.ts';import type {IdleInventoryReader} from './idle-release.ts';
export class NativeIdleInventoryUnavailable extends Error{constructor(){super('Idle inventory unavailable');this.name='NativeIdleInventoryUnavailable';}}
/** Existing inventory hints retain signed values and all original rows. Only the
 * original parent-side filter/lease/managed release can promote a hint to effect. */
export class NativeIdleInventoryReader implements IdleInventoryReader{
 readonly #path:string;readonly #timeout:number;readonly #tasks=new Map<Promise<unknown>,AbortController>();#closed=false;
 constructor(path:string,timeoutMs=5000){requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid idle inventory path');this.#path=pinNativeRuntimePath(path);if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid idle inventory deadline');this.#timeout=timeoutMs;}
 get active():number{return this.#tasks.size;}
 pending(signal?:AbortSignal):Promise<readonly IdleIntent[]>{return this.#read('Pending',null,signal) as Promise<readonly IdleIntent[]>;}
 get(thread:string):Promise<IdleIntent|null>{requireDiscordText(thread);if(Buffer.byteLength(thread)>32768)throw new RangeError('Idle thread exceeds native boundary');return this.#read('Get',thread) as Promise<IdleIntent|null>;}
 #read(operation:'Pending'|'Get',thread:string|null,signal?:AbortSignal):Promise<readonly IdleIntent[]|IdleIntent|null>{
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');signal?.throwIfAborted();if(this.#closed)throw new NativeIdleInventoryUnavailable();if(this.#tasks.size!==0)throw new OwnedWorkerBusyError();
  const slot=new OwnedWorkerSlot('Maintenance'),controller=new AbortController(),abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const task=(async()=>{try{
   const pending=slot.runMaintenanceRead(new URL('./native-idle-inventory-worker.ts',import.meta.url),{path:this.#path,operation,thread},this.#timeout,controller.signal);let raw:unknown;try{raw=await pending;}finally{await slot.join();}controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,16*1024*1024)===null||own(raw,'ok')!==true)throw new NativeIdleInventoryUnavailable();const value=own(raw,'value');
   if(operation==='Pending'){if(!Array.isArray(value)||value.length>128)throw new NativeIdleInventoryUnavailable();return Object.freeze(value.map(v=>snapshotIdleIntent(v)));}
   if(value===null)return null;const result=snapshotIdleIntent(value as IdleIntent);if(result.threadId!==thread)throw new NativeIdleInventoryUnavailable();return result;
  }finally{signal?.removeEventListener('abort',abort);}})();this.#tasks.set(task,controller);const clear=()=>{this.#tasks.delete(task);};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('Idle inventory stopped')):Promise<void>{this.#closed=true;for(const c of this.#tasks.values())c.abort(reason);await Promise.allSettled([...this.#tasks.keys()]);}
}
Object.freeze(NativeIdleInventoryReader.prototype);
