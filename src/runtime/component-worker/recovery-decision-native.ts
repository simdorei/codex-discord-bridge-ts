import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import type {ComponentId} from '../../discord/components.ts';
import {routedComponentCustomId} from '../../discord/interaction-routing.ts';
import {serdeValueEqual} from '../../core/serde-value-equal.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {snapshotInboundInteractionWork,type InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
import {snapshotComponentId} from '../discord-dispatch/delivery-identity.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {captureRecoveryDecisionClick,recoveryText,type RecoveryDecisionClick,type RecoveryDecisionSnapshot} from '../../store/recovery-decision-binding.ts';
import {recoveryDecisionBinding,parseRecoverySnapshot,parseRecoveryReceipt,RECOVERY_DECISION_REQUEST_BYTES,RECOVERY_DECISION_REPLY_BYTES,type RecoveryDecisionOperation,type RecoveryDecisionReceipt} from './recovery-decision-native-snapshot.ts';
export interface NativeRecoveryDecisionHandle {readonly proposalId:string}
type Held={readonly click:RecoveryDecisionClick;readonly handle:NativeRecoveryDecisionHandle;snapshot:RecoveryDecisionSnapshot|null;phase:'Reading'|'IngressChecked'|'Deciding'|'Decided'|'Unknown'};
export class NativeRecoveryDecisionUnknownError extends Error {
 readonly handle:NativeRecoveryDecisionHandle;
 constructor(handle:NativeRecoveryDecisionHandle,cause:unknown){super('Recovery decision result is unconfirmed after native exit; no fresh decision, replay or hold release is authorized',{cause});this.name='NativeRecoveryDecisionUnknownError';this.handle=handle;Object.freeze(this);}
}
export class NativeRecoveryDecisionReadError extends Error {constructor(cause:unknown){super('Recovery decision read unavailable after native join',{cause});this.name='NativeRecoveryDecisionReadError';}}
function signalCheck(signal:AbortSignal|undefined):void {if(signal!==undefined){if(types.isProxy(signal)||Object.getPrototypeOf(signal)!==AbortSignal.prototype||['throwIfAborted','aborted','reason','addEventListener','removeEventListener'].some(key=>Object.hasOwn(signal,key)))throw new TypeError('Expected unmodified native AbortSignal');AbortSignal.prototype.throwIfAborted.call(signal);}}
/** One retained executor owner for both flows. Every operation has zero Control
 * queue, including first decision: a read handle is not completion authority.
 * Unknown mutation blocks both flows permanently in this runtime owner. Explicit
 * exact-original recovery reads only, and cannot clear that barrier or mint a
 * fresh mutation. Each native job is joined through real exit before release. */
export class NativeRecoveryDecisionOwner {
 readonly #path:string;readonly #timeout:number;readonly #handles=new WeakMap<object,Held>();readonly #tasks=new Set<Promise<unknown>>();readonly #controllers=new Set<AbortController>();#closed=false;#unresolved:NativeRecoveryDecisionUnknownError|undefined;
 constructor(path:string,timeoutMs=5000){recoveryText(path,32768);if(path.includes('\0'))throw new TypeError('Invalid recovery database');this.#path=pinNativeRuntimePath(path);recoveryText(this.#path,32768);if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid recovery deadline');this.#timeout=timeoutMs;Object.freeze(this);}
 get busy():boolean{return this.#tasks.size>0;}
 requireDatabase(path:string):void {recoveryText(path,32768);if(pinNativeRuntimePath(path)!==this.#path)throw new TypeError('Recovery owner belongs to another database');}
 capture(input:InboundInteractionWork,inputComponent:ComponentId):NativeRecoveryDecisionHandle {
  if(this.#closed)throw new Error('Recovery owner closed');
  let click:RecoveryDecisionClick;
  try{const work=snapshotInboundInteractionWork(input),component=snapshotComponentId(inputComponent);
   if(pinNativeRuntimePath(work.custodyDatabase)!==this.#path||!('Component'in work.work)||!serdeValueEqual(component,work.work.Component))throw new TypeError('Crossed original recovery work');
   click=captureRecoveryDecisionClick({interactionIngressId:work.custodyIngressId,interactionId:work.interactionId,applicationId:work.applicationId,actorId:work.userId,channelId:work.channelId,sourceMessageId:work.sourceMessageId,customId:routedComponentCustomId(work.work),processingMode:work.processingMode});
  }catch(error){throw this.#unresolved??error;}
  if(this.#unresolved!==undefined){const held=this.#held(this.#unresolved.handle);if(held.phase==='Unknown'&&serdeValueEqual(click,held.click))return held.handle;throw this.#unresolved;}
  const handle=Object.freeze({proposalId:click.proposalId});this.#handles.set(handle,{click,handle,snapshot:null,phase:'Reading'});return handle;
 }
 #held(handle:NativeRecoveryDecisionHandle):Held {const held=this.#handles.get(handle);if(held===undefined)throw new TypeError('Expected original private recovery handle');return held;}
 /** A later exact-original handler invocation may lock this retained target and
  * read its receipt. It receives no executable handle or new mutation authority. */
 recoveryTarget(handle:NativeRecoveryDecisionHandle):string|null {const held=this.#held(handle);if(this.#unresolved===undefined)return null;if(this.#unresolved.handle!==handle||held.snapshot===null||held.phase!=='Unknown')throw this.#unresolved;return held.snapshot.proposal.thread_id;}
 #executable(held:Held):void {if(this.#unresolved!==undefined)throw this.#unresolved;if(held.phase!=='Reading'&&held.phase!=='IngressChecked')throw new TypeError('Original recovery decision is not executable');}
 async read(handle:NativeRecoveryDecisionHandle,now:number,signal?:AbortSignal):Promise<RecoveryDecisionSnapshot> {
  const held=this.#held(handle);this.#executable(held);const raw=await this.#run('Read',held,now,signal);
  try{const snapshot=parseRecoverySnapshot(raw,held.click);if(held.snapshot!==null&&(snapshot.sealJson!==held.snapshot.sealJson||snapshot.displayedJson!==held.snapshot.displayedJson))throw new TypeError('Original recovery seal changed');held.snapshot??=snapshot;return snapshot;}catch(error){throw new NativeRecoveryDecisionReadError(error);}
 }
 async ingress(handle:NativeRecoveryDecisionHandle,signal?:AbortSignal):Promise<void> {const held=this.#held(handle);this.#executable(held);if(held.snapshot===null)throw new TypeError('Original proposal required');if(await this.#run('Ingress',held,0,signal)!==true)throw new NativeRecoveryDecisionReadError(new TypeError('Invalid recovery ingress acknowledgement'));held.phase='IngressChecked';}
 async decide(handle:NativeRecoveryDecisionHandle,now:number,signal?:AbortSignal):Promise<RecoveryDecisionReceipt> {
  const held=this.#held(handle);this.#executable(held);if(held.snapshot===null||held.phase!=='IngressChecked')throw new TypeError('Original ingress read required');held.phase='Deciding';
  try{const raw=await this.#run('Decide',held,now,signal);let receipt:RecoveryDecisionReceipt;try{receipt=parseRecoveryReceipt(raw,held.click,held.snapshot,false);}catch(error){throw this.#unknown(held,error);}held.phase='Decided';return receipt;}
  catch(error){held.phase=error instanceof NativeRecoveryDecisionUnknownError?'Unknown':'IngressChecked';throw error;}
 }
 /** Only this exact private original can inspect its receipt after uncertainty. */
 async recover(handle:NativeRecoveryDecisionHandle,signal?:AbortSignal):Promise<RecoveryDecisionReceipt|null> {
  const held=this.#held(handle);if(this.#unresolved?.handle!==handle||held.snapshot===null||held.phase!=='Unknown')throw new TypeError('Expected exact original uncertain recovery decision');
  const raw=await this.#run('Recover',held,0,signal);if(raw===null)return null;try{return parseRecoveryReceipt(raw,held.click,held.snapshot,true);}catch(error){throw new NativeRecoveryDecisionReadError(error);}
 }
 #unknown(held:Held,cause:unknown):NativeRecoveryDecisionUnknownError {const error=new NativeRecoveryDecisionUnknownError(held.handle,cause);this.#unresolved??=error;return error;}
 #run(operation:RecoveryDecisionOperation,held:Held,now:number,signal?:AbortSignal):Promise<unknown> {
  signalCheck(signal);if(this.#closed)throw new Error('Recovery owner closed');if(this.#tasks.size>0)throw new OwnedWorkerBusyError();
  const binding=recoveryDecisionBinding(randomUUID(),this.#path,operation,held.click,held.snapshot?.sealJson??null,held.snapshot?.displayedJson??null,now);if(boundedSerdeByteCount(binding,RECOVERY_DECISION_REQUEST_BYTES)===null)throw new RangeError('Recovery decision exceeds native boundary');
  const slot=new OwnedWorkerSlot('Control'),controller=new AbortController(),abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();this.#controllers.add(controller);
  const task=(async()=>{let admitted=false;try{const pending=slot.run(new URL('./recovery-decision-native-worker.ts',import.meta.url),binding,this.#timeout,controller.signal);admitted=slot.busy;let raw:unknown;try{raw=await pending;}finally{await slot.join();}controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,RECOVERY_DECISION_REPLY_BYTES)===null||raw===null||typeof raw!=='object'||Object.keys(raw).length!==Object.keys(binding).length+2)throw new TypeError('Invalid recovery acknowledgement');for(const [key,value]of Object.entries(binding))if(!Object.is(own(raw,key),value))throw new TypeError('Crossed recovery acknowledgement');if(own(raw,'ok')!==true)throw new TypeError('Recovery result unavailable');return own(raw,'value');
  }catch(error){if(admitted&&operation==='Decide')throw this.#unknown(held,error);if(admitted)throw new NativeRecoveryDecisionReadError(error);throw error;}finally{signal?.removeEventListener('abort',abort);}})();
  this.#tasks.add(task);const clear=()=>{this.#tasks.delete(task);this.#controllers.delete(controller);};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('Recovery owner closed')):Promise<void> {this.#closed=true;for(const controller of this.#controllers)controller.abort(reason);await Promise.allSettled([...this.#tasks]);}
}
Object.freeze(NativeRecoveryDecisionOwner.prototype);
