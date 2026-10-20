import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {parseComponentId,type ComponentId,type BusyAction} from '../../discord/components.ts';
import {routedComponentCustomId} from '../../discord/interaction-routing.ts';
import {serdeValueEqual} from '../../core/serde-value-equal.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {snapshotInboundInteractionWork,type InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
import {snapshotComponentId} from '../discord-dispatch/delivery-identity.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {serializeBusyChoice,type BusyChoice} from '../../store/busy-choice.ts';
import {captureBusyClaimIdentity,busyClaimBinding,BUSY_CLAIM_REQUEST_BYTES,BUSY_CLAIM_REPLY_BYTES,type BusyClaimIdentity,type BusyClaimOperation} from './busy-claim-snapshot.ts';
export interface NativeBusyClaim{readonly choiceId:string;readonly readyMarker:string}
export type NativeBusyClaimResult={readonly kind:'ExecuteAction';readonly claim:NativeBusyClaim}|{readonly kind:'ActionUnconfirmed'|'DeliverConfirmation'|'ExecuteQueue'|'Missing'};
export class NativeBusyClaimUnknownError extends Error{
 readonly operation:BusyClaimOperation;readonly identity:BusyClaimIdentity;
 constructor(operation:BusyClaimOperation,identity:BusyClaimIdentity,cause:unknown){super('Busy component claim result unconfirmed after native exit; no action, release or automatic replay',{cause});this.name='NativeBusyClaimUnknownError';this.operation=operation;this.identity=identity;Object.freeze(this);}
}
function signalCheck(signal:AbortSignal|undefined):void{
 if(signal!==undefined){if(types.isProxy(signal)||Object.getPrototypeOf(signal)!==AbortSignal.prototype||['throwIfAborted','aborted','reason','addEventListener','removeEventListener'].some(key=>Object.hasOwn(signal,key)))throw new TypeError('Expected unmodified native AbortSignal');AbortSignal.prototype.throwIfAborted.call(signal);}
}
/** Executor-shared Busy persistence owner. Queue keeps its separate atomic
 * intake/ready acceptance; this owner only reads its ready marker. Non-Queue
 * claims preserve ready -> state -> claim -> ready source ordering. One-use
 * handles settle only the original claim, through the owned completion FIFO.
 * Resolution is one-use and shares this owner's mutation barrier.
 * Unknown mutations block every fresh claim and resolution, even after TTL; explicit same-
 * original recovery reads only durable ready. Native exit is always joined.
 * This barrier is runtime-local, not restart/crash reconciliation. */
export class NativeBusyClaimOwner{
 readonly #path:string;readonly #claims=new WeakMap<object,{identity:BusyClaimIdentity;used:boolean;resolution:'Unused'|'Pending'|'Confirmed'|'Unknown'}>();
 readonly #timeout:number;readonly #tasks=new Set<Promise<unknown>>();readonly #controllers=new Set<AbortController>();#closed=false;#unresolved:NativeBusyClaimUnknownError|undefined;
 constructor(path:string,timeoutMs=5000){requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid Busy claim path');this.#path=pinNativeRuntimePath(path);if(Buffer.byteLength(this.#path)>32768)throw new RangeError('Busy claim path exceeds native budget');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid Busy claim deadline');this.#timeout=timeoutMs;Object.freeze(this);}
 get busy():boolean{return this.#tasks.size>0;}
 requireDatabase(path:string):void{requireDiscordText(path);if(pinNativeRuntimePath(path)!==this.#path)throw new TypeError('Busy claim owner belongs to another database');}
 #capture(work:InboundInteractionWork,input:ComponentId,confirmationOnly=false):BusyClaimIdentity{
  const captured=snapshotInboundInteractionWork(work),component=snapshotComponentId(input),customId=routedComponentCustomId(captured.work);
  if(pinNativeRuntimePath(captured.custodyDatabase)!==this.#path||(!confirmationOnly&&captured.processingMode!=='Execute')||!('Component'in captured.work)||!serdeValueEqual(component,captured.work.Component)||!serdeValueEqual(component,parseComponentId(customId)))throw new TypeError('Crossed original Busy component work');
  return captureBusyClaimIdentity({interactionIngressId:captured.custodyIngressId,interactionId:captured.interactionId,applicationId:captured.applicationId,actorId:captured.userId,channelId:captured.channelId,sourceMessageId:captured.sourceMessageId,customId,choiceJson:captured.authorizedBusyChoice===null?null:serializeBusyChoice(captured.authorizedBusyChoice)});
 }
 async claim(work:InboundInteractionWork,input:ComponentId,now:number,signal?:AbortSignal):Promise<NativeBusyClaimResult>{
  signalCheck(signal);const identity=this.#capture(work,input);
  if(this.#unresolved!==undefined&&!this.#sameOriginal(this.#unresolved.identity,identity))throw this.#unresolved;
  const operation=this.#unresolved!==undefined?'RecoverReady':identity.action==='Queue'?'ReadReady':'Claim',value=await this.#run(operation,identity,now,signal);
  if(value==='ExecuteAction'&&operation==='Claim'){const claim=Object.freeze({choiceId:identity.choiceId,readyMarker:identity.readyMarker});this.#claims.set(claim,{identity,used:false,resolution:'Unused'});return Object.freeze({kind:'ExecuteAction',claim});}
  if(value==='ActionUnconfirmed'&&operation==='ReadReady')return Object.freeze({kind:'ExecuteQueue'});
  if(value==='Missing'&&operation==='Claim')return Object.freeze({kind:'Missing'});
  if(value==='DeliverConfirmation'||value==='ActionUnconfirmed')return Object.freeze({kind:value});
  throw this.#unknown(operation,identity,new TypeError('Invalid Busy claim state'));
 }
 #sameOriginal(a:BusyClaimIdentity,b:BusyClaimIdentity):boolean{
  return a.applicationId===b.applicationId&&a.actorId===b.actorId&&a.channelId===b.channelId&&a.sourceMessageId===b.sourceMessageId&&a.customId===b.customId&&a.choiceJson===b.choiceJson;
 }
 async confirmationReady(work:InboundInteractionWork,input:ComponentId,now:number,signal?:AbortSignal):Promise<boolean>{
  signalCheck(signal);const identity=this.#capture(work,input,true),value=await this.#run('ReadReady',identity,now,signal);
  if(value==='DeliverConfirmation'||value==='ActionUnconfirmed')return value==='DeliverConfirmation';
  throw this.#unknown('ReadReady',identity,new TypeError('Invalid Busy ready state'));
 }
 /** Only the original private claim may resolve, once, while its caller owns
  * the target lease. A confirmed result still permits Ready/Release; an unknown
  * mutation permits neither completion nor another resolution. */
 resolve(claim:NativeBusyClaim,choice:BusyChoice,action:BusyAction,signal?:AbortSignal):Promise<string|null>{
  signalCheck(signal);const held=this.#claims.get(claim);
  if(held===undefined||held.used||held.resolution!=='Unused')throw new TypeError('Expected unresolved original native Busy claim');
  if(held.identity.choiceJson!==serializeBusyChoice(choice)||held.identity.action!==action||(action!=='Stop'&&action!=='Steer'))throw new TypeError('Crossed original Busy resolution authority');
  if(this.#unresolved!==undefined)throw this.#unresolved;
  held.resolution='Pending';let task:Promise<unknown>;
  try{task=this.#run('Resolve',held.identity,0,signal);}catch(error){held.resolution='Unused';throw error;}
  return task.then(value=>{
   if(value!==null){try{requireDiscordText(value);}catch(error){throw this.#unknown('Resolve',held.identity,error);}}
   held.resolution='Confirmed';return value as string|null;
  }).catch(error=>{held.resolution=error instanceof NativeBusyClaimUnknownError?'Unknown':'Unused';throw error;});
 }
 ready(claim:NativeBusyClaim,now:number):Promise<void>{return this.#finish('Ready',claim,now);}
 release(claim:NativeBusyClaim):Promise<void>{return this.#finish('Release',claim,0);}
 #finish(operation:'Ready'|'Release',claim:NativeBusyClaim,now:number):Promise<void>{
  const held=this.#claims.get(claim);if(held===undefined||held.used||held.resolution==='Pending'||held.resolution==='Unknown')throw new TypeError('Expected unused confirmed native Busy claim');
  held.used=true;
  try{return this.#run(operation,held.identity,now).then(value=>{if(typeof value!=='boolean')throw this.#unknown(operation,held.identity,new TypeError('Invalid Busy claim completion'));});}
  catch(error){held.used=false;throw error;} // Proven synchronous refusal submitted no completion.
 }
 #unknown(operation:BusyClaimOperation,identity:BusyClaimIdentity,cause:unknown):NativeBusyClaimUnknownError{
  const error=new NativeBusyClaimUnknownError(operation,identity,cause);if(operation!=='RecoverReady'&&operation!=='ReadReady')this.#unresolved??=error;return error;
 }
 #run(operation:BusyClaimOperation,identity:BusyClaimIdentity,now:number,signal?:AbortSignal):Promise<unknown>{
  signalCheck(signal);if(this.#closed)throw new Error('Busy claim owner closed');if((operation==='Claim'||operation==='RecoverReady'||operation==='ReadReady'||operation==='Resolve')&&this.#tasks.size>0)throw new OwnedWorkerBusyError();
  const binding=busyClaimBinding(randomUUID(),this.#path,operation,identity,now);if(boundedSerdeByteCount(binding,BUSY_CLAIM_REQUEST_BYTES)===null)throw new RangeError('Busy claim exceeds native budget');
  const slot=new OwnedWorkerSlot('Control'),controller=new AbortController(),abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();this.#controllers.add(controller);
  const task=(async()=>{let admitted=false;try{
   const url=new URL('./busy-claim-native-worker.ts',import.meta.url),pending=operation==='Ready'||operation==='Release'?slot.runControlCompletion(url,binding,this.#timeout,controller.signal):slot.run(url,binding,this.#timeout,controller.signal);admitted=slot.busy;
   let raw:unknown;try{raw=await pending;}finally{await slot.join();}controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,BUSY_CLAIM_REPLY_BYTES)===null||raw===null||typeof raw!=='object'||Object.keys(raw).length!==Object.keys(binding).length+2)throw new TypeError('Invalid Busy claim acknowledgement');
   for(const [key,value]of Object.entries(binding))if(!Object.is(own(raw,key),value))throw new TypeError('Crossed Busy claim acknowledgement');
   if(own(raw,'ok')!==true)throw new TypeError('Busy claim acknowledgement unavailable');return own(raw,'value');
  }catch(error){if(admitted)throw this.#unknown(operation,identity,error);throw error;}finally{signal?.removeEventListener('abort',abort);}})();
  this.#tasks.add(task);const clear=()=>{this.#tasks.delete(task);this.#controllers.delete(controller);};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('Busy claim owner closed')):Promise<void>{this.#closed=true;for(const controller of this.#controllers)controller.abort(reason);await Promise.allSettled([...this.#tasks]);}
}
Object.freeze(NativeBusyClaimOwner.prototype);
