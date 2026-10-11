import {types} from 'node:util';
import {requireDiscordText} from '../discord/text.ts';
import {pinNativeRuntimePath} from './runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from './owned-worker-slot.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {cloneIdleReleaseToken,type IdleReleaseToken} from '../app-server/idle-release-journal.ts';
import {IdleObservationError} from '../app-server/notification-state.ts';
function text(value:unknown,max=4096):string{requireDiscordText(value);if(value.includes('\0')||Buffer.byteLength(value)>max)throw new RangeError('Native idle identity exceeds boundary');return value;}
/** One closed, existing-store native transaction. No arbitrary operation or SQL.
 * Accepted failure can have committed an idle transition: never imply rollback,
 * retry, or ordinary target authority. Callers must retain their original gate
 * reservation and join this owner before publishing terminal shutdown. */
export class NativeIdleBeforeOwner {
 readonly #path:string;readonly #timeout:number;readonly #render:(detail:string)=>string;readonly #slot=new OwnedWorkerSlot('Control');
 #active:Promise<unknown>|null=null;#controller:AbortController|null=null;#closed=false;
 constructor(path:string,render:(detail:string)=>string,timeoutMs=5000){this.#path=pinNativeRuntimePath(text(path,32768));if(typeof render!=='function'||types.isProxy(render)||types.isAsyncFunction(render)||types.isGeneratorFunction(render))throw new TypeError('Expected synchronous idle error renderer');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Expected bounded idle deadline');this.#timeout=timeoutMs;this.#render=render;}
 get busy():boolean{return this.#active!==null;}
 before(owner:string,generation:bigint,thread:string,signal?:AbortSignal):Promise<IdleReleaseToken|null>{
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');signal?.throwIfAborted();if(this.#closed)throw new Error('Native idle owner is closed');if(this.#active!==null)throw new OwnedWorkerBusyError();
  owner=text(owner);thread=text(thread);if(typeof generation!=='bigint'||generation<0n||generation>=(1n<<63n))throw new RangeError('Idle generation must fit signed i64');
  const controller=new AbortController();this.#controller=controller;const abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const task=(async()=>{let admitted=false;try{
   const pending=this.#slot.run(new URL('./native-idle-before-worker.ts',import.meta.url),{path:this.#path,owner,generation,thread},this.#timeout,controller.signal);admitted=this.#slot.busy;
   let raw:unknown;try{raw=await pending;}finally{await this.#slot.join();}controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,65536)===null||own(raw,'ok')!==true)throw new Error('Native idle admission did not return confirmed result');
   const value=own(raw,'value');if(value===null)return null;
   const token=cloneIdleReleaseToken(value);if(token.ownerId!==owner||token.generation!==generation||token.threadId!==thread||token.state!=='Resubscribing')throw new TypeError('Native idle result changed original authority');return token;
  }catch(error){if(!admitted)throw error;let safe='native idle admission result unavailable';try{const rendered=this.#render(safe);if(types.isPromise(rendered))void Promise.prototype.then.call(rendered,undefined,()=>undefined);safe=text(rendered,12000);}catch{/* No raw error or claim fallback. */}throw new IdleObservationError(`${safe}; original target requires reconciliation; no automatic retry`);}
  finally{signal?.removeEventListener('abort',abort);}})();
  this.#active=task;const clear=()=>{if(this.#active===task){this.#active=null;this.#controller=null;}};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('Native idle owner closed')):Promise<void>{this.#closed=true;this.#controller?.abort(reason);if(this.#active!==null)await Promise.allSettled([this.#active]);}
}
Object.freeze(NativeIdleBeforeOwner.prototype);
