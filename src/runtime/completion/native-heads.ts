import {types} from 'node:util';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {snapshotCompletionEntry,type CompletionEntry} from '../../store/completion-metadata.ts';
import {completionSourceIsState} from '../../store/completion-metadata-sql.ts';
export class NativeCompletionReadUnavailable extends Error{constructor(){super('Completion head read unavailable; no hints accepted');this.name='NativeCompletionReadUnavailable';}}
/** One pinned existing-store reader. Results are hints, never delivery authority.
 * Uses one bounded Background slot, no hidden queue; deadline/cancellation joins exit. */
export class NativeCompletionHeadsOwner{
 readonly #path:string;readonly #slot=new OwnedWorkerSlot('Background');readonly #timeout:number;
 #closed=false;#active:Promise<readonly CompletionEntry[]>|null=null;#controller:AbortController|null=null;
 constructor(path:string,timeoutMs=5000){requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid completion path');this.#path=pinNativeRuntimePath(path);if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid completion read deadline');this.#timeout=timeoutMs;}
 get busy():boolean{return this.#active!==null;}
 heads(target:string,runtime:string,generation:bigint,signal?:AbortSignal):Promise<readonly CompletionEntry[]>{
  for(const value of [target,runtime]){requireDiscordText(value);if(Buffer.byteLength(value)>32768)throw new RangeError('Completion identity exceeds native boundary');}
  if(typeof generation!=='bigint'||generation<0n||generation>=(1n<<63n))throw new TypeError('Expected original completion generation');
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');signal?.throwIfAborted();
  if(this.#closed)throw new NativeCompletionReadUnavailable();if(this.#active!==null)throw new OwnedWorkerBusyError();
  const controller=new AbortController();this.#controller=controller;const abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const task=(async()=>{try{
   const pending=this.#slot.run(new URL('./native-heads-worker.ts',import.meta.url),{path:this.#path,target,runtime,generation},this.#timeout,controller.signal);let raw:unknown;try{raw=await pending;}finally{await this.#slot.join();}controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,65536)===null||own(raw,'ok')!==true)throw new NativeCompletionReadUnavailable();const entries=own(raw,'entries');if(!Array.isArray(entries)||entries.length>5)throw new NativeCompletionReadUnavailable();
   const result=entries.map(e=>snapshotCompletionEntry(e));const sources=new Set<string>();for(const entry of result){if(entry.target!==target||completionSourceIsState(entry.source)||sources.has(entry.source)||!Number.isFinite(entry.position.stamp))throw new NativeCompletionReadUnavailable();sources.add(entry.source);}return Object.freeze(result);
  }finally{signal?.removeEventListener('abort',abort);}})();this.#active=task;const clear=()=>{if(this.#active===task){this.#active=null;this.#controller=null;}};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('Completion head owner closed')):Promise<void>{this.#closed=true;this.#controller?.abort(reason);if(this.#active!==null)await Promise.allSettled([this.#active]);}
}
Object.freeze(NativeCompletionHeadsOwner.prototype);
