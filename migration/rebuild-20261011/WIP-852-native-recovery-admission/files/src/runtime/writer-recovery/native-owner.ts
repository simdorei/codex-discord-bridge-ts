import {serdeValueEqual} from '../../core/serde-value-equal.ts';
import {getOwn,pointer} from '../../store/async-resolution-json-helpers.ts';
import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {snapshotStoredIngress,storedIngressEqual} from '../../store/ingress-snapshot.ts';
import type {StoredIngress} from '../../store/ingress-read.ts';
import type {RecoveryCancellation} from '../../store/queue-cancel-recovery.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
export interface OriginalRecoveryInput{readonly key:string;readonly channelId:bigint;readonly ownerUserId:bigint;readonly eventId:bigint;readonly reference:string|null;}
export interface NativeRecoveryClaim{readonly __nativeRecoveryClaim?:never;}
export class NativeRecoveryUnavailableError extends Error{
 constructor(readonly operation:'claim'|'claimOriginal'|'check'|'cancel',cause:unknown){super('Native recovery has no confirmed result; retain original custody and inspect durable evidence before any retry',{cause});this.name='NativeRecoveryUnavailableError';}
}
function capture(input:StoredIngress):StoredIngress{
 if(input===null||typeof input!=='object'||types.isProxy(input)||Object.getOwnPropertySymbols(input).length!==0)throw new TypeError('Expected original ingress data');
 const probe=Object.create(null);for(const key of Object.getOwnPropertyNames(input)){const value=own(input,key);Object.defineProperty(probe,key,{value:key==='outcome'&&value===undefined?null:value,enumerable:true});}
 if(boundedSerdeByteCount(probe,1048576)===null)throw new RangeError('Recovery ingress evidence exceeds budget');return snapshotStoredIngress(input);
}
/** Fixed-path existing-store persistence only. Opaque claims belong to this exact
 * owner. No controller/process restart or command routing. Selected routes remain
 * refused until their native selection-epoch custody is connected. */
export class NativeRecoveryOwner{
 readonly #path:string;readonly #slot=new OwnedWorkerSlot('Control');readonly #claims=new WeakMap<object,{record:StoredIngress;used:boolean}>();
 #closed=false;#controller:AbortController|null=null;#active:Promise<unknown>|null=null;
 constructor(path:string){requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid recovery store path');this.#path=pinNativeRuntimePath(path);Object.freeze(this);}
 #ready(signal?:AbortSignal):void{if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected recovery abort signal');signal?.throwIfAborted();if(this.#closed)throw new Error('Recovery owner is closed');if(this.#active!==null||this.#slot.busy)throw new OwnedWorkerBusyError();}
 async claim(input:StoredIngress,signal?:AbortSignal):Promise<NativeRecoveryClaim>{
  this.#ready(signal);const expected=capture(input),now=Date.now()/1000,raw=await this.#run('claim',expected,now,signal);try{if(this.#closed)throw new Error('Recovery owner closed before claim receipt');const record=capture(raw as StoredIngress);
  const required=snapshotStoredIngress(expected);required.phase='recovery_claimed';required.updatedAt=now;if(!storedIngressEqual(record,required))throw new NativeRecoveryUnavailableError('claim',new Error('Claim receipt changed original identity'));
  const token=Object.freeze({});this.#claims.set(token,{record,used:false});return token;}catch(error){if(error instanceof NativeRecoveryUnavailableError)throw error;throw new NativeRecoveryUnavailableError('claim',error);}
 }
 /** Compact original command envelope only; original payload is read off-thread. */
 async claimOriginal(input:OriginalRecoveryInput,signal?:AbortSignal):Promise<NativeRecoveryClaim>{
  this.#ready(signal);
  const key=own(input,'key'),channelId=own(input,'channelId'),ownerUserId=own(input,'ownerUserId'),eventId=own(input,'eventId'),reference=own(input,'reference');
  requireDiscordText(key);if(reference!==null)requireDiscordText(reference);
  for(const id of [channelId,ownerUserId,eventId])if(typeof id!=='bigint'||id<=0n||id>=(1n<<63n))throw new TypeError('Expected original recovery i64 actor');
  if(key!==`message:${eventId}`||Buffer.byteLength(key)>4096||(typeof reference==='string'&&Buffer.byteLength(reference)>4096))throw new TypeError('Invalid original recovery envelope');
  const envelope={key,channelId,ownerUserId,eventId,reference} as OriginalRecoveryInput,now=Date.now()/1000;
  const raw=await this.#run('claimOriginal',envelope,now,signal);
  try{
   if(this.#closed)throw new Error('Recovery owner closed before claim receipt');
   const record=capture(raw as StoredIngress),command={Recover:{reference}};
   if(record.ingressId!==key||record.channelId!==channelId||record.ownerUserId!==ownerUserId||record.eventId!==eventId||record.sourceMessageId!==eventId||record.kind!=='message'||record.state!=='executing'||record.phase!=='recovery_claimed'||record.updatedAt!==now||record.ownerKind!==null||record.ownerId!==null||getOwn(record.payload,'version')!==1n||!serdeValueEqual(getOwn(record.payload,'plan'),{Execute:command})||!serdeValueEqual(pointer(record.payload,'/lifecycle_binding/command'),command)||record.targetThreadId!==pointer(record.payload,'/lifecycle_binding/target')||(pointer(record.payload,'/lifecycle_binding/route')!=='Explicit'&&pointer(record.payload,'/lifecycle_binding/route')!=='Mapped'))throw new Error('Original recovery receipt differs');
   const token=Object.freeze({});this.#claims.set(token,{record,used:false});return token;
  }catch(error){throw new NativeRecoveryUnavailableError('claimOriginal',error);}
 }
 target(token:NativeRecoveryClaim):string{const entry=this.#claims.get(token);if(entry===undefined||entry.record.targetThreadId===null)throw new TypeError('Unknown recovery claim');return entry.record.targetThreadId;}
 async check(token:NativeRecoveryClaim,signal?:AbortSignal):Promise<void>{this.#ready(signal);const entry=this.#claims.get(token);if(entry===undefined)throw new TypeError('Unknown native recovery claim');const value=await this.#run('check',entry.record,0,signal);if(value!==null)throw new NativeRecoveryUnavailableError('check',new Error('Malformed recovery check receipt'));}
 async cancel(token:NativeRecoveryClaim,signal?:AbortSignal):Promise<RecoveryCancellation>{
  this.#ready(signal);const entry=this.#claims.get(token);if(entry===undefined||entry.used)throw new TypeError('Unknown or consumed native recovery claim');entry.used=true;
  let raw:unknown;try{raw=await this.#run('cancel',entry.record,Date.now()/1000,signal);}catch(error){if(!(error instanceof NativeRecoveryUnavailableError))entry.used=false;throw error;}
  try{if(boundedSerdeByteCount(raw,1048576)===null)throw new Error('Oversized cancellation receipt');const jobs=own(raw,'jobs'),startedOrUncertain=own(raw,'startedOrUncertain');if(!Array.isArray(jobs)||jobs.length>128||typeof startedOrUncertain!=='number'||!Number.isInteger(startedOrUncertain)||startedOrUncertain<0||startedOrUncertain>jobs.length)throw new Error('Malformed cancellation receipt');for(const job of jobs)requireDiscordText(job);if(new Set(jobs).size!==jobs.length)throw new Error('Duplicate cancellation receipt');return {jobs:[...jobs],startedOrUncertain};}catch(error){throw new NativeRecoveryUnavailableError('cancel',error);}
 }
 #run(operation:'claim'|'claimOriginal'|'check'|'cancel',record:StoredIngress|OriginalRecoveryInput,now:number,signal?:AbortSignal):Promise<unknown>{
  const controller=new AbortController(),abort=()=>controller.abort(signal!.reason);this.#controller=controller;signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const id=randomUUID();let admitted=false;const task=(async()=>{try{
   const pending=this.#slot.run(new URL('./native-worker.ts',import.meta.url),{id,path:this.#path,operation,record,now},5000,controller.signal);admitted=this.#slot.busy;let raw:unknown;try{raw=await pending;}finally{await this.#slot.join();}
   controller.signal.throwIfAborted();if(own(raw,'id')!==id||own(raw,'path')!==this.#path||own(raw,'operation')!==operation||own(raw,'ok')!==true)throw new Error('Unconfirmed recovery acknowledgement');return own(raw,'value');
  }catch(error){if(admitted)throw new NativeRecoveryUnavailableError(operation,error);throw error;}finally{signal?.removeEventListener('abort',abort);}})();
  this.#active=task;const clear=()=>{if(this.#active===task){this.#active=null;this.#controller=null;}};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('Recovery owner closed')):Promise<void>{this.#closed=true;this.#controller?.abort(reason);await Promise.allSettled(this.#active===null?[]:[this.#active]);await this.#slot.join();}
}
Object.freeze(NativeRecoveryOwner.prototype);
