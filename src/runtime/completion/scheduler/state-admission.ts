import type {CompletionPreparation} from "./execution.ts";
import {TargetLocks,type TargetLease} from "../../../core/keyed-locks.ts";
import {extractTurnId} from "../../../app-server/identity.ts";
import {StateAccessFacade,type IStateAccessFacade} from "../../../store/state-access-facade.ts";
import {snapshotStoredQueueJob,storedQueueJobsEqual,type StoredQueueJob} from "../../../store/queue-read.ts";
import type {CompletionNotification} from "./envelope.ts";
import type {ReadyStateWork,ReadyAdmission} from "./ready.ts";
import {CompletionHeldError} from "../receipt-sender.ts";
type Owner={readonly kind:"NotTerminal"|"Missing"}|{readonly kind:"Exact";readonly job:StoredQueueJob};
const token=Symbol("owned completion admission");
/** Exact original owner captured under the SAME target registry as queue/recovery.
 * A permit is valid only until release; it is not native/HTTP send permission. */
export class CompletionStateAdmission{
 readonly #lease:TargetLease;readonly #owner:Owner;
 constructor(key:symbol,lease:TargetLease,owner:Owner){if(key!==token)throw new TypeError("Expected owned completion admission");this.#lease=lease;this.#owner=owner;}
 get target():string{return this.#lease.target;}
 /** Trusted queue adapter borrows through its own registry; caller retains this admission. */
 borrowLease():TargetLease{this.#lease.requireTarget(this.target);return this.#lease;}
 requireTarget(target:string):void{this.#lease.requireTarget(target);}
 validateOwner(input:StoredQueueJob):void{
  this.#lease.requireTarget(this.target);const current=snapshotStoredQueueJob(input);
  if(this.#owner.kind==="Missing"||(this.#owner.kind==="Exact"&&!storedQueueJobsEqual(this.#owner.job,current)))throw new CompletionHeldError("completion admission owner changed");
 }
 release():void{this.#lease.release();}
}
/** Nonwaiting synchronous prepare for CompletionReady.takeStateAdmitted.
 * Uses the initialized-existing store profile so no await escapes the held snapshot. */
export function prepareCompletionState(path:string,locks:TargetLocks,work:ReadyStateWork<CompletionNotification>,state:Pick<IStateAccessFacade,"listFilteredExisting">=StateAccessFacade):ReadyAdmission<CompletionStateAdmission>|null{
 const target=work.kind==="Live"?work.live.target:work.entry.target,lease=locks.tryAcquire(target);if(lease===undefined)return null;
 try{
  let turn:string|null=null;if(work.kind==="Live"&&work.live.payload.notification.method==="turn/completed")turn=extractTurnId(work.live.payload.notification.params);else if(work.kind==="Durable"&&work.entry.source==="Observed")turn=work.entry.turn;
  let owner:Owner={kind:"NotTerminal"};
  if(turn!==null){const found=state.listFilteredExisting(path,target,null).find(job=>job.state==="Running"&&job.turnId===turn);owner=found===undefined?{kind:"Missing"}:{kind:"Exact",job:snapshotStoredQueueJob(found)};}
  const needsNative=(work.kind==="Durable"||work.live.needsNative)||(owner.kind==="Exact"&&owner.job.goalWaiting),permit=new CompletionStateAdmission(token,lease,owner);
  return Object.freeze({permit,needsNative,release:()=>permit.release()});
 }catch(error){lease.release();throw error;}
}

/** Reserve the exact target synchronously. The scheduler retains state capacity and
 * live envelope bytes while this existing-store snapshot is read by its native owner.
 * No handler may use the admission until complete() succeeds. */
export function prepareCompletionStateOwned(locks:TargetLocks,work:ReadyStateWork<CompletionNotification>,readOwner:(target:string,turn:string,signal:AbortSignal)=>Promise<StoredQueueJob|null>):CompletionPreparation<CompletionStateAdmission>|null{
 const target=work.kind==='Live'?work.live.target:work.entry.target,lease=locks.tryAcquire(target);if(lease===undefined)return null;
 let released=false,started=false;
 const release=()=>{if(released)return;released=true;lease.release();};
 try{
  let turn:string|null=null;if(work.kind==='Live'&&work.live.payload.notification.method==='turn/completed')turn=extractTurnId(work.live.payload.notification.params);else if(work.kind==='Durable'&&work.entry.source==='Observed')turn=work.entry.turn;
  const originalTurn=turn,baseNative=work.kind==='Durable'||work.live.needsNative;
  return Object.freeze({release,complete:async(signal:AbortSignal)=>{
   if(started||released)throw new TypeError('Completion preparation already used or released');started=true;signal.throwIfAborted();lease.requireTarget(target);
   let owner:Owner={kind:'NotTerminal'};
   if(originalTurn!==null){const found=await readOwner(target,originalTurn,signal);signal.throwIfAborted();lease.requireTarget(target);owner=found===null?{kind:'Missing'}:{kind:'Exact',job:snapshotStoredQueueJob(found)};
    if(owner.kind==='Exact'&&(owner.job.targetThreadId!==target||owner.job.turnId!==originalTurn||owner.job.state!=='Running'))throw new CompletionHeldError('completion read owner identity changed');}
   signal.throwIfAborted();lease.requireTarget(target);
   return Object.freeze({permit:new CompletionStateAdmission(token,lease,owner),needsNative:baseNative||(owner.kind==='Exact'&&owner.job.goalWaiting)});
  }});
 }catch(error){release();throw error;}
}
