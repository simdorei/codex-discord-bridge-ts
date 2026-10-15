import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {captureBusyCreate,busyCreateBinding,BUSY_CREATE_REQUEST_BYTES,BUSY_CREATE_REPLY_BYTES,type BusyCreateWrite} from './busy-create-snapshot.ts';
export type {BusyCreateWrite} from './busy-create-snapshot.ts';
function checkSignal(signal:AbortSignal|undefined):void{
 if(signal!==undefined){if(types.isProxy(signal)||Object.getPrototypeOf(signal)!==AbortSignal.prototype||['throwIfAborted','aborted','reason','addEventListener','removeEventListener'].some(key=>Object.hasOwn(signal,key)))throw new TypeError('Expected unmodified native AbortSignal');AbortSignal.prototype.throwIfAborted.call(signal);}
}
function ownSignal(source:AbortSignal|undefined):{signal:AbortSignal|undefined;release:()=>void}{
 if(source===undefined)return {signal:undefined,release:()=>{}};
 const controller=new AbortController(),aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!,reason=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'reason')!.get!;
 const forward=()=>{if(aborted.call(source))controller.abort(reason.call(source));};EventTarget.prototype.addEventListener.call(source,'abort',forward,{once:true});forward();
 return {signal:controller.signal,release:()=>EventTarget.prototype.removeEventListener.call(source,'abort',forward)};
}
export class NativeBusyCreateUnknownError extends Error{
 readonly requestId:string;readonly choiceId:string;readonly ingressKey:string;readonly eventId:bigint;readonly channelId:bigint;readonly ownerUserId:bigint;readonly targetThreadId:string;readonly turnId:string|null;readonly jobId:string|null;
 constructor(id:string,choiceId:string,op:BusyCreateWrite,cause:unknown){super('Busy choice creation has no confirmed acknowledgement after native exit; insertion or binding may have committed, retain original ingress and choice for reconciliation without automatic replay',{cause});this.name='NativeBusyCreateUnknownError';this.requestId=id;this.choiceId=choiceId;this.ingressKey=op.ingressKey;this.eventId=op.eventId;this.channelId=op.channelId;this.ownerUserId=op.ownerUserId;this.targetThreadId=op.thread;this.turnId=op.turn;this.jobId=op.job;Object.freeze(this);}
}
/** Fixed database, Control1, zero waiting queue. One worker performs choice insertion then original binding in
 * separate transactions. It finishes binding despite caller cancellation after
 * insertion; only an exact final ACK permits buttons. Cancellation
 * and deadline join actual native exit before target custody can be released.
 * A single unresolved original blocks further writes until reconciliation. This
 * runtime-local barrier does not establish cross-restart reconciliation.
 * Original ingress custody belongs to the caller and is never readmitted here. */
export class NativeBusyCreateWriter{
 readonly #path:string;readonly #slot=new OwnedWorkerSlot('Control');#active=false;#unresolved:NativeBusyCreateUnknownError|undefined;
 constructor(path:string){requireDiscordText(path);if(path.includes('\0')||path.length>32768||Buffer.byteLength(path)>32768)throw new TypeError('Invalid Busy creation path');this.#path=pinNativeRuntimePath(path);if(Buffer.byteLength(this.#path)>32768)throw new RangeError('Busy creation path exceeds native budget');Object.freeze(this);}
 assertPath(path:string):void{requireDiscordText(path);if(pinNativeRuntimePath(path)!==this.#path)throw new TypeError('Busy creation writer belongs to another database');}
 /** One bounded unresolved original; no new Busy creation can silently replay it. */
 assertReady():void{if(this.#unresolved!==undefined)throw this.#unresolved;}
 async execute(input:BusyCreateWrite,signal?:AbortSignal,timeoutMs=6000):Promise<string>{
  NativeBusyCreateWriter.prototype.assertReady.call(this);checkSignal(signal);if(process.platform==='win32')throw new Error('Windows Busy creation writer is unqualified');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid Busy creation timeout');
  const operation=captureBusyCreate(input);if(this.#active||this.#slot.busy)throw new OwnedWorkerBusyError();
  const id=randomUUID(),choiceId=randomUUID().replaceAll('-','').slice(0,24),binding=busyCreateBinding(id,this.#path,choiceId,operation),request={...binding,input:operation};if(boundedSerdeByteCount(request,BUSY_CREATE_REQUEST_BYTES)===null)throw new RangeError('Busy creation envelope exceeds native budget');if(boundedSerdeByteCount({...binding,ok:true},BUSY_CREATE_REPLY_BYTES)===null)throw new RangeError('Busy creation acknowledgement exceeds native budget');
  const source=signal,owned=ownSignal(source);this.#active=true;let admitted=false;
  try{
   let raw:unknown;
   try{const task=this.#slot.run(new URL('./busy-create-native-worker.ts',import.meta.url),request,timeoutMs,owned.signal);admitted=this.#slot.busy;raw=await task;}
   finally{admitted=admitted||this.#slot.busy;await this.#slot.join();}
   checkSignal(source);owned.signal?.throwIfAborted();
   if(boundedSerdeByteCount(raw,BUSY_CREATE_REPLY_BYTES)===null||raw===null||typeof raw!=='object'||Object.keys(raw).length!==Object.keys(binding).length+1)throw new TypeError('Invalid bounded Busy creation acknowledgement');
   for(const [key,value] of Object.entries(binding))if(!Object.is(own(raw,key),value))throw new TypeError('Crossed Busy creation acknowledgement');
   if(own(raw,'ok')!==true)throw new TypeError('Busy creation acknowledgement unavailable');
   return choiceId;
  }catch(error){if(admitted){const unresolved=new NativeBusyCreateUnknownError(id,choiceId,operation,error);this.#unresolved=unresolved;throw unresolved;}throw error;}
  finally{try{owned.release();}finally{this.#active=false;}}
 }
}
Object.freeze(NativeBusyCreateWriter.prototype);
