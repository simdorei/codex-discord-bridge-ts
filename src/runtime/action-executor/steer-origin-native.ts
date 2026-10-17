import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {captureSteerOrigin,steerOriginBinding,STEER_ORIGIN_REQUEST_BYTES,STEER_ORIGIN_REPLY_BYTES,type SteerOriginWrite} from './steer-origin-snapshot.ts';
export type {SteerOriginWrite} from './steer-origin-snapshot.ts';
function checkSignal(signal:AbortSignal|undefined):void{
 if(signal!==undefined){if(types.isProxy(signal)||Object.getPrototypeOf(signal)!==AbortSignal.prototype||['throwIfAborted','aborted','reason','addEventListener','removeEventListener'].some(key=>Object.hasOwn(signal,key)))throw new TypeError('Expected unmodified native AbortSignal');AbortSignal.prototype.throwIfAborted.call(signal);}
}
function ownSignal(source:AbortSignal|undefined):{signal:AbortSignal|undefined;release:()=>void}{
 if(source===undefined)return {signal:undefined,release:()=>{}};
 const controller=new AbortController(),aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!,reason=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'reason')!.get!;
 const forward=()=>{if(aborted.call(source))controller.abort(reason.call(source));};EventTarget.prototype.addEventListener.call(source,'abort',forward,{once:true});forward();
 return {signal:controller.signal,release:()=>EventTarget.prototype.removeEventListener.call(source,'abort',forward)};
}
export class NativeSteerOriginUnknownError extends Error{
 readonly requestId:string;readonly ingressKey:string;readonly eventId:bigint;readonly channelId:bigint;readonly ownerUserId:bigint;readonly targetThreadId:string;readonly turnId:string;readonly generation:bigint;readonly marker:string;
 constructor(id:string,op:SteerOriginWrite,cause:unknown){super('Steer origin has no confirmed acknowledgement after native exit; retain original ingress for reconciliation, no steer or automatic replay',{cause});this.name='NativeSteerOriginUnknownError';this.requestId=id;this.ingressKey=op.ingressKey;this.eventId=op.eventId;this.channelId=op.channelId;this.ownerUserId=op.ownerUserId;this.targetThreadId=op.thread;this.turnId=op.turn;this.generation=op.generation;this.marker=steerOriginBinding(id,'',op).marker;}
}
/** Fixed database, Control1, zero waiting queue. Only a bound confirmed origin
 * permits the caller to continue its ORIGINAL turn/generation check. Cancellation
 * and deadline join actual native exit before target custody can be released.
 * A single unresolved original blocks further writes until reconciliation. This
 * runtime-local barrier does not establish cross-restart reconciliation.
 * Original ingress custody belongs to the caller and is never readmitted here. */
export class NativeSteerOriginWriter{
 readonly #path:string;readonly #slot=new OwnedWorkerSlot('Control');#active=false;#unresolved:NativeSteerOriginUnknownError|undefined;
 constructor(path:string){requireDiscordText(path);if(path.includes('\0')||path.length>32768||Buffer.byteLength(path)>32768)throw new TypeError('Invalid Steer origin path');this.#path=pinNativeRuntimePath(path);if(Buffer.byteLength(this.#path)>32768)throw new RangeError('Steer origin path exceeds native budget');Object.freeze(this);}
 assertPath(path:string):void{requireDiscordText(path);if(pinNativeRuntimePath(path)!==this.#path)throw new TypeError('Steer origin writer belongs to another database');}
 /** One bounded unresolved original; no new Steer write can silently replay it. */
 assertReady():void{if(this.#unresolved!==undefined)throw this.#unresolved;}
 async execute(input:SteerOriginWrite,signal?:AbortSignal,timeoutMs=6000):Promise<void>{
  NativeSteerOriginWriter.prototype.assertReady.call(this);checkSignal(signal);if(process.platform==='win32')throw new Error('Windows Steer origin writer is unqualified');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid Steer origin timeout');
  const operation=captureSteerOrigin(input);if(this.#active||this.#slot.busy)throw new OwnedWorkerBusyError();
  const id=randomUUID(),binding=steerOriginBinding(id,this.#path,operation),request={...binding,input:operation};if(boundedSerdeByteCount(request,STEER_ORIGIN_REQUEST_BYTES)===null)throw new RangeError('Steer origin envelope exceeds native budget');if(boundedSerdeByteCount({...binding,ok:true},STEER_ORIGIN_REPLY_BYTES)===null)throw new RangeError('Steer origin acknowledgement exceeds native budget');
  const source=signal,owned=ownSignal(source);this.#active=true;let admitted=false;
  try{
   let raw:unknown;
   try{const task=this.#slot.run(new URL('./steer-origin-native-worker.ts',import.meta.url),request,timeoutMs,owned.signal);admitted=this.#slot.busy;raw=await task;}
   finally{admitted=admitted||this.#slot.busy;await this.#slot.join();}
   checkSignal(source);owned.signal?.throwIfAborted();
   if(boundedSerdeByteCount(raw,STEER_ORIGIN_REPLY_BYTES)===null||raw===null||typeof raw!=='object'||Object.keys(raw).length!==Object.keys(binding).length+1)throw new TypeError('Invalid bounded Steer origin acknowledgement');
   for(const [key,value] of Object.entries(binding))if(own(raw,key)!==value)throw new TypeError('Crossed Steer origin acknowledgement');
   if(own(raw,'ok')!==true)throw new TypeError('Steer origin acknowledgement unavailable');
  }catch(error){if(admitted){const unresolved=new NativeSteerOriginUnknownError(id,operation,error);this.#unresolved=unresolved;throw unresolved;}throw error;}
  finally{try{owned.release();}finally{this.#active=false;}}
 }
}
Object.freeze(NativeSteerOriginWriter.prototype);
