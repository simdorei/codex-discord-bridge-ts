import {types} from 'node:util';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {snapshotStoredDelivery,type StoredDelivery} from '../../store/delivery.ts';
import type {FinalReadiness} from '../../store/delivery-preflight.ts';
import {requireDiscordText} from '../../discord/text.ts';
type Operation='Confirmed'|'Preflight'|'Failure'|'Complete';
export class NativeFinalStateUnconfirmedError extends Error{
 readonly operation:Operation;
 constructor(operation:Operation,cause:unknown){super('Final state result unconfirmed after native join; no automatic retry',{cause});this.name='NativeFinalStateUnconfirmedError';this.operation=operation;}
}
/** One fixed final snapshot. Original SQL and transaction boundaries run wholly
 * in a native worker. Readiness is not permission to send or bypass receipt guards.
 * A timed-out write may commit later; ownership remains until actual native exit. */
export class NativeFinalStateOwner{
 readonly #path:string;readonly #pending:StoredDelivery;readonly #timeout:number;readonly #slot=new OwnedWorkerSlot('Control');
 #closed=false;#task:Promise<unknown>|null=null;#controller:AbortController|null=null;
 constructor(path:string,input:StoredDelivery,timeoutMs=5000){
  requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid final store path');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid final state deadline');
  this.#path=pinNativeRuntimePath(path);this.#pending=Object.freeze(snapshotStoredDelivery(input));this.#timeout=timeoutMs;
 }
 get busy():boolean{return this.#task!==null;}
 async confirmed(input:readonly string[]):Promise<boolean>{
  const chunks=cloneOwnedSerdeValue(input);if(!Array.isArray(chunks))throw new TypeError('Expected original rendered chunks');for(const chunk of chunks)requireDiscordText(chunk);
  return this.#boolean('Confirmed',{pending:this.#pending,chunks});
 }
 async preflight():Promise<FinalReadiness>{
  const raw=await this.#run('Preflight',{pending:this.#pending});try{
   const kind=own(raw,'kind');if(kind==='Ready'||kind==='Commentary'||kind==='GoalProgress')return Object.freeze({kind});
   if(kind==='Held'){const reason=own(raw,'reason');requireDiscordText(reason);return Object.freeze({kind,reason});}
   if(kind==='FirstReply'){const request=own(raw,'request');requireDiscordText(request);return Object.freeze({kind,request});}
   throw new TypeError('Invalid native final readiness');
  }catch(error){throw new NativeFinalStateUnconfirmedError('Preflight',error);}
 }
 async recordFailure(display:string,now:number):Promise<void>{
  requireDiscordText(display);if(typeof now!=='number'||!Number.isFinite(now)||now<0)throw new RangeError('Expected finite Unix failure timestamp');
  // Do not pretruncate: original trim then scalar cap must occur exactly once.
  if(await this.#run('Failure',{id:this.#pending.deliveryId,display,now})!==true)throw new NativeFinalStateUnconfirmedError('Failure',new TypeError('Invalid failure acknowledgement'));
 }
 complete():Promise<boolean>{return this.#boolean('Complete',{id:this.#pending.deliveryId});}
 async #boolean(operation:Operation,fields:object):Promise<boolean>{const value=await this.#run(operation,fields);if(typeof value!=='boolean')throw new NativeFinalStateUnconfirmedError(operation,new TypeError('Invalid final mutation result'));return value;}
 #run(operation:Operation,fields:object):Promise<unknown>{
  if(this.#closed)throw new Error('Final state owner is closed');if(this.#task!==null)throw new OwnedWorkerBusyError();
  const data={path:this.#path,operation,...fields};if(boundedSerdeByteCount(data,16*1024*1024)===null)throw new RangeError('Final state input exceeds native wire budget');
  const controller=new AbortController();this.#controller=controller;
  const task=(async()=>{let admitted=false;try{
   const url=new URL('./native-final-state-worker.ts',import.meta.url);
   const pending=operation==='Confirmed'||operation==='Preflight'?this.#slot.run(url,data,this.#timeout,controller.signal):this.#slot.runControlCompletion(url,data,this.#timeout,controller.signal);admitted=this.#slot.busy;
   let raw:unknown;try{raw=await pending;}finally{await this.#slot.join();}controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,16*1024*1024)===null||own(raw,'ok')!==true)throw new Error('No confirmed native final state result');return own(raw,'value');
  }catch(error){if(admitted)throw new NativeFinalStateUnconfirmedError(operation,error);throw error;}})();
  this.#task=task;const clear=()=>{this.#task=null;this.#controller=null;};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('Final state owner closed')):Promise<void>{this.#closed=true;this.#controller?.abort(reason);if(this.#task!==null)await Promise.allSettled([this.#task]);}
}
Object.freeze(NativeFinalStateOwner.prototype);
