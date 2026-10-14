import {snapshotBoundMirrorCursor} from '../../store/mirror-cursor-journal.ts';
import {encodeMirrorCursorAnchor} from '../../core/mirror-cursor-anchor.ts';
import type {MirrorStartupCompletionResult} from '../../store/mirror-startup-intent.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError,OwnedWorkerTimeoutError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {MirrorStartupCutoff} from './startup-context-reader.ts';
import {prepareMirrorStartupIntent,snapshotPendingMirrorStartupIntent,type PendingMirrorStartupIntent,type MirrorStartupTargetState} from '../../store/mirror-startup-intent.ts';
import {MIRROR_STARTUP_CONTEXT_HOLDS,MirrorStartupContextHeldError,snapshotMirrorStartupContextLimits,snapshotMirrorStartupContextResult,type MirrorStartupContextHold,type MirrorStartupContextLimits} from './startup-context-limits.ts';
import {snapshotMirrorStartupDatabaseIdentity,type MirrorStartupRecoveryData} from './startup-intent-recovery-data.ts';
type RecoveryRequest={readonly kind:'RecoverContext';readonly thread:string;readonly operationId:string;readonly limits:MirrorStartupContextLimits}|{readonly kind:'VerifyContext';readonly evidence:MirrorStartupRecoveryData}|{readonly kind:'CompleteContext';readonly evidence:MirrorStartupRecoveryData}|{readonly kind:'ReconcileContext';readonly evidence:MirrorStartupRecoveryData};
type Request=RecoveryRequest|{readonly kind:'Read';readonly thread:string}|{readonly kind:'ReadTarget';readonly thread:string;readonly channel:bigint}|{readonly kind:'Schema'}|{readonly kind:'Retain';readonly intent:PendingMirrorStartupIntent};
export class MirrorStartupIntentStoreReadError extends Error {constructor(detail:string){super('Mirror startup intent read held: '+detail);this.name='MirrorStartupIntentStoreReadError';}}
export class MirrorStartupIntentWriteUnconfirmedError extends Error {
 readonly operation:'Schema'|'Retain'|'CompleteContext';readonly operationId:string|null;readonly thread:string|null;
 constructor(request:Extract<Request,{kind:'Schema'|'Retain'|'CompleteContext'}>,cause:unknown){super('Mirror startup intent write is unconfirmed; retain the exact operation and reconcile after native exit',{cause});this.name='MirrorStartupIntentWriteUnconfirmedError';this.operation=request.kind;this.operationId=request.kind==='Retain'?request.intent.operationId:request.kind==='CompleteContext'?request.evidence.pending.operationId:null;this.thread=request.kind==='Retain'?request.intent.thread:request.kind==='CompleteContext'?request.evidence.pending.thread:null;}
}
function text(value:string,max:number,nonempty=false):void {requireDiscordText(value);if(value.length>max||Buffer.byteLength(value)>max||(nonempty&&value===''))throw new RangeError('Mirror startup intent text budget exceeded');}
const recoveryToken=Symbol('native pending startup context'),recoveries=new WeakMap<object,{readonly owner:NativeMirrorStartupIntentStore;readonly data:MirrorStartupRecoveryData}>();
/** Authenticated read-only recovery of one exact pending DB packet. Cutoff and
 * context are descriptive snapshots: neither is a standalone write capability.
 * Only the authentic owning store may explicitly complete this exact recovery;
 * it never authorizes delivery or arbitrary cursor writes. The owner rechecks current state on request, not
 * atomically with any future use. Sampled continuity is not historical integrity:
 * unseen middle rewrites plus growth can escape the bounded anchors. An
 * independent producer append-only contract is still required. */
export class MirrorStartupIntentContextObservation {
 readonly databasePath:string;readonly pending:MirrorStartupRecoveryData['pending'];readonly cutoff:MirrorStartupRecoveryData['pending']['cutoff'];readonly context:MirrorStartupRecoveryData['context'];readonly historyIntegrityVerified=false;readonly atomicCommitVerified=false;readonly #data:MirrorStartupRecoveryData;
 constructor(key:symbol,path:string,data:MirrorStartupRecoveryData){if(key!==recoveryToken)throw new TypeError('Expected owned pending startup recovery');this.#data=data;this.databasePath=path;this.pending=data.pending;this.cutoff=data.pending.cutoff;this.context=data.context;Object.freeze(this);}
 captured():MirrorStartupRecoveryData{return this.#data;}
}
Object.freeze(MirrorStartupIntentContextObservation.prototype);
/** Explicit storage adapter only. read() stays descriptive and has no rollout
 * file IO, EOF recapture or schema repair. Retain accepts authentic captured EOF, including a held boundary.
 * Completion is explicit, same-owner only. No automatic runtime invocation. */
export class NativeMirrorStartupIntentStore {
 readonly #path:string;readonly #timeout:number;readonly #slot=new OwnedWorkerSlot();
 #closed=false;#controller:AbortController|null=null;#inflight:Promise<unknown>|null=null;
 constructor(path:string,timeoutMs=5000){
  text(path,32768);if(path.includes('\0'))throw new TypeError('NUL mirror startup store path');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid mirror startup store deadline');
  const pinned=pinNativeRuntimePath(path);text(pinned,32768);this.#path=pinned;this.#timeout=timeoutMs;
 }
 get busy():boolean{return this.#inflight!==null;}
 async close(reason:unknown=new Error('Mirror startup intent store closed')):Promise<void>{this.#closed=true;this.#controller?.abort(reason);if(this.#inflight!==null)await Promise.allSettled([this.#inflight]);}
 async initializeSchema(signal?:AbortSignal):Promise<void>{await this.#run({kind:'Schema'},signal);}
 async read(thread:string,signal?:AbortSignal):Promise<PendingMirrorStartupIntent|null>{text(thread,16384,true);const value=await this.#run({kind:'Read',thread},signal);return value===null?null:snapshotPendingMirrorStartupIntent(value as PendingMirrorStartupIntent);}
 async readTarget(thread:string,channel:bigint,signal?:AbortSignal):Promise<MirrorStartupTargetState>{
  text(thread,16384,true);if(typeof channel!=='bigint'||channel<=0n||channel>=(1n<<63n))throw new RangeError('Expected mapped positive i64 channel');
  const value=await this.#run({kind:'ReadTarget',thread,channel},signal),kind=own(value,'kind');
  if(kind==='Absent')return Object.freeze({kind});
  if(kind==='Pending'){const pending=snapshotPendingMirrorStartupIntent(own(value,'pending') as PendingMirrorStartupIntent);if(pending.thread!==thread)throw new TypeError('Unexpected startup target thread');return Object.freeze({kind,pending});}
  if(kind==='Bound'){const cursor=snapshotBoundMirrorCursor(own(value,'cursor') as Parameters<typeof snapshotBoundMirrorCursor>[0]);if(cursor.thread!==thread)throw new TypeError('Unexpected startup target thread');return Object.freeze({kind,cursor});}
  throw new TypeError('Invalid native startup target state');
 }
 /** Reads only the original persisted N. The caller supplies identifiers, never
  * an allegedly authenticated packet. Held non-LF cutoffs cannot be upgraded. */
 async recoverContext(thread:string,operationId:string,input:MirrorStartupContextLimits,signal?:AbortSignal):Promise<MirrorStartupIntentContextObservation>{
  text(thread,16384,true);text(operationId,128,true);const limits=snapshotMirrorStartupContextLimits(input);
  const value=await this.#run({kind:'RecoverContext',thread,operationId,limits},signal),pending=snapshotPendingMirrorStartupIntent(own(value,'pending') as PendingMirrorStartupIntent);
  if(pending.thread!==thread||pending.operationId!==operationId)throw new TypeError('Unexpected native startup recovery packet');
  const data=Object.freeze({database:snapshotMirrorStartupDatabaseIdentity(own(value,'database')),pending,context:snapshotMirrorStartupContextResult(pending.cutoff,limits,own(value,'context'))});
  const result=new MirrorStartupIntentContextObservation(recoveryToken,this.#path,data);recoveries.set(result,{owner:this,data});return result;
 }
 /** Strict owner identity check happens before observing public fields. This
  * point-in-time check never grants atomic commit or pending retirement proof. */
 async verifyRecoveredContext(observation:MirrorStartupIntentContextObservation,signal?:AbortSignal):Promise<void>{
  const owned=observation!==null&&typeof observation==='object'?recoveries.get(observation):undefined;
  if(owned===undefined||owned.owner!==this)throw new TypeError('Expected startup recovery from this database owner');
  await this.#run({kind:'VerifyContext',evidence:owned.data},signal);
 }
 /** Explicit DB completion only, authenticated before reading public fields.
  * The exact original packet defines every cursor field and every retry. A
  * result confirms the atomic DB transition, never filesystem atomicity. */
 async completeRecoveredContext(observation:MirrorStartupIntentContextObservation,signal?:AbortSignal):Promise<MirrorStartupCompletionResult>{
  const owned=observation!==null&&typeof observation==='object'?recoveries.get(observation):undefined;
  if(owned===undefined||owned.owner!==this)throw new TypeError('Expected startup recovery from this database owner');
  const request={kind:'CompleteContext',evidence:owned.data} as const,value=await this.#run(request,signal);
  try{
   const kind=own(value,'kind'),cursor=snapshotBoundMirrorCursor(own(value,'cursor') as Parameters<typeof snapshotBoundMirrorCursor>[0]),{pending,context}=owned.data;
   if((kind!=='Completed'&&kind!=='Reconciled')||cursor.thread!==pending.thread||cursor.operationId!==pending.operationId||cursor.updatedAt!==pending.createdAt||cursor.revision!==1n||cursor.turn!==(context.currentTurn??'')||encodeMirrorCursorAnchor(cursor.anchor)!==encodeMirrorCursorAnchor(context.anchor)||cursor.receiptSetHash!=='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')throw new TypeError('Unexpected native startup completion packet');
   return Object.freeze({kind,cursor});
  }catch(error){throw new MirrorStartupIntentWriteUnconfirmedError(request,error);}
 }
 /** Read-only exact reconciliation only. Does not retry an unconfirmed write,
  * reopen an EOF or grant a structural recovery packet write authority. */
 async reconcileRecoveredContext(observation:MirrorStartupIntentContextObservation,signal?:AbortSignal):Promise<import('../../store/mirror-cursor-journal.ts').BoundMirrorCursor|null>{
  const owned=observation!==null&&typeof observation==='object'?recoveries.get(observation):undefined;
  if(owned===undefined||owned.owner!==this)throw new TypeError('Expected startup recovery from this database owner');
  const value=await this.#run({kind:'ReconcileContext',evidence:owned.data},signal);if(value===null)return null;
  const cursor=snapshotBoundMirrorCursor(value as Parameters<typeof snapshotBoundMirrorCursor>[0]),{pending,context}=owned.data;
  if(cursor.thread!==pending.thread||cursor.operationId!==pending.operationId||cursor.updatedAt!==pending.createdAt||cursor.revision!==1n||cursor.turn!==(context.currentTurn??'')||encodeMirrorCursorAnchor(cursor.anchor)!==encodeMirrorCursorAnchor(context.anchor)||cursor.receiptSetHash!=='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')throw new TypeError('Unexpected native startup reconciliation packet');
  return cursor;
 }
 async retain(thread:string,cutoff:MirrorStartupCutoff,createdAt:number,operationId:string,signal?:AbortSignal):Promise<PendingMirrorStartupIntent>{
  const captured=MirrorStartupCutoff.prototype.captured.call(cutoff),intent=snapshotPendingMirrorStartupIntent({thread,cutoff:captured,createdAt,operationId});
  prepareMirrorStartupIntent(intent.thread,intent.cutoff,intent.createdAt,intent.operationId);
  const request={kind:'Retain',intent} as const,result=await this.#run(request,signal);
  if(result===null)throw new MirrorStartupIntentWriteUnconfirmedError(request,new TypeError('Missing retained startup intent'));return snapshotPendingMirrorStartupIntent(result as PendingMirrorStartupIntent);
 }
 #run(request:Request,signal?:AbortSignal):Promise<unknown>{
  signal?.throwIfAborted();if(this.#closed)throw new Error('Mirror startup intent store is closed');if(this.#inflight!==null)throw new OwnedWorkerBusyError();
  const controller=new AbortController();this.#controller=controller;const abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const recovery=request.kind==='RecoverContext'||request.kind==='VerifyContext',timeout=request.kind==='RecoverContext'?Math.min(this.#timeout,request.limits.timeoutMs):this.#timeout;
  const cancel=new Int32Array(new SharedArrayBuffer(4)),stop=()=>{Atomics.store(cancel,0,1);};controller.signal.addEventListener('abort',stop,{once:true});if(controller.signal.aborted)stop();
  const operation=(async()=>{
   let submitted=false;
   try{
    const pending=this.#slot.run(new URL('./startup-intent-store-worker.ts',import.meta.url),{path:this.#path,...request,cancel:cancel.buffer,timeoutMs:timeout},timeout,controller.signal);submitted=this.#slot.busy;
    const exited=this.#slot.join();let response:unknown;try{response=await pending;}catch(error){stop();if(recovery&&error instanceof OwnedWorkerTimeoutError)throw new MirrorStartupContextHeldError('Deadline',error);throw error;}finally{await exited;}
    controller.signal.throwIfAborted();if(own(response,'ok')!==true){const reason=own(response,'reason');if(recovery&&typeof reason==='string'&&MIRROR_STARTUP_CONTEXT_HOLDS.includes(reason as MirrorStartupContextHold))throw new MirrorStartupContextHeldError(reason as MirrorStartupContextHold);const detail=own(response,'detail');throw new MirrorStartupIntentStoreReadError(typeof detail==='string'?detail:'invalid native response');}
    const value=own(response,'value');return request.kind==='Read'||request.kind==='Retain'?(value===null?null:snapshotPendingMirrorStartupIntent(value as PendingMirrorStartupIntent)):value;
   }catch(error){if((request.kind==='Schema'||request.kind==='Retain'||request.kind==='CompleteContext')&&submitted)throw new MirrorStartupIntentWriteUnconfirmedError(request,error);throw error;}
   finally{signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',stop);}
  })();
  this.#inflight=operation;void operation.then(()=>{this.#inflight=null;this.#controller=null;},()=>{this.#inflight=null;this.#controller=null;});return operation;
 }
}
Object.freeze(NativeMirrorStartupIntentStore.prototype);
