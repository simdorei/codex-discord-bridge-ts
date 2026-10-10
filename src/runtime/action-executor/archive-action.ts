import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {archiveThread,resumeThreadWithTimeout} from '../../app-server/requests.ts';
import {withStopOrigin,withArchiveStopScope} from '../../app-server/dispatch-origin.ts';
import {stopOriginForIngress} from '../../store/stop-revision-read.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {serdeField} from '../../app-server/value.ts';
import {serdeValueEqual} from '../../core/serde-value-equal.ts';
import {TargetLocks,type TargetLease} from '../../core/keyed-locks.ts';
import {BridgeState} from '../bridge-state.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {ActionThreadSelection} from './thread-selection.ts';
import {ArchiveTargetVerifier} from './archive-preflight.ts';
import {archiveOwnRequest,archiveDescendants,type ArchiveActor} from './archive-observation.ts';
import {archiveDispatchFailure} from './archive-failure.ts';
import {verifyArchivedScope} from './archive-persistence.ts';
import {snapshotSettingsBinding,validateLifecycleSettingsSnapshot,type FrozenSettingsBinding} from './settings-snapshot.ts';
import {InvalidActionRequestError,ActionIntegerRangeError} from './errors.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
/** Message-ingress-bound archive coordinator. Caller supplies the shared target
 * registry used by queue/other controls. Timeout cancels and joins this operation;
 * it never releases local leases by racing a still-running promise. */
export class AdmittedArchiveExecutor {
 readonly #path:string;readonly #codex:string;readonly #bridge:BridgeState;readonly #server:PortableResidentLifecycle;readonly #locks:TargetLocks;readonly #selection:ActionThreadSelection;readonly #verify:ArchiveTargetVerifier;readonly #timeout:number;
 constructor(path:string,codex:string,bridge:BridgeState,server:PortableResidentLifecycle,locks:TargetLocks,timeoutMs:number){
  requireDiscordText(path);requireDiscordText(codex);resumeThreadWithTimeout('',timeoutMs);this.#path=path;this.#codex=codex;this.#bridge=bridge;this.#server=server;this.#locks=locks;this.#timeout=timeoutMs;this.#selection=new ActionThreadSelection(codex,path,bridge);this.#verify=new ArchiveTargetVerifier(path,codex,this.#selection,server,timeoutMs);Object.freeze(this);
 }
 async execute(input:ArchiveActor,reference:string|null,key:string,signal?:AbortSignal):Promise<ActionResult>{
  const actor=cloneOwnedSerdeValue(input) as ArchiveActor;requireDiscordText(key);if(reference!==null)requireDiscordText(reference);for(const id of [actor.channelId,actor.userId,actor.discordMessageId]){if(typeof id!=='bigint'||id<0n||id>=1n<<64n)throw new TypeError('Expected admitted u64 archive actor');if(id>=1n<<63n)throw new ActionIntegerRangeError();}signal?.throwIfAborted();
  const cancel=new AbortController(),timeoutReason=new Error('archive operation deadline'),onAbort=()=>cancel.abort(signal?.reason);signal?.addEventListener('abort',onAbort,{once:true});const timer=setTimeout(()=>cancel.abort(timeoutReason),this.#timeout);let attempted=false;
  try{
   const record=await state.getIngress(this.#path,key);cancel.signal.throwIfAborted();if(record===null)throw new InvalidActionRequestError('lifecycle admission record is missing');
   const binding=snapshotSettingsBinding(serdeField(record.payload,'lifecycle_binding')??null),command={Archive:{reference}};
   if(record.ingressId!==key||record.eventId!==actor.discordMessageId||record.targetThreadId!==binding.target||!serdeValueEqual(binding.command,command))throw new InvalidActionRequestError('lifecycle admitted command or target identity differs');
   if(await archiveOwnRequest(this.#path,actor,reference,cancel.signal)!==key)throw new InvalidActionRequestError('archive original admission identity differs');
   return await withStopOrigin(stopOriginForIngress(record)??null,async()=>{
    await this.#binding(binding,actor.channelId,cancel.signal);
    const thread=await this.#selection.resolveThread(actor.channelId,binding.target);cancel.signal.throwIfAborted();if(thread.id!==binding.target)throw new InvalidActionRequestError('archive admitted original target no longer resolves exactly; no replacement target will be used');const root=await this.#locks.acquire(thread.id,cancel.signal);
    try{
     const generation=this.#server.generation();await this.#binding(binding,actor.channelId,cancel.signal);await this.#verify.preflight(actor.channelId,reference,thread.id,generation,key,cancel.signal);await this.#verify.loadIdle(thread.id,generation,cancel.signal);
     const children=await archiveDescendants(this.#server,thread.id,generation,cancel.signal);
     return await withArchiveStopScope(thread.id,children,async()=>{
      const leases:TargetLease[]=[];try{
       for(const child of children){leases.push(await this.#locks.acquire(child,cancel.signal));await this.#verify.preflight(0n,child,child,generation,key,cancel.signal);await this.#verify.loadIdle(child,generation,cancel.signal);}
       const observed=await archiveDescendants(this.#server,thread.id,generation,cancel.signal);if(!serdeValueEqual(children,observed))throw new InvalidActionRequestError('archive descendant scope changed; no archive was sent');
       for(const child of children)await this.#verify.preflight(0n,child,child,generation,key,cancel.signal);await this.#verify.preflight(actor.channelId,reference,thread.id,generation,key,cancel.signal);await this.#binding(binding,actor.channelId,cancel.signal);
       if(await archiveOwnRequest(this.#path,actor,reference,cancel.signal)!==key)throw new InvalidActionRequestError('archive original admission changed');
       const scope=[...children,thread.id],reservation=await state.reserveArchiveScope(this.#path,scope,key);cancel.signal.throwIfAborted();attempted=true;
       try{await this.#server.execute(archiveThread(thread.id),generation,cancel.signal);}catch(error){throw await archiveDispatchFailure(this.#path,reservation,thread.id,error);}
       await verifyArchivedScope(this.#codex,scope,cancel.signal);cancel.signal.throwIfAborted();await state.markArchiveVerified(this.#path,reservation);
       const selected=BridgeState.prototype.selectedThreadId.call(this.#bridge);if(selected!==null&&scope.includes(selected))BridgeState.prototype.setSelectedThreadId.call(this.#bridge,null);
       return snapshotActionResult({text:`Archived Codex thread ${thread.id} (${scope.length} conversations, persisted state verified).`,waitsForFinal:false,ui:null});
      }finally{for(let i=leases.length-1;i>=0;i--)leases[i]!.release();}
     });
    }finally{root.release();}
   });
  }catch(error){if(cancel.signal.reason===timeoutReason)throw new InvalidActionRequestError(`archive operation timed out; ${attempted?'archive dispatch was attempted; delivery and outcome is unverified and some conversations may already be archived; do not automatically retry':'no archive was sent'}`);throw error;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
 }
 async #binding(binding:FrozenSettingsBinding,channel:bigint,signal:AbortSignal):Promise<void>{signal.throwIfAborted();await validateLifecycleSettingsSnapshot(this.#path,binding,channel,this.#bridge);signal.throwIfAborted();}
}
Object.freeze(AdmittedArchiveExecutor.prototype);
