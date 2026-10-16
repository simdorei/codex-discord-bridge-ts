import {types} from 'node:util';
import {randomUUID} from 'node:crypto';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
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
 readonly #path:string;readonly #timeout:number;readonly #render:(detail:string)=>string;
 readonly #tasks=new Set<Promise<unknown>>();readonly #controllers=new Set<AbortController>();#closed=false;
 constructor(path:string,render:(detail:string)=>string,timeoutMs=5000){this.#path=pinNativeRuntimePath(text(path,32768));if(typeof render!=='function'||types.isProxy(render)||types.isAsyncFunction(render)||types.isGeneratorFunction(render))throw new TypeError('Expected synchronous idle error renderer');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Expected bounded idle deadline');this.#timeout=timeoutMs;this.#render=render;}
 get busy():boolean{return this.#tasks.size>0;}
 #ready(signal:AbortSignal|undefined,allowOwned=false):void{
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');signal?.throwIfAborted();if(this.#closed)throw new Error('Native idle owner is closed');if(!allowOwned&&this.busy)throw new OwnedWorkerBusyError();
 }
 /** Validate the source's bounded old pending inventory without returning rows or
  * changing their authority. Exact invocation acknowledgement is joined first. */
 validateInstallation(signal?:AbortSignal):Promise<void>{
  this.#ready(signal);const nonce=randomUUID();
  return this.#run('validateInstallation',{nonce},false,value=>{
   const ack=cloneOwnedSerdeValue(value),keys=['operation','path','nonce'];
   if(ack===null||typeof ack!=='object'||Array.isArray(ack)||Object.keys(ack).length!==keys.length||keys.some(key=>!Object.hasOwn(ack,key))||own(ack,'operation')!=='validateInstallation'||own(ack,'path')!==this.#path||own(ack,'nonce')!==nonce)throw new TypeError('Native idle installation acknowledgement changed original invocation');
  },signal);
 }
 before(owner:string,generation:bigint,thread:string,signal?:AbortSignal):Promise<IdleReleaseToken|null>{
  this.#ready(signal);owner=text(owner);thread=text(thread);if(typeof generation!=='bigint'||generation<0n||generation>=(1n<<63n))throw new RangeError('Idle generation must fit signed i64');
  return this.#run('before',{owner,generation,thread},false,value=>{
   if(value===null)return null;const token=cloneIdleReleaseToken(value);if(token.ownerId!==owner||token.generation!==generation||token.threadId!==thread||token.state!=='Resubscribing')throw new TypeError('Native idle result changed original authority');return token;
  },signal);
 }
 /** Original CAS token remains owned through actual native join. Initial dispatch
  * permission is never queued; final owned transitions use the finite completion lane. */
 transition(input:IdleReleaseToken,state:string,detail:string,signal?:AbortSignal):Promise<IdleReleaseToken>{
  this.#ready(signal,state!=='Dispatching');const token=cloneIdleReleaseToken(input);
  for(const key of ['intentId','ownerId','threadId','turnId','jobId','state'] as const)text(token[key]);
  if(token.generation>=(1n<<63n))throw new RangeError('Idle generation must fit signed i64');text(token.detail,32768);text(state);text(detail,32768);
  return this.#run('transition',{token,state,detail},state!=='Dispatching',value=>{
   const next=cloneIdleReleaseToken(value);
   for(const key of ['intentId','ownerId','generation','threadId','turnId','jobId'] as const)if(next[key]!==token[key])throw new TypeError('Native transition changed original identity');
   if(next.revision!==token.revision+1n||next.state!==state||next.detail!==Array.from(detail).slice(0,512).join(''))throw new TypeError('Native transition result does not match original CAS');return next;
  },signal);
 }
 /** Caller must retain the exact exited child; these identities do not prove exit.
  * One idempotent existing-store statement, with no automatic replay on uncertainty. */
 settleExitedOwner(owner:string,generation:bigint,signal?:AbortSignal):Promise<void>{
  this.#ready(signal,true);owner=text(owner);if(typeof generation!=='bigint'||generation<0n||generation>=(1n<<63n))throw new RangeError('Idle generation must fit signed i64');
  const nonce=randomUUID();
  return this.#run('settleExitedOwner',{owner,generation,nonce},true,value=>{
   const ack=cloneOwnedSerdeValue(value),keys=['operation','path','owner','generation','nonce'];
   if(ack===null||typeof ack!=='object'||Array.isArray(ack)||Object.keys(ack).length!==keys.length||keys.some(key=>!Object.hasOwn(ack,key))||own(ack,'operation')!=='settleExitedOwner'||own(ack,'path')!==this.#path||own(ack,'owner')!==owner||own(ack,'generation')!==generation||own(ack,'nonce')!==nonce)throw new TypeError('Native idle exit acknowledgement changed original invocation');
  },signal);
 }
 #run<T>(operation:'before'|'transition'|'settleExitedOwner'|'validateInstallation',input:object,completion:boolean,decode:(value:unknown)=>T,signal?:AbortSignal):Promise<T>{
  const controller=new AbortController(),slot=new OwnedWorkerSlot('Control');this.#controllers.add(controller);const abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const task=(async()=>{let admitted=false;try{
   const url=new URL('./native-idle-before-worker.ts',import.meta.url),data={path:this.#path,operation,...input};
   const pending=completion?slot.runControlCompletion(url,data,this.#timeout,controller.signal):slot.run(url,data,this.#timeout,controller.signal);admitted=slot.busy;
   let raw:unknown;try{raw=await pending;}finally{await slot.join();}controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,65536)===null||own(raw,'ok')!==true||((operation==='settleExitedOwner'||operation==='validateInstallation')&&(raw===null||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==2||!Object.hasOwn(raw,'value'))))throw new Error('Native idle operation did not return confirmed result');return decode(own(raw,'value'));
  }catch(error){if(!admitted)throw error;let safe='native idle operation result unavailable';try{const rendered=this.#render(safe);if(types.isPromise(rendered))void Promise.prototype.then.call(rendered,undefined,()=>undefined);safe=text(rendered,12000);}catch{/* No raw error or claim fallback. */}throw new IdleObservationError(`${safe}; original target requires reconciliation; no automatic retry`);}
  finally{signal?.removeEventListener('abort',abort);}})();
  this.#tasks.add(task);const clear=()=>{this.#tasks.delete(task);this.#controllers.delete(controller);};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('Native idle owner closed')):Promise<void>{this.#closed=true;for(const c of this.#controllers)c.abort(reason);await Promise.allSettled([...this.#tasks]);}
}
Object.freeze(NativeIdleBeforeOwner.prototype);
