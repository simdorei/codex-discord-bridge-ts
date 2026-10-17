import {types} from 'node:util';
import {pinNativeRuntimePath} from './runtime-paths/path-text.ts';
import {requireDiscordText} from '../discord/text.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {ResidentStateError} from '../app-server/resident-state.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from './owned-worker-slot.ts';
function text(v:unknown,limit:number):string{requireDiscordText(v);if(Buffer.byteLength(v)>limit||v.includes('\0'))throw new RangeError('Custody read text exceeds native boundary');return v;}
export class NativeCustodyReadUnavailable extends Error{constructor(detail:string){super(detail);this.name='NativeCustodyReadUnavailable';}}
/** Existing-only read checks on one pinned store/runtime, not a durable claim or
 * reusable permission. The actual writer must retain original admission and
 * revalidate after this Promise; mutation BEGIN/COMMIT remain a separate gate.
 * Zero waiting queue, one reserved Control worker. Abort/timeout joins native exit.
 * This additive adapter is not installed into the resident's synchronous hooks. */
export class NativeCustodyReadOwner{
 readonly #path:string;readonly #runtime:string;readonly #render:(text:string)=>string;readonly #timeout:number;readonly #slot=new OwnedWorkerSlot('Control');
 #closed=false;#active:Promise<void>|null=null;#controller:AbortController|null=null;
 constructor(path:string,runtime:string,render:(text:string)=>string,timeoutMs=5000){
  this.#path=pinNativeRuntimePath(text(path,32768));this.#runtime=text(runtime,4096);if(runtime==='')throw new TypeError('Expected runtime identity');
  if(typeof render!=='function'||types.isProxy(render)||types.isAsyncFunction(render)||types.isGeneratorFunction(render))throw new TypeError('Expected synchronous public-safe diagnostic renderer');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid custody native deadline');this.#render=render;this.#timeout=timeoutMs;
 }
 get busy():boolean{return this.#active!==null;}
 async close(reason:unknown=new Error('Custody read owner closed')):Promise<void>{this.#closed=true;this.#controller?.abort(reason);if(this.#active!==null)await Promise.allSettled([this.#active]);}
 check(generation:bigint,method:string,params:unknown,signal?:AbortSignal):Promise<void>{
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected owned AbortSignal');signal?.throwIfAborted();
  if(this.#closed)throw new NativeCustodyReadUnavailable('Custody read owner is closed');if(this.#active!==null)throw new OwnedWorkerBusyError();
  if(typeof generation!=='bigint'||generation<0n||generation>=(1n<<64n))throw new TypeError('Expected u64 generation');text(method,4096);
  if(boundedSerdeByteCount(params,1048576)===null)throw new RangeError('Custody read parameters exceed byte budget');const captured=cloneOwnedSerdeValue(params);
  const controller=new AbortController();this.#controller=controller;const abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const task=(async()=>{try{
   const pending=this.#slot.run(new URL('./native-custody-read-worker.ts',import.meta.url),{path:this.#path,runtime:this.#runtime,generation,method,params:captured},this.#timeout,controller.signal);const joined=this.#slot.join();let raw:unknown;
   try{raw=await pending;}finally{await joined;}controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,32768)===null)throw new NativeCustodyReadUnavailable('Invalid custody worker response');
   const ok=own(raw,'ok');if(ok===true)return;if(ok!==false)throw new NativeCustodyReadUnavailable('Invalid custody worker response');
   const kind=own(raw,'kind'),detail=text(own(raw,'detail'),16384),rendered=this.#render(detail);if(types.isPromise(rendered))void Promise.prototype.then.call(rendered,undefined,()=>undefined);const message=text(rendered,16384);
   if(kind==='MutationHeld'||kind==='DeadGenerationFence')throw new ResidentStateError({kind,message});
   if(kind!==null)throw new NativeCustodyReadUnavailable('Invalid custody failure kind');throw new NativeCustodyReadUnavailable(message);
  }finally{signal?.removeEventListener('abort',abort);}})();
  this.#active=task;const clear=()=>{if(this.#active===task){this.#active=null;this.#controller=null;}};void task.then(clear,clear);return task;
 }
}
Object.freeze(NativeCustodyReadOwner.prototype);
