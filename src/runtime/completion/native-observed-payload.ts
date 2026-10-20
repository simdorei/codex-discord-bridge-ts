import {types} from 'node:util';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {snapshotCompletionEntry,type CompletionEntry} from '../../store/completion-metadata.ts';
import {MAX_COMPLETION_PAYLOAD_BYTES} from '../../store/completion-metadata-sql.ts';
export interface ObservedCompletionPayload {readonly kind:'Observed';readonly generation:bigint;readonly json:string;}
export class NativeObservedPayloadUnavailable extends Error{constructor(){super('Observed completion payload read unavailable');this.name='NativeObservedPayloadUnavailable';}}
/** Existing-only Observed bodies under caller-owned target leases. Four already-owned
 * state operations maximum; native Background3 remains a separate global limit.
 * No retries or waiting worker queue. Read failure never becomes missing durable evidence. */
export class NativeObservedPayloadReader{
 readonly #path:string;readonly #timeout:number;readonly #tasks=new Map<Promise<ObservedCompletionPayload|null>,AbortController>();#closed=false;
 constructor(path:string,timeoutMs=5000){requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid completion path');this.#path=pinNativeRuntimePath(path);if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid observed payload deadline');this.#timeout=timeoutMs;}
 get active():number{return this.#tasks.size;}
 read(input:CompletionEntry,runtime:string,generation:bigint,signal?:AbortSignal):Promise<ObservedCompletionPayload|null>{
  const entry=snapshotCompletionEntry(input);if(entry.source!=='Observed')throw new TypeError('Expected Observed completion source');
  if(!Number.isFinite(entry.position.stamp)||boundedSerdeByteCount(entry,65536)===null)throw new RangeError('Completion metadata exceeds native boundary');
  requireDiscordText(runtime);if(Buffer.byteLength(runtime)>32768)throw new RangeError('Completion runtime exceeds boundary');
  if(typeof generation!=='bigint'||generation<0n||generation>=(1n<<63n))throw new TypeError('Expected original completion generation');
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');signal?.throwIfAborted();
  if(this.#closed)throw new NativeObservedPayloadUnavailable();if(this.#tasks.size>=4)throw new OwnedWorkerBusyError();
  const slot=new OwnedWorkerSlot('Background'),controller=new AbortController(),abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const task=(async()=>{try{
   const pending=slot.run(new URL('./native-observed-payload-worker.ts',import.meta.url),{path:this.#path,entry,runtime,generation},this.#timeout,controller.signal);let raw:unknown;try{raw=await pending;}finally{await slot.join();}controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,16*1024*1024)===null||own(raw,'ok')!==true)throw new NativeObservedPayloadUnavailable();
   const payload=own(raw,'payload');if(payload===null)return null;
   const kind=own(payload,'kind'),value=own(payload,'generation'),json=own(payload,'json');
   if(kind!=='Observed'||typeof value!=='bigint'||value<-(1n<<63n)||value>=(1n<<63n)||typeof json!=='string')throw new NativeObservedPayloadUnavailable();
   requireDiscordText(json);if(Buffer.byteLength(json)>MAX_COMPLETION_PAYLOAD_BYTES)throw new NativeObservedPayloadUnavailable();
   return Object.freeze({kind,generation:value,json});
  }finally{signal?.removeEventListener('abort',abort);}})();this.#tasks.set(task,controller);const clear=()=>{this.#tasks.delete(task);};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('Observed payload reader stopped')):Promise<void>{this.#closed=true;for(const c of this.#tasks.values())c.abort(reason);await Promise.allSettled([...this.#tasks.keys()]);}
}
Object.freeze(NativeObservedPayloadReader.prototype);
