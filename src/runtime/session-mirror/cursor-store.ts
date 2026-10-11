import {snapshotMirrorSkippedItems} from './ownership.ts';
import type {MirrorItem} from './collect.ts';
import {resolve} from 'node:path';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {encodeMirrorCursorAnchor,decodeMirrorCursorAnchor,type MirrorCursorAnchor} from '../../core/mirror-cursor-anchor.ts';
import {snapshotBoundMirrorCursor,type BoundMirrorCursor} from '../../store/mirror-cursor-journal.ts';
import {snapshotExpectedReceiptBatch,type ExpectedReceipt} from '../../store/confirmed-receipt-batch.ts';
type Kind='Read'|'Schema'|'Initialize'|'Advance'|'MappedAdvance'|'MixedAdvance';
interface Request{kind:Kind;skipped?:readonly MirrorItem[];maxJobs?:bigint;maxValueBytes?:bigint;channel?:bigint;thread?:string;anchor?:MirrorCursorAnchor;turn?:string;updatedAt?:number;operationId?:string;expected?:BoundMirrorCursor;receipts?:readonly ExpectedReceipt[]}
export class MirrorCursorStoreReadError extends Error{constructor(detail:string){super('Mirror cursor read failed: '+detail);this.name='MirrorCursorStoreReadError';}}
/** Diagnostic identity for explicit later reconciliation, never resend permission. */
export class MirrorCursorWriteUnconfirmedError extends Error{
 readonly operation:Kind;readonly operationId:string|null;readonly thread:string|null;
 constructor(request:Request,cause:unknown){super('Mirror cursor write result is unconfirmed; retain the exact packet and reconcile after native exit',{cause});this.name='MirrorCursorWriteUnconfirmedError';this.operation=request.kind;this.operationId=request.operationId??null;this.thread=request.thread??request.expected?.thread??null;}
}
function bounded(value:string,max:number,nonempty=false):void{requireDiscordText(value);if(value.length>max||Buffer.byteLength(value)>max||(nonempty&&value===''))throw new RangeError('Mirror cursor request text budget exceeded');}
function values(input:MirrorCursorAnchor,turn:string,updatedAt:number,operationId:string){
 const anchor=decodeMirrorCursorAnchor(encodeMirrorCursorAnchor(input));bounded(turn,16384);bounded(operationId,128,true);
 if(typeof updatedAt!=='number'||!Number.isFinite(updatedAt)||updatedAt<0)throw new TypeError('Invalid mirror cursor timestamp');
 return {anchor,turn,updatedAt,operationId};
}
/** One fixed native DB owner, no waiting queue. All operations use an existing
 * store; reads cannot create/migrate. Writes are explicitly requested only.
 * Timeout/cancel always joins native exit. A submitted write failure is reported
 * as unconfirmed rather than converted into permission to replay delivery.
 * This adapter does not prove item coverage, file continuity or send ownership. */
export class NativeMirrorCursorStore{
 readonly #path:string;readonly #timeout:number;readonly #slot=new OwnedWorkerSlot();
 #closed=false;#controller:AbortController|null=null;#inflight:Promise<unknown>|null=null;
 constructor(path:string,timeoutMs=5000){
  bounded(path,32768);if(path.includes('\0'))throw new TypeError('NUL mirror store path');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid mirror cursor worker deadline');
  const pinned=resolve(path);bounded(pinned,32768);this.#path=pinned;this.#timeout=timeoutMs;
 }
 get busy():boolean{return this.#inflight!==null;}
 async close(reason:unknown=new Error('Mirror cursor store closed')):Promise<void>{this.#closed=true;this.#controller?.abort(reason);if(this.#inflight!==null)await Promise.allSettled([this.#inflight]);}
 async initializeSchema(signal?:AbortSignal):Promise<void>{return this.#run({kind:'Schema'},signal).then(()=>undefined);}
 async read(thread:string,signal?:AbortSignal):Promise<BoundMirrorCursor|null>{bounded(thread,16384);return this.#run({kind:'Read',thread},signal);}
 async initializeFresh(thread:string,input:MirrorCursorAnchor,turn:string,updatedAt:number,operationId:string,signal?:AbortSignal):Promise<BoundMirrorCursor>{
  bounded(thread,16384);return this.#required({kind:'Initialize',thread,...values(input,turn,updatedAt,operationId)},signal);
 }
 async advance(expected:BoundMirrorCursor,input:MirrorCursorAnchor,turn:string,updatedAt:number,operationId:string,receipts:readonly ExpectedReceipt[],signal?:AbortSignal):Promise<BoundMirrorCursor>{
  const old=snapshotBoundMirrorCursor(expected),captured=snapshotExpectedReceiptBatch(receipts);
  return this.#required({kind:'Advance',expected:old,...values(input,turn,updatedAt,operationId),receipts:captured},signal);
 }
 async advanceMapped(expected:BoundMirrorCursor,input:MirrorCursorAnchor,turn:string,updatedAt:number,operationId:string,receipts:readonly ExpectedReceipt[],channel:bigint,signal?:AbortSignal):Promise<BoundMirrorCursor>{
  if(typeof channel!=='bigint'||channel<=0n||channel>=(1n<<63n))throw new RangeError('Expected mapped positive i64 channel');
  const old=snapshotBoundMirrorCursor(expected),captured=snapshotExpectedReceiptBatch(receipts);
  return this.#required({kind:'MappedAdvance',channel,expected:old,...values(input,turn,updatedAt,operationId),receipts:captured},signal);
 }
 /** Complete receipt and current skip proof checked with mapping and cursor CAS
  * inside one fixed native transaction. Authentic partition remains caller-owned. */
 async advanceWithSkips(expected:BoundMirrorCursor,input:MirrorCursorAnchor,turn:string,updatedAt:number,operationId:string,receipts:readonly ExpectedReceipt[],channel:bigint,items:readonly MirrorItem[],limits:{readonly maxJobs:bigint;readonly maxValueBytes:bigint},signal?:AbortSignal):Promise<BoundMirrorCursor>{
  if(typeof channel!=='bigint'||channel<=0n||channel>=(1n<<63n))throw new RangeError('Expected mapped positive i64 channel');
  const old=snapshotBoundMirrorCursor(expected),skipped=snapshotMirrorSkippedItems(old.thread,items),captured=snapshotExpectedReceiptBatch(receipts);
  const maxJobs=own(limits,'maxJobs'),maxValueBytes=own(limits,'maxValueBytes');
  if(typeof maxJobs!=='bigint'||maxJobs<1n||maxJobs>4096n||typeof maxValueBytes!=='bigint'||maxValueBytes<1n||maxValueBytes>4194304n)throw new RangeError('Invalid mirror skip queue limits');
  return this.#required({kind:'MixedAdvance',channel,expected:old,...values(input,turn,updatedAt,operationId),receipts:captured,skipped,maxJobs,maxValueBytes},signal);
 }
 async #required(request:Request,signal?:AbortSignal):Promise<BoundMirrorCursor>{
  const result=await this.#run(request,signal);if(result===null)throw new MirrorCursorWriteUnconfirmedError(request,new TypeError('Missing committed cursor'));return result;
 }
 #run(request:Request,signal?:AbortSignal):Promise<BoundMirrorCursor|null>{
  signal?.throwIfAborted();if(this.#closed)throw new Error('Mirror cursor store is closed');if(this.#inflight!==null)throw new OwnedWorkerBusyError();
  const controller=new AbortController();this.#controller=controller;
  const abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const operation=(async()=>{
   let submitted=false;
   try{
    const pending=this.#slot.run(new URL('./cursor-store-worker.ts',import.meta.url),{path:this.#path,...request},this.#timeout,controller.signal);
    submitted=this.#slot.busy;const exited=this.#slot.join();let response:unknown;
    try{response=await pending;}finally{await exited;}
    controller.signal.throwIfAborted();
    if(own(response,'ok')!==true){const detail=own(response,'detail');throw new MirrorCursorStoreReadError(typeof detail==='string'?detail:'invalid native response');}
    const value=own(response,'value');return value===null?null:snapshotBoundMirrorCursor(value as BoundMirrorCursor);
   }catch(error){
    if(request.kind!=='Read'&&submitted)throw new MirrorCursorWriteUnconfirmedError(request,error);throw error;
   }finally{signal?.removeEventListener('abort',abort);}
  })();
  this.#inflight=operation;
  void operation.then(()=>{this.#inflight=null;this.#controller=null},()=>{this.#inflight=null;this.#controller=null});
  return operation;
 }
}
