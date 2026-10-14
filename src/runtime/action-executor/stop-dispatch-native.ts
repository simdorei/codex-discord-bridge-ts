import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {NativeBridgeStateOwner,type BridgeSelectionSnapshot,type BridgeSelectionLease} from '../bridge-state-native.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import type {StopClaim,StopControl} from '../../store/stop-control-dispatch.ts';
import {snapshotSettingsBinding} from './settings-snapshot.ts';
import {captureStopDispatch,captureStopDispatchDiagnostic,stopDispatchBinding,assertStopDispatchRequestBudget,STOP_DISPATCH_REPLY_BYTES} from './stop-dispatch-snapshot.ts';

function checkSignal(signal:AbortSignal|undefined):void{
 if(signal!==undefined){if(types.isProxy(signal)||Object.getPrototypeOf(signal)!==AbortSignal.prototype||['throwIfAborted','aborted','reason','addEventListener','removeEventListener'].some(key=>Object.hasOwn(signal,key)))throw new TypeError('Expected unmodified native AbortSignal');AbortSignal.prototype.throwIfAborted.call(signal);}
}
/** Caller hooks never execute in OwnedWorkerSlot setup/exit. Check the native
 * source state again after join, including suppressed abort propagation. */
function ownSignal(source:AbortSignal|undefined):{signal:AbortSignal|undefined;release:()=>void}{
 if(source===undefined)return {signal:undefined,release:()=>{}};
 const controller=new AbortController(),aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!,reason=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'reason')!.get!;
 const forward=()=>{if(aborted.call(source))controller.abort(reason.call(source));};EventTarget.prototype.addEventListener.call(source,'abort',forward,{once:true});forward();
 return {signal:controller.signal,release:()=>EventTarget.prototype.removeEventListener.call(source,'abort',forward)};
}
/** Shared with the injected polling worker so its pre-verification Selected
 * capture also uses a private signal. Native source checks cannot be suppressed
 * by a caller's stopImmediatePropagation listener or later method replacement. */
export function isolateStopDispatchSignal(source:AbortSignal|undefined){
 checkSignal(source);const owned=ownSignal(source),aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!,reason=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'reason')!.get!;
 return Object.freeze({...owned,check:()=>{checkSignal(source);owned.signal?.throwIfAborted();},isCancellation:(error:unknown)=>source!==undefined&&aborted.call(source)&&error===reason.call(source)});
}
export class NativeStopClaimUnknownError extends Error{
 readonly requestId:string;readonly original:StopControl;readonly operationId:string;
 constructor(id:string,original:StopControl,cause:unknown){super('Stop claim has no confirmed acknowledgement after native exit; runtime dispatch is blocked pending original-authority reconciliation, no interrupt or retry',{cause});this.name='NativeStopClaimUnknownError';this.requestId=id;this.original=original;this.operationId=original.operation_id;}
}
export class NativeStopErrorPersistenceUnknownError extends Error{
 readonly requestId:string;readonly operationId:string;
 constructor(id:string,operationId:string,cause:unknown){super('Stop dispatch error persistence has no confirmed acknowledgement; retain original claim, no redispatch or persistence retry',{cause});this.name='NativeStopErrorPersistenceUnknownError';this.requestId=id;this.operationId=operationId;}
}
/** Fixed database/Bridge owner, shared by every factory-created Stop worker.
 * Ordinary claims have zero Control queue. One sticky unresolved original blocks
 * subsequent polls/claims, even after rollback plus lost ACK leaves it accepted.
 * This is runtime-local fail-closed ownership, NOT cross-restart reconciliation.
 * Only this owner's successful, one-use claim identity can enter completion FIFO. */
export class NativeStopDispatchWriter{
 readonly #path:string;readonly #bridge:NativeBridgeStateOwner;readonly #slot=new OwnedWorkerSlot('Control');readonly #receipts=new WeakSet<StopClaim>();
 #active=false;#unresolved:NativeStopClaimUnknownError|undefined;#reported=false;
 constructor(path:string,bridge:NativeBridgeStateOwner){requireDiscordText(path);if(path.includes('\0')||path.length>32768||Buffer.byteLength(path)>32768)throw new TypeError('Invalid Stop dispatch database path');this.#path=pinNativeRuntimePath(path);if(Buffer.byteLength(this.#path)>32768)throw new RangeError('Stop dispatch path exceeds byte budget');NativeBridgeStateOwner.prototype.path.call(bridge);this.#bridge=bridge;Object.freeze(this);}
 assertOwner(path:string,bridge:NativeBridgeStateOwner):void{if(pinNativeRuntimePath(path)!==this.#path||bridge!==this.#bridge)throw new TypeError('Stop dispatch writer belongs to another database or Bridge owner');}
 /** Throws the original uncertainty, never an empty page or synthetic success. */
 assertReady():void{if(this.#unresolved!==undefined)throw this.#unresolved;}
 ownsUnresolved(error:unknown):error is NativeStopClaimUnknownError{return this.#unresolved!==undefined&&error===this.#unresolved;}
 takeUnresolvedReport(error:unknown):boolean{if(error!==this.#unresolved||this.#unresolved===undefined||this.#reported)return false;this.#reported=true;return true;}
 async claim(input:StopControl,selected:BridgeSelectionSnapshot|null,signal?:AbortSignal,timeoutMs=6000):Promise<StopClaim|null>{
  NativeStopDispatchWriter.prototype.assertReady.call(this);checkSignal(signal);this.#profile(timeoutMs);const control=captureStopDispatch(input),route=snapshotSettingsBinding(control.binding).route;
  if((route==='Selected')!==(selected!==null))throw new TypeError('Stop claim requires the original route selection snapshot');
  if(this.#active||this.#slot.busy)throw new OwnedWorkerBusyError();const id=randomUUID(),binding=stopDispatchBinding(id,this.#path,'Claim',control);assertStopDispatchRequestBudget(binding,control,null,null);
  const source=signal,owned=ownSignal(source);signal=owned.signal;this.#active=true;let lease:BridgeSelectionLease|undefined,admitted=false;
  try{
   // Original token was captured BEFORE turn verification. Never capture anew.
   // No await or caller callback between lease mint, proof extraction and submit.
   if(selected!==null)lease=NativeBridgeStateOwner.prototype.holdSelected.call(this.#bridge,selected,control.target,id,control.operation_id);
   const proof=lease===undefined?null:NativeBridgeStateOwner.prototype.selectedLeaseProof.call(this.#bridge,lease);
   let raw:unknown;try{const task=this.#slot.run(new URL('./stop-dispatch-native-worker.ts',import.meta.url),{...binding,control,token:null,diagnostic:null,proof},timeoutMs,signal);admitted=this.#slot.busy;raw=await task;}
   finally{admitted=admitted||this.#slot.busy;await this.#slot.join();if(lease!==undefined)NativeBridgeStateOwner.prototype.validateSelectedLease.call(this.#bridge,lease);}
   checkSignal(source);signal?.throwIfAborted();const token=this.#ack(raw,binding);
   if(token===null)return null;if(typeof token!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(token))throw new TypeError('Invalid Stop claim token acknowledgement');
   const claim=Object.freeze({control,token});this.#receipts.add(claim);return claim;
  }catch(error){if(admitted){const unresolved=new NativeStopClaimUnknownError(id,control,error);this.#unresolved=unresolved;throw unresolved;}throw error;}
  finally{try{if(lease!==undefined)NativeBridgeStateOwner.prototype.releaseSelectedLease.call(this.#bridge,lease);}finally{try{owned.release();}finally{this.#active=false;}}}
 }
 async recordError(claim:StopClaim,error:string,signal?:AbortSignal,timeoutMs=6000):Promise<void>{
  if(!this.#receipts.has(claim))throw new TypeError('Expected unused successful claim from this Stop dispatch writer');
  // Consume on invocation, including refused/cancelled completion. No replay.
  this.#receipts.delete(claim);checkSignal(signal);this.#profile(timeoutMs);const diagnostic=captureStopDispatchDiagnostic(error);
  if(this.#active||this.#slot.busy)throw new OwnedWorkerBusyError();const id=randomUUID(),binding=stopDispatchBinding(id,this.#path,'Error',claim.control);assertStopDispatchRequestBudget(binding,claim.control,claim.token,diagnostic);
  const source=signal,owned=ownSignal(source);signal=owned.signal;this.#active=true;let admitted=false;
  try{
   let raw:unknown;try{const task=this.#slot.runControlCompletion(new URL('./stop-dispatch-native-worker.ts',import.meta.url),{...binding,control:claim.control,token:claim.token,diagnostic,proof:null},timeoutMs,signal);admitted=this.#slot.busy;raw=await task;}
   finally{admitted=admitted||this.#slot.busy;await this.#slot.join();}checkSignal(source);signal?.throwIfAborted();if(this.#ack(raw,binding)!==null)throw new TypeError('Invalid Stop error acknowledgement');
  }catch(error){if(admitted)throw new NativeStopErrorPersistenceUnknownError(id,claim.control.operation_id,error);throw error;}
  finally{try{owned.release();}finally{this.#active=false;}}
 }
 #profile(timeoutMs:number):void{if(process.platform==='win32')throw new Error('Windows Stop dispatch is unqualified');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid Stop dispatch timeout');}
 #ack(raw:unknown,binding:ReturnType<typeof stopDispatchBinding>):unknown{
  if(boundedSerdeByteCount(raw,STOP_DISPATCH_REPLY_BYTES)===null||raw===null||typeof raw!=='object'||Object.keys(raw).length!==Object.keys(binding).length+2)throw new TypeError('Invalid bounded Stop dispatch acknowledgement');
  for(const [key,value] of Object.entries(binding))if(own(raw,key)!==value)throw new TypeError('Crossed Stop dispatch acknowledgement');if(own(raw,'ok')!==true)throw new TypeError('Stop dispatch acknowledgement unavailable');return own(raw,'token');
 }
}
Object.freeze(NativeStopDispatchWriter.prototype);
