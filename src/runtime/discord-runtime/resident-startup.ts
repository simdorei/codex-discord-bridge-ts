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
 * the single-instance guard. No gateway/queue intake is started here.
 * Store hooks still use the existing synchronous profile; this is not global DB
 * offload or native Windows startup qualification. */
export async function startRuntimeResident(config:PortableSessionConfig,path:string,runtimeId:string,startupChannel:bigint|null,render:(error:unknown)=>string,signal?:AbortSignal):Promise<PortableResidentLifecycle>{
 signal?.throwIfAborted();
 const pinned=cloneOwnedSerdeValue(config) as PortableSessionConfig;
 const custody=await initializeRuntimeCustody(path,runtimeId,startupChannel,render);
 signal?.throwIfAborted();
 const owner=await PortableResidentLifecycle.start(pinned,(_stage,error)=>render(error),{
  persistDeadWork:custody.persistDeadWork,
  // Dead-generation fencing has no separate exit side effect in Rust.
  // The installed idle journal owns exact owner/generation exit settlement.
  oldChildExited(){},
 },signal,{fence:custody.fence,renderError:render});
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
