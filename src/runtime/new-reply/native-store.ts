import {resolve} from 'node:path';
import {requireDiscordText} from '../../discord/text.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import type {NewReply} from '../../store/new-reply-read.ts';
import type {NewReplyCheckpointUpdate} from '../../store/new-reply-checkpoint.ts';
type Request={kind:'Pending';limit:number}|{kind:'Checkpoint';original:NewReply;update:NewReplyCheckpointUpdate};
export class NewReplyStoreWriteUnconfirmedError extends Error{
 readonly jobId:string;readonly expectedVersion:bigint;
 constructor(original:NewReply,cause:unknown){super('New reply checkpoint outcome is unconfirmed; reconcile original revision after native exit',{cause});this.name='NewReplyStoreWriteUnconfirmedError';this.jobId=original.identity.job_id;this.expectedVersion=original.version;}
}
/** Zero-queue native DB owner using the central state facade. Timeout/abort joins
 * exact native exit. A submitted checkpoint failure never means safe retry or
 * rollback: its original revision must be reconciled before another mutation.
 * Only these new paths are offloaded; older facade methods remain unchanged. */
export class NativeNewReplyStore{
 readonly #path:string;readonly #timeout:number;readonly #slot=new OwnedWorkerSlot();
 #closed=false;#controller:AbortController|null=null;#inflight:Promise<unknown>|null=null;
 constructor(path:string,timeoutMs=5000){
  requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new RangeError('Invalid new reply store path');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<0||timeoutMs>10000)throw new RangeError('Invalid new reply native timeout');
  this.#path=resolve(path);this.#timeout=timeoutMs;
 }
 get busy():boolean{return this.#inflight!==null;}
 async close(reason:unknown=new Error('New reply store closed')):Promise<void>{this.#closed=true;this.#controller?.abort(reason);if(this.#inflight!==null)await Promise.allSettled([this.#inflight]);}
 async pending(limit=8,signal?:AbortSignal):Promise<readonly NewReply[]>{
  if(!Number.isSafeInteger(limit)||limit<0)throw new RangeError('Invalid new reply batch limit');return this.#run({kind:'Pending',limit:Math.min(limit,32)},signal) as Promise<readonly NewReply[]>;
 }
 async checkpoint(original:NewReply,update:NewReplyCheckpointUpdate,signal?:AbortSignal):Promise<boolean>{
  if(boundedSerdeByteCount(original,1048576)===null||boundedSerdeByteCount(update,524288)===null)throw new RangeError('New reply native checkpoint input budget exceeded');
  const captured=cloneOwnedSerdeValue({original,update}) as {original:NewReply;update:NewReplyCheckpointUpdate};
  const job=own(own(captured.original,'identity'),'job_id'),version=own(captured.original,'version');requireDiscordText(job);
  if(typeof version!=='bigint'||version<-(1n<<63n)||version>=(1n<<63n))throw new TypeError('Expected i64 checkpoint revision');
  return this.#run({kind:'Checkpoint',...captured},signal) as Promise<boolean>;
 }
 #run(request:Request,signal?:AbortSignal):Promise<unknown>{
  signal?.throwIfAborted();if(this.#closed)throw new Error('New reply store is closed');if(this.#inflight!==null)throw new OwnedWorkerBusyError();
  const controller=new AbortController();this.#controller=controller;const abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const operation=(async()=>{
   let submitted=false;
   try{
    const pending=this.#slot.run(new URL('./store-worker.ts',import.meta.url),{path:this.#path,...request},this.#timeout,controller.signal);submitted=this.#slot.busy;const exited=this.#slot.join();let raw:unknown;try{raw=await pending;}finally{await exited;}
    controller.signal.throwIfAborted();
    if(boundedSerdeByteCount(raw,8388608)===null)throw new RangeError('New reply native response exceeds budget');
    const response=cloneOwnedSerdeValue(raw);if(own(response,'ok')!==true){const detail=own(response,'detail');throw new Error(typeof detail==='string'?detail:'Invalid native new reply response');}
    const value=own(response,'value');
    if(request.kind==='Checkpoint'){if(typeof value!=='boolean')throw new TypeError('Invalid checkpoint result');return value;}
    if(!Array.isArray(value)||value.length>request.limit)throw new TypeError('Invalid pending batch result');return value;
   }catch(error){if(request.kind==='Checkpoint'&&submitted)throw new NewReplyStoreWriteUnconfirmedError(request.original,error);throw error;}
   finally{signal?.removeEventListener('abort',abort);}
  })();this.#inflight=operation;void operation.then(()=>{this.#inflight=null;this.#controller=null},()=>{this.#inflight=null;this.#controller=null});return operation;
 }
}
Object.freeze(NativeNewReplyStore.prototype);
