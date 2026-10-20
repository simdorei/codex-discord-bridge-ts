import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
/** The original command identity binds acknowledgements and uncertain outcomes.
 * It is not a durable cancellation idempotency key: never replay cancel-latest. */
export interface RetractWrite {
 readonly ingressKey:string;readonly eventId:bigint;readonly target:string;
 readonly channelId:bigint;readonly ownerUserId:bigint;readonly now:number;readonly requireMirror:boolean;
}
function text(value:unknown):asserts value is string{requireDiscordText(value);if(value.length>16384||Buffer.byteLength(value)>16384)throw new RangeError('Retract text exceeds budget');}
function integer(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<0n||value>=1n<<63n)throw new TypeError('Expected nonnegative i64 Retract identity');}
function capture(input:RetractWrite):RetractWrite{
 if(boundedSerdeByteCount(input,65536)===null)throw new RangeError('Retract write exceeds budget');
 const q=cloneOwnedSerdeValue(input);if(q===null||typeof q!=='object'||Array.isArray(q)||Object.keys(q).length!==7)throw new TypeError('Expected exact Retract write fields');
 const ingressKey=own(q,'ingressKey'),eventId=own(q,'eventId'),target=own(q,'target'),channelId=own(q,'channelId'),ownerUserId=own(q,'ownerUserId'),now=own(q,'now'),requireMirror=own(q,'requireMirror');
 text(ingressKey);text(target);integer(eventId);integer(channelId);integer(ownerUserId);
 if(ingressKey===''||typeof now!=='number'||!Number.isFinite(now)||now<0||typeof requireMirror!=='boolean')throw new TypeError('Invalid Retract scope');
 return Object.freeze({ingressKey,eventId,target,channelId,ownerUserId,now,requireMirror});
}
export class NativeRetractWriteUnknownError extends Error{
 readonly requestId:string;readonly ingressKey:string;readonly eventId:bigint;readonly targetThreadId:string;readonly channelId:bigint;readonly ownerUserId:bigint;
 constructor(requestId:string,operation:RetractWrite,cause:unknown){super('Retract cancellation has no confirmed acknowledgement after native exit; retain original ingress for reconciliation and do not retry cancel-latest',{cause});this.name='NativeRetractWriteUnknownError';this.requestId=requestId;this.ingressKey=operation.ingressKey;this.eventId=operation.eventId;this.targetThreadId=operation.target;this.channelId=operation.channelId;this.ownerUserId=operation.ownerUserId;}
}
/** Fixed database, shared Control1 capacity, zero waiting queue. After submission
 * timeout/abort joins the real SQLite worker; it never terminates or retries it.
 * The caller retains its original ingress custody on uncertainty. */
export class NativeRetractWriter{
 readonly #path:string;readonly #slot=new OwnedWorkerSlot('Control');
 constructor(path:string){requireDiscordText(path);if(path.includes('\0')||path.length>32768||Buffer.byteLength(path)>32768)throw new TypeError('Invalid Retract database path');this.#path=pinNativeRuntimePath(path);if(Buffer.byteLength(this.#path)>32768)throw new RangeError('Retract database path exceeds budget');Object.freeze(this);}
 assertPath(path:string):void{requireDiscordText(path);if(pinNativeRuntimePath(path)!==this.#path)throw new TypeError('Retract writer belongs to another database');}
 async execute(input:RetractWrite,signal?:AbortSignal,timeoutMs=6000):Promise<string|null>{
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');signal?.throwIfAborted();
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid Retract write timeout');
  const operation=capture(input);if(this.#slot.busy)throw new OwnedWorkerBusyError();
  const id=randomUUID(),request={id,path:this.#path,operation};let admitted=false,raw:unknown;
  try{const task=this.#slot.run(new URL('./retract-write-native-worker.ts',import.meta.url),request,timeoutMs,signal);admitted=this.#slot.busy;try{raw=await task;}finally{await this.#slot.join();}}
  catch(error){if(admitted)throw new NativeRetractWriteUnknownError(id,operation,error);throw error;}
  try{
   signal?.throwIfAborted();if(boundedSerdeByteCount(raw,98304)===null||own(raw,'id')!==id||own(raw,'path')!==this.#path||own(raw,'ingressKey')!==operation.ingressKey||own(raw,'eventId')!==operation.eventId||own(raw,'target')!==operation.target||own(raw,'channelId')!==operation.channelId||own(raw,'ownerUserId')!==operation.ownerUserId||own(raw,'ok')!==true)throw new TypeError('Missing bound Retract acknowledgement');
   const value=own(raw,'value');if(value===null)return null;text(value);return value;
  }catch(error){throw new NativeRetractWriteUnknownError(id,operation,error);}
 }
}
Object.freeze(NativeRetractWriter.prototype);
