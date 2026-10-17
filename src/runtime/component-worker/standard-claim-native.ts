import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {parseComponentId,type ComponentId} from '../../discord/components.ts';
import {routedComponentCustomId} from '../../discord/interaction-routing.ts';
import {serdeValueEqual} from '../../core/serde-value-equal.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {snapshotInboundInteractionWork,type InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
import {snapshotComponentId} from '../discord-dispatch/delivery-identity.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {captureStandardClaimIdentity,standardClaimBinding,STANDARD_CLAIM_REQUEST_BYTES,STANDARD_CLAIM_REPLY_BYTES,type StandardClaimIdentity,type StandardClaimOperation} from './standard-claim-snapshot.ts';
export interface NativeStandardClaim{readonly actionClaim:string;readonly readyMarker:string}
export type NativeStandardClaimResult={readonly kind:'ExecuteAction';readonly claim:NativeStandardClaim}|{readonly kind:'ActionUnconfirmed'|'DeliverConfirmation'};
export class NativeStandardClaimUnknownError extends Error{
 readonly operation:StandardClaimOperation;readonly identity:StandardClaimIdentity;
 constructor(operation:StandardClaimOperation,identity:StandardClaimIdentity,cause:unknown){super('Standard component claim result unconfirmed after native exit; no action, release or automatic replay',{cause});this.name='NativeStandardClaimUnknownError';this.operation=operation;this.identity=identity;Object.freeze(this);}
}
function signalCheck(signal:AbortSignal|undefined):void{
 if(signal!==undefined){if(types.isProxy(signal)||Object.getPrototypeOf(signal)!==AbortSignal.prototype||['throwIfAborted','aborted','reason','addEventListener','removeEventListener'].some(key=>Object.hasOwn(signal,key)))throw new TypeError('Expected unmodified native AbortSignal');AbortSignal.prototype.throwIfAborted.call(signal);}
}
/** Installed standard-only persistence owner. It never verifies prompt authority
 * or performs/responds to an action. A private one-use handle proves only the
 * original claim commit. New claims have zero queue; owned Ready/Release use the
 * finite Control completion FIFO. Actual native exit precedes every settlement.
 * One unresolved mutation blocks new claims for this owner. An explicit same-
 * action click may only read its ready marker; absent ready never reclaims, even
 * after expiry. This bounded runtime barrier is not crash/restart reconciliation. */
export class NativeStandardClaimOwner{
 readonly #path:string;readonly #claims=new WeakMap<object,{identity:StandardClaimIdentity;used:boolean}>();
 readonly #timeout:number;readonly #tasks=new Set<Promise<unknown>>();readonly #controllers=new Set<AbortController>();#closed=false;#unresolved:NativeStandardClaimUnknownError|undefined;
 constructor(path:string,timeoutMs=5000){requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid standard claim path');this.#path=pinNativeRuntimePath(path);if(Buffer.byteLength(this.#path)>32768)throw new RangeError('Standard claim path exceeds native budget');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid standard claim deadline');this.#timeout=timeoutMs;Object.freeze(this);}
 get busy():boolean{return this.#tasks.size>0;}
 requireDatabase(path:string):void{requireDiscordText(path);if(pinNativeRuntimePath(path)!==this.#path)throw new TypeError('Standard claim owner belongs to another database');}
 #capture(work:InboundInteractionWork,input:ComponentId):StandardClaimIdentity{
  const captured=snapshotInboundInteractionWork(work),component=snapshotComponentId(input),customId=routedComponentCustomId(captured.work);
  if(pinNativeRuntimePath(captured.custodyDatabase)!==this.#path||captured.processingMode!=='Execute'||!('Component'in captured.work)||!serdeValueEqual(component,captured.work.Component)||!serdeValueEqual(component,parseComponentId(customId)))throw new TypeError('Crossed original standard component work');
  return captureStandardClaimIdentity({interactionIngressId:captured.custodyIngressId,interactionId:captured.interactionId,applicationId:captured.applicationId,actorId:captured.userId,channelId:captured.channelId,sourceMessageId:captured.sourceMessageId,customId});
 }
 async claim(work:InboundInteractionWork,input:ComponentId,now:number,signal?:AbortSignal):Promise<NativeStandardClaimResult>{
  signalCheck(signal);const identity=this.#capture(work,input);
  if(this.#unresolved!==undefined&&(this.#unresolved.identity.actionClaim!==identity.actionClaim||this.#unresolved.identity.applicationId!==identity.applicationId))throw this.#unresolved;
  const operation=this.#unresolved===undefined?'Claim':'RecoverReady',value=await this.#run(operation,identity,now,signal);
  if(value==='ExecuteAction'&&operation==='Claim'){const claim=Object.freeze({actionClaim:identity.actionClaim,readyMarker:identity.readyMarker});this.#claims.set(claim,{identity,used:false});return Object.freeze({kind:'ExecuteAction',claim});}
  if(value==='DeliverConfirmation'||value==='ActionUnconfirmed')return Object.freeze({kind:value});
  throw this.#unknown(operation,identity,new TypeError('Invalid standard claim state'));
 }
 ready(claim:NativeStandardClaim,now:number):Promise<void>{return this.#finish('Ready',claim,now);}
 release(claim:NativeStandardClaim):Promise<void>{return this.#finish('Release',claim,0);}
 #finish(operation:'Ready'|'Release',claim:NativeStandardClaim,now:number):Promise<void>{
  const held=this.#claims.get(claim);if(held===undefined||held.used)throw new TypeError('Expected unused original native standard claim');
  held.used=true;
  try{return this.#run(operation,held.identity,now).then(value=>{if(typeof value!=='boolean')throw this.#unknown(operation,held.identity,new TypeError('Invalid standard claim completion'));});}
  catch(error){held.used=false;throw error;} // Proven synchronous refusal submitted no completion.
 }
 #unknown(operation:StandardClaimOperation,identity:StandardClaimIdentity,cause:unknown):NativeStandardClaimUnknownError{
  const error=new NativeStandardClaimUnknownError(operation,identity,cause);if(operation!=='RecoverReady')this.#unresolved??=error;return error;
 }
 #run(operation:StandardClaimOperation,identity:StandardClaimIdentity,now:number,signal?:AbortSignal):Promise<unknown>{
  signalCheck(signal);if(this.#closed)throw new Error('Standard claim owner closed');if((operation==='Claim'||operation==='RecoverReady')&&this.#tasks.size>0)throw new OwnedWorkerBusyError();
  const binding=standardClaimBinding(randomUUID(),this.#path,operation,identity,now);if(boundedSerdeByteCount(binding,STANDARD_CLAIM_REQUEST_BYTES)===null)throw new RangeError('Standard claim exceeds native budget');
  const slot=new OwnedWorkerSlot('Control'),controller=new AbortController(),abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();this.#controllers.add(controller);
  const task=(async()=>{let admitted=false;try{
   const url=new URL('./standard-claim-native-worker.ts',import.meta.url),pending=operation==='Ready'||operation==='Release'?slot.runControlCompletion(url,binding,this.#timeout,controller.signal):slot.run(url,binding,this.#timeout,controller.signal);admitted=slot.busy;
   let raw:unknown;try{raw=await pending;}finally{await slot.join();}controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,STANDARD_CLAIM_REPLY_BYTES)===null||raw===null||typeof raw!=='object'||Object.keys(raw).length!==Object.keys(binding).length+2)throw new TypeError('Invalid standard claim acknowledgement');
   for(const [key,value]of Object.entries(binding))if(!Object.is(own(raw,key),value))throw new TypeError('Crossed standard claim acknowledgement');
   if(own(raw,'ok')!==true)throw new TypeError('Standard claim acknowledgement unavailable');return own(raw,'value');
  }catch(error){if(admitted)throw this.#unknown(operation,identity,error);throw error;}finally{signal?.removeEventListener('abort',abort);}})();
  this.#tasks.add(task);const clear=()=>{this.#tasks.delete(task);this.#controllers.delete(controller);};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('Standard claim owner closed')):Promise<void>{this.#closed=true;for(const controller of this.#controllers)controller.abort(reason);await Promise.allSettled([...this.#tasks]);}
}
Object.freeze(NativeStandardClaimOwner.prototype);
