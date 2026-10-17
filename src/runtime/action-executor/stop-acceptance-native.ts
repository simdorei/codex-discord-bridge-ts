import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {NativeBridgeStateOwner,type BridgeSelectionLease} from '../bridge-state-native.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {captureStopAcceptance,stopAcceptanceBinding,assertStopAcceptanceRequestBudget,STOP_ACCEPTANCE_REPLY_BYTES,type StopAcceptanceInput,type StopAcceptanceOperation,type StopAcceptanceDisplay} from './stop-acceptance-snapshot.ts';

function requireSignal(signal:AbortSignal|undefined):void{if(signal!==undefined&&(types.isProxy(signal)||Object.getPrototypeOf(signal)!==AbortSignal.prototype||['throwIfAborted','aborted','reason','addEventListener','removeEventListener'].some(key=>Object.hasOwn(signal,key))))throw new TypeError('Expected unmodified native AbortSignal');}

function checkSourceSignal(signal:AbortSignal|undefined):void{requireSignal(signal);if(signal!==undefined)AbortSignal.prototype.throwIfAborted.call(signal);}

/** Keep the submitted signal private: later caller property replacement cannot
 * execute a hook inside OwnedWorkerSlot setup/exit or strand its joined lease. */
function ownSignal(source:AbortSignal|undefined):{signal:AbortSignal|undefined;release:()=>void}{
 if(source===undefined)return {signal:undefined,release:()=>{}};
 const controller=new AbortController(),aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!,reason=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'reason')!.get!;
 const forward=()=>{if(aborted.call(source))controller.abort(reason.call(source));};
 EventTarget.prototype.addEventListener.call(source,'abort',forward,{once:true});forward();
 return {signal:controller.signal,release:()=>EventTarget.prototype.removeEventListener.call(source,'abort',forward)};
}

export class NativeStopAcceptanceUnknownError extends Error {
 readonly requestId:string;readonly operationId:string;readonly ingressKey:string;readonly eventId:bigint;
 readonly targetThreadId:string;readonly channelId:bigint;readonly ownerUserId:bigint;
 constructor(requestId:string,operation:StopAcceptanceOperation,cause:unknown){
  super('Stop acceptance has no confirmed acknowledgement after native exit; retain original ingress and operation for reconciliation, no interrupt or automatic retry',{cause});this.name='NativeStopAcceptanceUnknownError';
  this.requestId=requestId;this.operationId=operation.operationId;this.ingressKey=operation.ingress.ingressId;this.eventId=operation.ingress.eventId!;this.targetThreadId=operation.scope.target;this.channelId=operation.scope.channel;this.ownerUserId=operation.scope.owner;
 }
}
/** One fixed database, actual Bridge owner and Control1 zero-queue admission.
 * Running then Unresolved is one submission; only a confirmed no-Running read
 * permits the second transaction. Any uncertainty stops without another write.
 * Selected custody is held until real exit and parent validation, never cloned
 * from a callback. The existing single-native-owner/no-mixed-writers contract
 * remains mandatory; this does not fence external/legacy Bridge writers. */
export class NativeStopAcceptanceWriter {
 readonly #path:string;readonly #bridge:NativeBridgeStateOwner;readonly #slot=new OwnedWorkerSlot('Control');#active=false;
 constructor(path:string,bridge:NativeBridgeStateOwner){requireDiscordText(path);if(path.includes('\0')||path.length>32768||Buffer.byteLength(path)>32768)throw new TypeError('Invalid Stop database path');this.#path=pinNativeRuntimePath(path);if(Buffer.byteLength(this.#path)>32768)throw new RangeError('Stop database path exceeds budget');NativeBridgeStateOwner.prototype.path.call(bridge);this.#bridge=bridge;Object.freeze(this);}
 assertOwner(path:string,bridge:NativeBridgeStateOwner):void{if(pinNativeRuntimePath(path)!==this.#path||bridge!==this.#bridge)throw new TypeError('Stop writer belongs to another database or Bridge owner');}
 async execute(input:StopAcceptanceInput,signal?:AbortSignal,timeoutMs=6000):Promise<StopAcceptanceDisplay>{
  checkSourceSignal(signal);
  if(process.platform==='win32')throw new Error('Windows Stop acceptance is unqualified');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid Stop acceptance timeout');
  const operation=captureStopAcceptance(input);if(this.#active||this.#slot.busy)throw new OwnedWorkerBusyError();
  const id=randomUUID(),binding=stopAcceptanceBinding(id,this.#path,operation);assertStopAcceptanceRequestBudget(binding,operation);
  const sourceSignal=signal,ownedSignal=ownSignal(sourceSignal);signal=ownedSignal.signal;this.#active=true;
  let lease:BridgeSelectionLease|undefined,admitted=false;
  try{
   const token=operation.binding.route==='Selected'?await NativeBridgeStateOwner.prototype.captureSelected.call(this.#bridge,signal):null;checkSourceSignal(sourceSignal);signal?.throwIfAborted();
   // No await or caller callback between mint/extract and ordinary Control run.
   if(token!==null)lease=NativeBridgeStateOwner.prototype.holdSelected.call(this.#bridge,token,operation.scope.target,id,operation.operationId);
   const proof=lease===undefined?null:NativeBridgeStateOwner.prototype.selectedLeaseProof.call(this.#bridge,lease);
   const task=this.#slot.run(new URL('./stop-acceptance-native-worker.ts',import.meta.url),{...binding,operation,proof},timeoutMs,signal);admitted=this.#slot.busy;
   let raw:unknown;try{raw=await task;}finally{await this.#slot.join();if(lease!==undefined)NativeBridgeStateOwner.prototype.validateSelectedLease.call(this.#bridge,lease);}
   checkSourceSignal(sourceSignal);signal?.throwIfAborted();
   if(boundedSerdeByteCount(raw,STOP_ACCEPTANCE_REPLY_BYTES)===null)throw new TypeError('Stop acknowledgement exceeds budget');
   for(const [key,value] of Object.entries(binding))if(own(raw,key)!==value)throw new TypeError('Crossed Stop acknowledgement');
   if(own(raw,'ok')!==true)throw new TypeError('Stop acceptance acknowledgement unavailable');
   const result=own(raw,'value'),kind=own(result,'kind');if(own(result,'operationId')!==operation.operationId)throw new TypeError('Stop operation acknowledgement differs');
   if(kind==='Running'){if(operation.resident===null||Object.keys(result as object).length!==2)throw new TypeError('Invalid Running Stop receipt');return Object.freeze({kind,operationId:operation.operationId});}
   if(kind!=='Unresolved'||Object.keys(result as object).length!==4)throw new TypeError('Invalid Stop receipt');
   const jobs=own(result,'jobs'),ingresses=own(result,'ingresses');for(const n of [jobs,ingresses])if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0||n>128)throw new TypeError('Invalid Stop receipt count');
   return Object.freeze({kind,operationId:operation.operationId,jobs:jobs as number,ingresses:ingresses as number});
  }catch(error){if(admitted)throw new NativeStopAcceptanceUnknownError(id,operation,error);throw error;}
  finally{try{if(lease!==undefined)NativeBridgeStateOwner.prototype.releaseSelectedLease.call(this.#bridge,lease);}finally{try{ownedSignal.release();}finally{this.#active=false;}}}
 }
}
Object.freeze(NativeStopAcceptanceWriter.prototype);
