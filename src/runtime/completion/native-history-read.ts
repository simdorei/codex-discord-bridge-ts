import {types} from 'node:util';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
export class NativeCompletionHistoryUnavailable extends Error{constructor(){super('Completion history evidence read unavailable');this.name='NativeCompletionHistoryUnavailable';}}
type Operation='Hold'|'Marker'|'Final'|'ResidentProof';
function identity(value:string,limit=32768):void{requireDiscordText(value);if(Buffer.byteLength(value)>limit)throw new RangeError('History identity exceeds native boundary');}
/** Read-only existing-store operations; no combined snapshot or substituted authority.
 * Each original call remains separate, bounded and joined before its caller proceeds. */
export class NativeCompletionHistoryReader{
 readonly #path:string;readonly #timeout:number;readonly #tasks=new Map<Promise<unknown>,AbortController>();#closed=false;
 constructor(path:string,timeoutMs=5000){requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid history path');this.#path=pinNativeRuntimePath(path);if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid history deadline');this.#timeout=timeoutMs;}
 get active():number{return this.#tasks.size;}
 held(target:string,signal?:AbortSignal):Promise<boolean>{identity(target);return this.#run('Hold',{target},signal) as Promise<boolean>;}
 marker(digest:string,target:string,signal?:AbortSignal):Promise<boolean>{identity(digest,2*32768+64);identity(target);return this.#run('Marker',{digest,target},signal) as Promise<boolean>;}
 final(target:string,turn:string,generation:bigint,signal?:AbortSignal):Promise<string|null>{identity(target);identity(turn);if(typeof generation!=='bigint'||generation<-(1n<<63n)||generation>=(1n<<63n))throw new RangeError('Expected i64 evidence generation');return this.#run('Final',{target,turn,generation},signal) as Promise<string|null>;}
 residentProof(target:string,turn:string,generation:bigint,resident:string,signal?:AbortSignal):Promise<boolean>{identity(target);identity(turn);identity(resident);if(typeof generation!=='bigint'||generation<-(1n<<63n)||generation>=(1n<<63n))throw new RangeError('Expected i64 evidence generation');return this.#run('ResidentProof',{target,turn,generation,resident},signal) as Promise<boolean>;}
 #run(operation:Operation,input:object,signal?:AbortSignal):Promise<boolean|string|null>{
  if(boundedSerdeByteCount(input,128*1024)===null)throw new RangeError('History request exceeds native boundary');
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');signal?.throwIfAborted();
  if(this.#closed)throw new NativeCompletionHistoryUnavailable();if(this.#tasks.size>=4)throw new OwnedWorkerBusyError();
  const slot=new OwnedWorkerSlot('Background'),controller=new AbortController(),abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const task=(async()=>{try{
   const pending=slot.run(new URL('./native-history-read-worker.ts',import.meta.url),{path:this.#path,operation,...input},this.#timeout,controller.signal);let raw:unknown;try{raw=await pending;}finally{await slot.join();}controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,4*1024*1024)===null||own(raw,'ok')!==true)throw new NativeCompletionHistoryUnavailable();const value=own(raw,'value');
   if(operation==='Final'){if(value===null)return null;if(typeof value!=='string')throw new NativeCompletionHistoryUnavailable();requireDiscordText(value);return value;}
   if(typeof value!=='boolean')throw new NativeCompletionHistoryUnavailable();return value;
  }finally{signal?.removeEventListener('abort',abort);}})();this.#tasks.set(task,controller);const clear=()=>{this.#tasks.delete(task);};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('Completion history reader stopped')):Promise<void>{this.#closed=true;for(const c of this.#tasks.values())c.abort(reason);await Promise.allSettled([...this.#tasks.keys()]);}
}
Object.freeze(NativeCompletionHistoryReader.prototype);
