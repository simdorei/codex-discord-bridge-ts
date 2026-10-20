import {types} from 'node:util';
import {performance} from 'node:perf_hooks';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {encodeMirrorCursorAnchor} from '../../core/mirror-cursor-anchor.ts';
import type {BoundMirrorCursor} from '../../store/mirror-cursor-journal.ts';
import {snapshotPendingMirrorStartupIntent,type PendingMirrorStartupIntent} from '../../store/mirror-startup-intent.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {captureMirrorStartupCutoff} from './startup-context-reader.ts';
import {MirrorStartupContextHeldError,sameMirrorStartupStamp,snapshotMirrorStartupContextLimits,type MirrorStartupContextLimits} from './startup-context-limits.ts';
import {NativeMirrorStartupIntentStore,MirrorStartupIntentWriteUnconfirmedError} from './startup-intent-store.ts';
import type {MirrorStartupRecoveryData} from './startup-intent-recovery-data.ts';

export interface MirrorTargetBootstrapInput {
 readonly databasePath:string;readonly thread:string;readonly rolloutPath:string;readonly channel:bigint;
 /** Used only for a genuinely absent target; pending uses its original values. */
 readonly operationId:string;readonly createdAt:number;
 readonly fullPrefix?:boolean;readonly context:MirrorStartupContextLimits;readonly totalTimeoutMs:number;
}
export interface MirrorTargetBootstrapResult {readonly kind:'Existing'|'Initialized'|'Resumed';readonly cursor:BoundMirrorCursor;readonly reconciled:boolean;}
export class MirrorBootstrapBindingError extends Error {constructor(){super('Mirror startup target or rollout binding changed');this.name='MirrorBootstrapBindingError';}}
const reconciliationErrors=new WeakSet<object>();
/** Exact native error identity, without inspecting an opaque target failure. */
export function isMirrorBootstrapReconciliationRequiredError(value:unknown):value is MirrorBootstrapReconciliationRequiredError{
 return value!==null&&typeof value==='object'&&reconciliationErrors.has(value);
}
/** Descriptive exact evidence for explicit recovery, never write authority.
 * Native exit was joined. Absence, cancellation or failed reconciliation does
 * not establish rollback and must not prompt a new EOF capture. */
export class MirrorBootstrapReconciliationRequiredError extends Error {
 readonly databasePath:string;readonly channel:bigint;readonly operation:'Retain'|'CompleteContext';
 readonly pending:PendingMirrorStartupIntent;readonly recovery:MirrorStartupRecoveryData|null;readonly reconciliationError:unknown;
 constructor(input:MirrorTargetBootstrapInput,operation:'Retain'|'CompleteContext',pending:PendingMirrorStartupIntent,recovery:MirrorStartupRecoveryData|null,cause:unknown,reconciliationError:unknown){
  super('Mirror startup write remains unconfirmed; reconcile the retained original packet before another bootstrap',{cause});this.name='MirrorBootstrapReconciliationRequiredError';
  this.databasePath=input.databasePath;this.channel=input.channel;this.operation=operation;this.pending=pending;this.recovery=recovery;this.reconciliationError=reconciliationError;
  reconciliationErrors.add(this);Object.freeze(this);
 }
}
function bounded(value:unknown,max:number):string {
 requireDiscordText(value);if(value===''||value.includes('\0')||value.length>max||Buffer.byteLength(value)>max)throw new RangeError('Invalid mirror bootstrap identity budget');return value;
}
function capture(input:MirrorTargetBootstrapInput):MirrorTargetBootstrapInput {
 const databasePath=pinNativeRuntimePath(bounded(own(input,'databasePath'),32768)),rolloutPath=pinNativeRuntimePath(bounded(own(input,'rolloutPath'),32768));bounded(databasePath,32768);bounded(rolloutPath,32768);
 const thread=bounded(own(input,'thread'),16384),operationId=bounded(own(input,'operationId'),128),channel=own(input,'channel'),createdAt=own(input,'createdAt'),totalTimeoutMs=own(input,'totalTimeoutMs');
 if(typeof channel!=='bigint'||channel<=0n||channel>=(1n<<63n))throw new RangeError('Expected mapped positive i64 channel');
 if(typeof createdAt!=='number'||!Number.isFinite(createdAt)||createdAt<0)throw new TypeError('Invalid mirror bootstrap timestamp in seconds');
 if(typeof totalTimeoutMs!=='number'||!Number.isSafeInteger(totalTimeoutMs)||totalTimeoutMs<1||totalTimeoutMs>10000)throw new RangeError('Invalid total mirror bootstrap deadline');
 return Object.freeze({...(Object.getOwnPropertyDescriptor(input,'fullPrefix')?.value===true?{fullPrefix:true}:{}),databasePath,rolloutPath,thread,operationId,channel,createdAt,totalTimeoutMs,context:snapshotMirrorStartupContextLimits(own(input,'context') as MirrorStartupContextLimits)});
}
function samePending(a:PendingMirrorStartupIntent,b:PendingMirrorStartupIntent):boolean {
 const x=a.cutoff,y=b.cutoff;
 return a.thread===b.thread&&a.operationId===b.operationId&&a.createdAt===b.createdAt&&x.path===y.path&&x.offset===y.offset&&sameMirrorStartupStamp(x.stamp,y.stamp)&&(x.anchor===null?y.anchor===null:y.anchor!==null&&encodeMirrorCursorAnchor(x.anchor)===encodeMirrorCursorAnchor(y.anchor));
}

/** One single-use, zero-queue coordinator under the trusted caller's existing
 * target/channel owner. Constructor captures all identities and budgets before
 * async work. Requires explicitly prepared cursor AND startup schemas. Reads do
 * no DDL. Native stages run sequentially, without occupying an outer worker slot.
 * At most one cutoff, one retain and one completion are submitted. An uncertain
 * write gets one read-only reconciliation, never an automatic write retry.
 *
 * The total deadline stops new work; native exit is always joined, even if a
 * blocked OS operation outlives that deadline. The caller must keep target /
 * channel ownership, DB path identity and producer append-only history stable.
 * The initial exact mapping guard and sampled file/DB checks are not a global
 * atomic lock, send permission, or proof against unseen ABA/history rewrites.
 * The bound worker may invoke this API under an explicit policy. Application
 * and CLI enablement still require the independent ownership contracts above. */
export class MirrorTargetBootstrapCoordinator {
 readonly #input:MirrorTargetBootstrapInput;readonly #controller=new AbortController();
 #started=false;#closed=false;#task:Promise<MirrorTargetBootstrapResult>|null=null;
 constructor(input:MirrorTargetBootstrapInput){this.#input=capture(input);}
 get busy():boolean{return this.#task!==null;}
 async close(reason:unknown=new Error('Mirror bootstrap coordinator closed')):Promise<void>{this.#closed=true;this.#controller.abort(reason);if(this.#task!==null)await Promise.allSettled([this.#task]);}
 run(signal?:AbortSignal):Promise<MirrorTargetBootstrapResult>{
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))return Promise.reject(new TypeError('Expected owned bootstrap abort signal'));
  if(this.#task!==null)return Promise.reject(new OwnedWorkerBusyError());
  if(this.#closed||this.#started)return Promise.reject(new Error('Mirror bootstrap coordinator is closed or already used'));
  this.#started=true;
  const task=this.#run(signal);this.#task=task;void task.then(()=>{this.#task=null;},()=>{this.#task=null;});return task;
 }
 async #run(signal?:AbortSignal):Promise<MirrorTargetBootstrapResult>{
  const input=this.#input,controller=this.#controller,abort=()=>controller.abort(signal!.reason);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(()=>controller.abort(new MirrorStartupContextHeldError('Deadline')),input.totalTimeoutMs),active=controller.signal;
  const deadline=performance.now()+input.totalTimeoutMs;
  const check=()=>{if(performance.now()>=deadline)controller.abort(new MirrorStartupContextHeldError('Deadline'));active.throwIfAborted();};
  const store=new NativeMirrorStartupIntentStore(input.databasePath,Math.min(input.context.timeoutMs,input.totalTimeoutMs));
  try{
   check();const initial=await store.readTarget(input.thread,input.channel,active);
   if(initial.kind==='Bound'){
    if(initial.cursor.thread!==input.thread||initial.cursor.anchor.path!==input.rolloutPath)throw new MirrorBootstrapBindingError();
    return Object.freeze({kind:'Existing',cursor:initial.cursor,reconciled:false});
   }
   let pending:PendingMirrorStartupIntent,reconciled=false;
   if(initial.kind==='Pending'){
    pending=initial.pending;if(pending.cutoff.path!==input.rolloutPath)throw new MirrorBootstrapBindingError();
   }else{
    // Persist the authentic original N before reading any historical context.
    check();const cutoff=await captureMirrorStartupCutoff(input.rolloutPath,Math.min(input.context.timeoutMs,Math.max(1,Math.ceil(deadline-performance.now()))),active,input.fullPrefix===true);
    pending=snapshotPendingMirrorStartupIntent({thread:input.thread,cutoff:cutoff.captured(),operationId:input.operationId,createdAt:input.createdAt});
    try{
     check();const retained=await store.retain(input.thread,cutoff,input.createdAt,input.operationId,active);
     if(!samePending(pending,retained))throw new MirrorStartupIntentWriteUnconfirmedError({kind:'Retain',intent:pending},new MirrorBootstrapBindingError());
    }catch(error){
     if(!(error instanceof MirrorStartupIntentWriteUnconfirmedError))throw error;
     try{
      check();const observed=await store.readTarget(input.thread,input.channel,active);
      if(observed.kind!=='Pending'||!samePending(pending,observed.pending))throw new MirrorBootstrapBindingError();
      reconciled=true;
     }catch(reconciliationError){throw new MirrorBootstrapReconciliationRequiredError(input,'Retain',pending,null,error,reconciliationError);}
    }
   }
   check();const observation=await store.recoverContext(input.thread,pending.operationId,{...input.context,timeoutMs:Math.min(input.context.timeoutMs,Math.max(1,Math.ceil(deadline-performance.now())))},active);
   if(!samePending(pending,observation.pending))throw new MirrorBootstrapBindingError();
   let cursor:BoundMirrorCursor;
   try{check();const completed=await store.completeRecoveredContext(observation,active);cursor=completed.cursor;reconciled||=completed.kind==='Reconciled';}
   catch(error){
    if(!(error instanceof MirrorStartupIntentWriteUnconfirmedError))throw error;
    try{
     check();const observed=await store.reconcileRecoveredContext(observation,active);
     if(observed===null)throw new MirrorBootstrapBindingError();cursor=observed;reconciled=true;
    }catch(reconciliationError){throw new MirrorBootstrapReconciliationRequiredError(input,'CompleteContext',pending,observation.captured(),error,reconciliationError);}
   }
   return Object.freeze({kind:initial.kind==='Pending'?'Resumed':'Initialized',cursor,reconciled});
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);await store.close();}
 }
}
Object.freeze(MirrorTargetBootstrapCoordinator.prototype);
