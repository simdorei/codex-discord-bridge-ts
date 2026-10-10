import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {resumeThreadWithTimeout} from '../../app-server/requests.ts';
import {withStopOrigin} from '../../app-server/dispatch-origin.ts';
import {stopOriginForIngress} from '../../store/stop-revision-read.ts';
import {TargetLocks} from '../../core/keyed-locks.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {BridgeState} from '../bridge-state.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {ActionThreadSelection} from './thread-selection.ts';
import {verifyResumedThread} from './resume-verifier.ts';
import {loadLifecycleAdmission,type LifecycleActor} from './lifecycle-admission.ts';
import {validateLifecycleSettingsSnapshot} from './settings-snapshot.ts';
import {InvalidActionRequestError} from './errors.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
/** Admitted original-message resume only. Shares target controls and durable stop
 * origin. It never resends a prompt, forks or treats an ACK as loaded evidence. */
export class AdmittedResumeExecutor {
 readonly #path:string;readonly #bridge:BridgeState;readonly #server:PortableResidentLifecycle;readonly #locks:TargetLocks;readonly #selection:ActionThreadSelection;readonly #timeout:number;
 constructor(path:string,codex:string,bridge:BridgeState,server:PortableResidentLifecycle,locks:TargetLocks,timeoutMs:number){requireDiscordText(path);requireDiscordText(codex);resumeThreadWithTimeout('',timeoutMs);this.#path=path;this.#bridge=bridge;this.#server=server;this.#locks=locks;this.#timeout=timeoutMs;this.#selection=new ActionThreadSelection(codex,path,bridge);Object.freeze(this);}
 async execute(input:LifecycleActor,reference:string|null,key:string,signal?:AbortSignal):Promise<ActionResult>{
  const {actor,record,binding}=await loadLifecycleAdmission(this.#path,input,'Resume',reference,key,signal);await validateLifecycleSettingsSnapshot(this.#path,binding,actor.channelId,this.#bridge);signal?.throwIfAborted();
  return withStopOrigin(stopOriginForIngress(record)??null,async()=>{
   const thread=await this.#selection.resolveThread(actor.channelId,binding.target);signal?.throwIfAborted();if(thread.id!==binding.target)throw new InvalidActionRequestError('resume admitted original target no longer resolves exactly; no replacement target will be used');
   const deadline=performance.now()+this.#timeout,cancel=new AbortController(),timeoutReason=new Error('resume deadline'),abort=()=>cancel.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>cancel.abort(timeoutReason),this.#timeout);
   try{
    let lease;try{lease=await this.#locks.acquire(thread.id,cancel.signal);}catch(error){if(cancel.signal.reason===timeoutReason)throw new InvalidActionRequestError('resume control wait timed out; no prompt was resent');throw error;}
    try{
     const generation=this.#server.generation();await validateLifecycleSettingsSnapshot(this.#path,binding,actor.channelId,this.#bridge);cancel.signal.throwIfAborted();if(reference===null&&(await this.#selection.target(actor.channelId))[0]!==thread.id)throw new InvalidActionRequestError('resume target changed; no request was sent');this.#healthy(generation);let outcome;
     try{const remaining=Math.ceil(deadline-performance.now());if(remaining<=0)throw timeoutReason;outcome=await verifyResumedThread(this.#server,thread.id,generation,remaining,cancel.signal);cancel.signal.throwIfAborted();}
     catch(error){if(signal?.aborted&&error===signal.reason)throw error;throw new InvalidActionRequestError(`resume verification failed for ${thread.id}: ${cancel.signal.reason===timeoutReason?'resume verification timed out; loaded state is unverified':passiveErrorText(error,'verification failed')}. No prompt was resent; no fork was used.`);}
     this.#healthy(generation);if(reference===null&&(await this.#selection.target(actor.channelId))[0]!==thread.id)throw new InvalidActionRequestError('resume target changed during verification; original thread retained, no prompt was resent');await validateLifecycleSettingsSnapshot(this.#path,binding,actor.channelId,this.#bridge);cancel.signal.throwIfAborted();
     BridgeState.prototype.setSelectedThreadId.call(this.#bridge,thread.id);return snapshotActionResult({text:`Codex thread resume check complete.\nthread_id: ${thread.id}\nstatus: ${outcome}\nNo prompt was resent.`,waitsForFinal:false,ui:null});
    }finally{lease.release();}
   }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  });
 }
 #healthy(generation:bigint):void{const snapshot=this.#server.lifecycleSnapshot();if(!snapshot.healthy||snapshot.quarantined||snapshot.restartPending||this.#server.generation()!==generation)throw new InvalidActionRequestError('resume connection is unavailable or changed; no verified success, no prompt was resent');}
}
Object.freeze(AdmittedResumeExecutor.prototype);
