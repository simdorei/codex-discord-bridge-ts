import {PortableResidentLifecycle,type NativeRecoveryObservation} from '../../app-server/portable-resident-lifecycle.ts';
import {AdmissionPermit} from '../../admission/drain-gate.ts';
import {QueueStartCoordinator} from '../queue-runner/start-coordinator.ts';
import {TargetLocks,type TargetLease} from '../../core/keyed-locks.ts';
import {parseStopControlJson,serializeStopControl,type StopControl} from '../../store/stop-control-dispatch.ts';
import {StateAccessFacade} from '../../store/state-access-facade.ts';
import {openExisting} from '../../store/existing-store.ts';
import type {BridgeState} from '../bridge-state.ts';
import type {NativeBridgeStateOwner} from '../bridge-state-native.ts';
import {snapshotSettingsBinding,validateSelectedSettingsSnapshot,captureSelectedSettingsCheck} from './settings-snapshot.ts';
/** One original only. Caller binds queue/server to the same runtime and owns
 * the outer target lease. This function pins that registry's lease until cleanup.
 * No interrupt/resume/start. 1500ms is cooperative, not SQL preemption. */
export async function recoverStoppedExecution(queue:QueueStartCoordinator,server:PortableResidentLifecycle,lease:TargetLease,input:StopControl,bridge:Pick<BridgeState,'selectedThreadId'>,nativeBridge?:NativeBridgeStateOwner,signal?:AbortSignal):Promise<number>{
 const original=parseStopControlJson(serializeStopControl(input));
 return TargetLocks.prototype.runUnderLease.call(queue.locks,lease,async borrowed=>{
  borrowed.requireTarget(original.target);signal?.throwIfAborted();
  const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(()=>controller.abort(new Error('Stop recovery read deadline; original authority retained')),1500);
  let permit:AdmissionPermit|null=null,proof:NativeRecoveryObservation|undefined;
  try{
   permit=QueueStartCoordinator.prototype.enterBackgroundRecovery.call(queue)?.[0]??null;
   const binding=snapshotSettingsBinding(original.binding),check=nativeBridge===undefined?()=>validateSelectedSettingsSnapshot(binding,bridge):await captureSelectedSettingsCheck(binding,nativeBridge,controller.signal);
   check();controller.signal.throwIfAborted();
   proof=await PortableResidentLifecycle.prototype.observeStoppedExecution.call(server,original.target,original.turn,500,controller.signal);
   controller.signal.throwIfAborted();const db=openExisting(queue.dbPath,100);let committed=false;
   try{
    db.exec('BEGIN IMMEDIATE');const cancelled=StateAccessFacade.recoverStoppedTerminalIn(db,original,proof.observation(),proof.residentId(),proof.generation(),Date.now()/1000);
    check();controller.signal.throwIfAborted();
    const commit=()=>{proof!.withCurrentConnection(()=>{controller.signal.throwIfAborted();check();db.exec('COMMIT');committed=true;});};
    if(permit===null)commit();else AdmissionPermit.prototype.withUnsealed.call(permit,commit);
    return cancelled;
   }finally{try{if(!committed&&db.isTransaction)db.exec('ROLLBACK');}finally{db.close();}}
  }finally{try{proof?.dispose();}finally{try{permit?.release();}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}}}
 }) as Promise<number>;
}
