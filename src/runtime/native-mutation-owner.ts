import {types} from 'node:util';
import {pinNativeRuntimePath} from './runtime-paths/path-text.ts';
import {requireDiscordText} from '../discord/text.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {validateRequestId} from '../protocol/ids.ts';
import {MutationOutcomeUnknownError,type MaintenanceClaim,type MaintenanceCompletion} from '../app-server/maintenance-attempt.ts';
import type {QueueMutationClaim,StopMutationClaim} from '../app-server/dispatch-attempt.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from './owned-worker-slot.ts';

export interface NativeMutationReceipt {readonly attemptId:string;readonly method:string}
type BeginOperation='beginMutationWithOrigin'|'beginQueueMutation'|'beginStopMutation';
type Operation=BeginOperation|'finishMutation'|'finishStopMutation';
interface ReceiptData {readonly input:MaintenanceClaim|QueueMutationClaim|StopMutationClaim;readonly stop:boolean;used:boolean}
function text(value:unknown,limit=4096):string {
 requireDiscordText(value);
 if(value.includes('\0')||Buffer.byteLength(value)>limit)throw new RangeError('Native mutation text exceeds boundary');
 return value;
}
/** Additive native persistence adapter; not installed in synchronous resident hooks.
 * A receipt proves only this owner's committed durable intent, never permission to
 * send a wire. The actual writer must revalidate its original admission afterwards.
 * Accepted native failures are conservatively unknown, including rolled-back refusals.
 * There is no automatic retry, rollback inference, or completion from close/dispose. */
export class NativeMutationOwner {
 readonly #path:string;readonly #runtime:string;readonly #render:(text:string)=>string;readonly #timeout:number;
 readonly #slot=new OwnedWorkerSlot('Control');readonly #receipts=new WeakMap<object,ReceiptData>();
 #active:Promise<unknown>|null=null;#controller:AbortController|null=null;#closed=false;
 constructor(path:string,runtime:string,render:(text:string)=>string,timeoutMs=5000){
  this.#path=pinNativeRuntimePath(text(path,32768));this.#runtime=text(runtime);
  if(runtime==='')throw new TypeError('Expected runtime identity');
  if(typeof render!=='function'||types.isProxy(render)||types.isAsyncFunction(render)||types.isGeneratorFunction(render))throw new TypeError('Expected synchronous public-safe renderer');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid native mutation deadline');
  this.#render=render;this.#timeout=timeoutMs;
 }
 get busy():boolean{return this.#active!==null;}
 async close(reason:unknown=new Error('Native mutation owner closed')):Promise<void>{
  this.#closed=true;this.#controller?.abort(reason);
  if(this.#active!==null)await Promise.allSettled([this.#active]);
 }
 begin(input:MaintenanceClaim,signal?:AbortSignal):Promise<NativeMutationReceipt>{return this.#begin('beginMutationWithOrigin',input,signal);}
 beginQueue(input:QueueMutationClaim,signal?:AbortSignal):Promise<NativeMutationReceipt>{return this.#begin('beginQueueMutation',input,signal);}
 beginStop(input:StopMutationClaim,signal?:AbortSignal):Promise<NativeMutationReceipt>{return this.#begin('beginStopMutation',input,signal);}
 finish(receipt:NativeMutationReceipt,outcome:MaintenanceCompletion['outcome'],signal?:AbortSignal):Promise<void>{
  this.#ready(signal);
  const data=this.#receipts.get(receipt);
  if(data===undefined||data.used)throw new TypeError('Expected unused receipt from this native mutation owner');
  if(outcome!=='not_sent'&&outcome!=='reply_ok'&&outcome!=='reply_error')throw new TypeError('Expected explicit observed mutation outcome');
  const c=data.input;
  const completion={ownerId:c.ownerId,generation:c.generation,attemptId:c.attemptId,wire:c.wire,outcome,...(data.stop?{claim:(c as StopMutationClaim).claim}:{})};
  data.used=true;
  return this.#run(data.stop?'finishStopMutation':'finishMutation',completion,receipt.method,c.attemptId,signal);
 }
 #ready(signal?:AbortSignal):void{
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected owned AbortSignal');
  signal?.throwIfAborted();
  if(this.#closed)throw new Error('Native mutation owner is closed');
  if(this.#active!==null)throw new OwnedWorkerBusyError();
 }
 #begin(operation:BeginOperation,input:MaintenanceClaim|QueueMutationClaim|StopMutationClaim,signal?:AbortSignal):Promise<NativeMutationReceipt>{
  this.#ready(signal);
  if(boundedSerdeByteCount(input,1048576)===null)throw new RangeError('Native mutation claim exceeds boundary');
  const captured=cloneOwnedSerdeValue(input) as typeof input;
  const attemptId=text(own(captured,'attemptId')),method=operation==='beginStopMutation'?'turn/interrupt':text(own(captured,'method'));
  if(attemptId===''||method==='')throw new TypeError('Expected mutation identity');
  text(own(captured,'ownerId'));validateRequestId(own(captured,'wire'));
  const g=own(captured,'generation');if(typeof g!=='bigint'||g<0n||g>=(1n<<63n))throw new TypeError('Expected signed i64 generation');
  return this.#run(operation,captured,method,attemptId,signal).then(()=>{
   const receipt=Object.freeze({attemptId,method});
   this.#receipts.set(receipt,{input:captured,stop:operation==='beginStopMutation',used:false});return receipt;
  });
 }
 #run(operation:Operation,input:unknown,method:string,attemptId:string,signal?:AbortSignal):Promise<void>{
  const controller=new AbortController();this.#controller=controller;
  const abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const task=(async()=>{
   let admitted=false;let diagnostic='Native mutation result unavailable';
   try{
    const pending=this.#slot.run(new URL('./native-mutation-worker.ts',import.meta.url),{path:this.#path,runtime:this.#runtime,operation,input},this.#timeout,controller.signal);
    admitted=this.#slot.busy;
    let raw:unknown;try{raw=await pending;}finally{await this.#slot.join();}
    controller.signal.throwIfAborted();
    if(boundedSerdeByteCount(raw,16384)===null||own(raw,'ok')!==true){
     const detail=own(raw,'detail');let safe='Native mutation result unavailable';
     if(typeof detail==='string'){
      try{const rendered=this.#render(text(detail,12000));if(types.isPromise(rendered))void Promise.prototype.then.call(rendered,undefined,()=>undefined);safe=text(rendered,12000);}catch{/* Never expose an unredacted fallback. */}
     }
     diagnostic=safe;throw new Error(safe);
    }
   }catch(error){
    if(!admitted)throw error;
    // Even a joined failed worker may have committed before its response was lost.
    // Do not infer not_sent from cancellation, timeout, or an exception message.
    throw new MutationOutcomeUnknownError(method,`native ${operation} result not confirmed; original attempt ${attemptId} requires reconciliation; ${diagnostic}; no automatic replay`);
   }finally{signal?.removeEventListener('abort',abort);}
  })();
  this.#active=task;const clear=()=>{if(this.#active===task){this.#active=null;this.#controller=null;}};void task.then(clear,clear);return task;
 }
}
Object.freeze(NativeMutationOwner.prototype);
