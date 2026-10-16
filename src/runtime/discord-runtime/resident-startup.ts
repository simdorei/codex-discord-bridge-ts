import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {NativeObservationLedgerOwner} from '../native-observation-ledger.ts';
import type {IdleReleaseToken} from '../../app-server/idle-release-journal.ts';
import {NativeIdleBeforeOwner} from '../native-idle-before.ts';
import {NativeMutationOwner,type NativeMutationReceipt} from '../native-mutation-owner.ts';
import {NativeResponseCompletionOwner} from '../native-response-completion-owner.ts';
import type {ResidentNativeDispatch} from '../../app-server/resident-native-dispatch.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import type {PortableSessionConfig} from '../../app-server/portable-session.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {initializeRuntimeCustody} from '../runtime-custody.ts';
import {installRuntimeIdleJournal} from '../idle-release-journal.ts';
/** Retains the exact owned resident when failed startup cleanup needs retry.
 * Never authorizes starting a replacement while the retained owner is unresolved. */
export class RuntimeResidentStartupCleanupError extends AggregateError {
 readonly owner:PortableResidentLifecycle;
 constructor(primary:unknown,cleanup:unknown,owner:PortableResidentLifecycle){
  super([primary,cleanup],'Runtime resident startup and owned cleanup failed',{cause:primary});
  this.name='RuntimeResidentStartupCleanupError';this.owner=owner;
 }
}
/** Source start_app_server ordering: durable custody, native resident, idle journal.
 * The caller supplies resolved process/client configuration and must already own
 * the single-instance guard throughout activation, spawn and handshake. Direct
 * callers promise that exclusivity; accounting is not a substitute. initialize /
 * initialized have no later DB mutation guard. No gateway/queue intake starts here.
 * Mutation begin/finish use one owned native persistence adapter. Other store
 * hooks and final validation still read synchronously; not complete DB isolation
 * or native Windows startup qualification. */
export async function startRuntimeResident(config:PortableSessionConfig,path:string,runtimeId:string,startupChannel:bigint|null,render:(error:unknown)=>string,signal?:AbortSignal):Promise<PortableResidentLifecycle>{
 signal?.throwIfAborted();
 const pinned=cloneOwnedSerdeValue(config) as PortableSessionConfig;path=pinNativeRuntimePath(path);
 const custody=await initializeRuntimeCustody(path,runtimeId,startupChannel,render,signal),dead=custody.nativeDeadGeneration;
 const cleanup:Array<()=>Promise<void>>=[()=>dead.close()];let owner:PortableResidentLifecycle;
 try{
 signal?.throwIfAborted();
 const native=new NativeMutationOwner(path,runtimeId,render);cleanup.push(()=>native.close());
 const idle=new NativeIdleBeforeOwner(path,render);cleanup.push(()=>idle.close());
 const responses=new NativeResponseCompletionOwner(path,runtimeId);cleanup.splice(2,0,()=>responses.close());
 const nativeResponseCompletion=Object.freeze({captureResponse:responses.captureResponse.bind(responses),finishResponse:responses.finishResponse.bind(responses),close:()=>responses.close()});
 const observation=new NativeObservationLedgerOwner(path);cleanup.push(()=>observation.close());
 const gaps=new NativeObservationLedgerOwner(path);cleanup.push(()=>gaps.close());
 const nativeObservation=Object.freeze({verified:(owner:string,generation:bigint,through:bigint)=>observation.verified({ownerId:owner,generation},through),discoverGap:(owner:string,generation:bigint,upper:bigint)=>gaps.discoverGap({ownerId:owner,generation},upper),recordGap:(owner:string,generation:bigint)=>gaps.markUnknownGap({ownerId:owner,generation},'original observation stream gap'),close:async()=>{await Promise.all([observation.close(),gaps.close()]);}});
 const nativeIdle=Object.freeze({before:(owner:string,generation:bigint,thread:string)=>idle.before(owner,generation,thread),transition:(token:IdleReleaseToken,state:string,detail:string)=>idle.transition(token,state,detail),settleExitedOwner:(owner:string,generation:bigint)=>idle.settleExitedOwner(owner,generation),close:()=>idle.close()});
 const nativeDispatch=Object.freeze<ResidentNativeDispatch>({
  beginMutationWithOrigin:c=>native.begin(c),beginQueueMutation:c=>native.beginQueue(c),beginStopMutation:c=>native.beginStop(c),
  finishMutation:(receipt,outcome)=>native.finish(receipt as NativeMutationReceipt,outcome),
  wasNotSubmitted:(error,attempt,wire,method)=>native.ownsUnsubmittedFailure(error,attempt,wire,method),
  validate:receipt=>native.validateForDispatch(receipt as NativeMutationReceipt),close:()=>native.close(),
 });
 owner=await PortableResidentLifecycle.start(pinned,(_stage,error)=>render(error),{
  persistDeadWork:custody.persistDeadWork,
  // Dead-generation fencing has no separate exit side effect in Rust.
  // The explicit native idle capability owns exact owner/generation exit settlement.
  oldChildExited(){},
 },signal,{fence:custody.fence,renderError:render,nativeDispatch,nativeIdle,nativeObservation,nativeResponseCompletion},{capture:(id,work,signal)=>dead.capture(id,work,signal),close:()=>dead.close()});}
 catch(primary){for(const close of cleanup)await close();throw primary;}
 try{
  signal?.throwIfAborted();
  installRuntimeIdleJournal(owner,path,render);
  signal?.throwIfAborted();
  return owner;
 }catch(primary){
  try{await owner.dispose();}catch(cleanup){throw new RuntimeResidentStartupCleanupError(primary,cleanup,owner);}
  throw primary;
 }
}
