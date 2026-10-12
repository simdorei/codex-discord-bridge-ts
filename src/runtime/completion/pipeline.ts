import {NativeIdleInventoryReader} from "./native-idle-inventory.ts";
import {NativeTypingInventoryReader} from "./native-typing.ts";
import {NativeCompletionDiscoveryReader} from "./native-discovery.ts";
import {CompletionDiscovery} from "./scheduler/discovery.ts";
import {NativeHttpPayloadReader} from "./native-http-payload.ts";
import {NativeCompletionHistoryReader} from "./native-history-read.ts";
import {NativeObservedPayloadReader} from "./native-observed-payload.ts";
import {NativeCompletionOwnerReader} from "./native-owner-read.ts";
import {NativeCompletionHeadsOwner} from "./native-heads.ts";
import {createNativeObservationState} from "./native-observation-state.ts";
import type {PortableResidentLifecycle} from "../../app-server/portable-resident-lifecycle.ts";
import {ResidentStateError} from "../../app-server/resident-state.ts";
import {invokeSynchronousVoid} from "../../core/synchronous-void.ts";
import {StateAccessFacade as state} from "../../store/state-access-facade.ts";
import {DrainGateError} from "../../admission/drain-gate.ts";
import {QueueStartCoordinator,QueueIntegerRangeError} from "../queue-runner/start-coordinator.ts";
import {preparePendingAsyncQuestions} from "../async-question-observation.ts";
import {deliverCheckedAsyncQuestion} from "../async-question-delivery.ts";
import {CompletionSourceIntake} from "./source-intake.ts";
import {CompletionSourceReconciler} from "./source-reconciler.ts";
import {StagedCompletionHandler} from "./staged-handler.ts";
import {CompletionTypingDriver,residentTypingBackend} from "./typing-driver.ts";
import type {TypingTransport} from "./typing.ts";
import {CompletionIdleRelease} from "./idle-release.ts";
import {TerminalFence} from "./terminal-fence.ts";
import {CompletionScheduler} from "./scheduler/run.ts";
import {CompletionStateAdmission,prepareCompletionState,prepareCompletionStateOwned} from "./scheduler/state-admission.ts";
import {deliverCompletionEntry} from "./scheduler/http-work.ts";
import type {FinalDeliveryOptions} from "./final-delivery.ts";
const integer=(n:bigint)=>{if(typeof n!=="bigint"||n<0n||n>=(1n<<63n))throw new QueueIntegerRangeError();return n;};
type MaintenanceServer=Pick<PortableResidentLifecycle,"instanceId"|"generation"|"lifecycleSnapshot"|"forceRestartIfQuiescent">;
/** Exact source order: prepare questions first; then control admission and quarantine
 * stabilization. A busy quarantine is held, never treated as a successful restart. */
export async function maintainCompletionPipeline(server:MaintenanceServer,queue:QueueStartCoordinator,signal?:AbortSignal,prepare?:(path:string,runtime:string,generation:bigint,signal?:AbortSignal)=>Promise<void>):Promise<void>{
 signal?.throwIfAborted();const generation=integer(server.generation());if(prepare)await prepare(queue.dbPath,server.instanceId,generation,signal);else await preparePendingAsyncQuestions(queue.dbPath,server.instanceId,generation);signal?.throwIfAborted();
 let permit:ReturnType<QueueStartCoordinator['enterBackgroundRecovery']>=null;
 try{
  try{permit=queue.enterBackgroundRecovery();}catch(error){if(error instanceof DrainGateError&&error.kind==='Sealed')return;throw error;}
  const snapshot=server.lifecycleSnapshot();if(!snapshot.quarantined)return;
  if(await server.forceRestartIfQuiescent(signal))return;
  throw new ResidentStateError({kind:'GenerationQuarantined',generation:snapshot.generation});
 }finally{permit?.[0].release();}
}
export interface CompletionPipelineOptions{
 readonly nativeObservation?:boolean;
 readonly commentaryEnabled:boolean;readonly historyReadTimeoutMs:number;
 readonly delivery:FinalDeliveryOptions;readonly typing:TypingTransport;
 /** Mandatory passive public-safe rendering/reporting; never inspect arbitrary getters. */
 readonly render:(error:unknown)=>string;readonly report:(error:unknown)=>void;
 readonly terminalFence?:TerminalFence;
}
/** Composes indexed source -> owned target state -> guarded receipt delivery, plus
 * source-range reconciliation and scheduler maintenance. Caller supplies the SAME
 * resident/queue backend, installs its journal first, and owns native process lifetime.
 * Production HTTP and service bootstrap remain separate. */
export class CompletionPipeline{
 readonly #nativeIdleInventory:NativeIdleInventoryReader|undefined;readonly #nativeTyping:NativeTypingInventoryReader|undefined;readonly #nativeMetadata:NativeCompletionDiscoveryReader|undefined;readonly #nativeHttp:NativeHttpPayloadReader|undefined;readonly #nativeHistory:NativeCompletionHistoryReader|undefined;readonly #nativeObserved:NativeObservedPayloadReader|undefined;readonly #nativeOwners:NativeCompletionOwnerReader|undefined;readonly #nativeHeads:NativeCompletionHeadsOwner|undefined;readonly #nativeObservation:ReturnType<typeof createNativeObservationState>|undefined;readonly #typing:CompletionTypingDriver;readonly #idle:CompletionIdleRelease;readonly #server:PortableResidentLifecycle;readonly #scheduler:CompletionScheduler<CompletionStateAdmission>;readonly #intake:CompletionSourceIntake;readonly #reconciler:CompletionSourceReconciler;readonly terminalFence:TerminalFence;#used=false;
 constructor(server:PortableResidentLifecycle,queue:QueueStartCoordinator,options:CompletionPipelineOptions){
  this.#server=server;const path=queue.dbPath,render=options.render,reportCallback=options.report,report=(error:unknown)=>invokeSynchronousVoid(reportCallback,options,[error]),delivery=options.delivery;
  if(options.nativeObservation!==undefined&&typeof options.nativeObservation!=="boolean")throw new TypeError("Expected native observation flag");
  this.#nativeIdleInventory=options.nativeObservation?new NativeIdleInventoryReader(path):undefined;this.#nativeTyping=options.nativeObservation?new NativeTypingInventoryReader(path):undefined;this.#nativeMetadata=options.nativeObservation?new NativeCompletionDiscoveryReader(path):undefined;this.#nativeHttp=options.nativeObservation?new NativeHttpPayloadReader(path):undefined;this.#nativeHistory=options.nativeObservation?new NativeCompletionHistoryReader(path):undefined;this.#nativeOwners=options.nativeObservation?new NativeCompletionOwnerReader(path):undefined;this.#nativeObserved=options.nativeObservation?new NativeObservedPayloadReader(path):undefined;const handler=new StagedCompletionHandler(server,queue,{commentaryEnabled:options.commentaryEnabled,historyReadTimeoutMs:options.historyReadTimeoutMs,render,...(this.#nativeHistory===undefined?{}:{nativeHistory:{owners:this.#nativeOwners!,reads:this.#nativeHistory}}),...(this.#nativeOwners===undefined?{}:{nativeOwners:this.#nativeOwners}),...(this.#nativeObserved===undefined?{}:{nativeObserved:this.#nativeObserved})});
  this.#nativeObservation=options.nativeObservation?createNativeObservationState(path):undefined;this.#nativeHeads=options.nativeObservation?new NativeCompletionHeadsOwner(path):undefined;const observation=this.#nativeObservation?.state??state;
  this.terminalFence=options.terminalFence??new TerminalFence();
  this.#scheduler=new CompletionScheduler(path,{
   ...(this.#nativeOwners===undefined?{}:{prepareOwned:(work:Parameters<typeof prepareCompletionStateOwned>[1])=>prepareCompletionStateOwned(queue.locks,work,(target,turn,signal)=>this.#nativeOwners!.read(target,turn,signal))}),
   instanceId:()=>server.instanceId,generation:()=>server.generation(),prepare:work=>prepareCompletionState(path,queue.locks,work),
   state:async(work,permit,signal)=>{if(work.kind==='Live')await handler.handleLive(work.live.payload,permit,signal);else await handler.handleDurable(work.entry,permit,signal);},
   http:async(entry,signal)=>{signal.throwIfAborted();await deliverCompletionEntry(path,entry,{instanceId:()=>server.instanceId,generation:()=>server.generation()},delivery,{deliverChecked:(p,g,t,q)=>deliverCheckedAsyncQuestion(p,g,t,q,render)},this.#nativeHttp,signal);},
   prepareFailed:error=>{server.markIdleObservationGap(report);report(error);},gap:()=>{server.markIdleObservationGap(report);},report,
   freshHeads:target=>this.#nativeHeads?.heads(target,server.instanceId,integer(server.generation()))??state.completionHeadsForTarget(path,target,server.instanceId,integer(server.generation())),maintain:signal=>maintainCompletionPipeline(server,queue,signal,this.#nativeObservation===undefined?undefined:async(p,r,g,cancel)=>{if(r!==server.instanceId)throw new TypeError('Question maintenance owner changed');if(p!==path)throw new TypeError('Question maintenance path changed');await this.#nativeObservation!.prepareResidentQuestions(server,g,cancel);}),
  },this.#nativeMetadata===undefined?{}:{discovery:new CompletionDiscovery(undefined,undefined,this.#nativeMetadata)});
  this.#intake=new CompletionSourceIntake(path,server,this.terminalFence,options.commentaryEnabled,failure=>report(failure.error),undefined,observation,event=>this.#scheduler.offer(event),observation,this.#nativeObservation?.observeQuestions);
  this.#reconciler=new CompletionSourceReconciler(path,server,options.commentaryEnabled,failure=>report(failure.error),observation,observation,this.#nativeObservation?.observeQuestions);
  this.#idle=new CompletionIdleRelease(server,queue,render,failure=>report(failure.error),this.#nativeIdleInventory);
  this.#typing=new CompletionTypingDriver(path,residentTypingBackend(server),this.terminalFence,options.typing,report,this.#nativeTyping);
 }
 notifyDeliveryReady():void{this.#scheduler.notifyDeliveryReady();}
 get availableEventBytes():number{return this.#intake.availableBytes;}
 /** Pass the exact receiver captured before startup recovery. Precondition failure
  * retains caller ownership; an entered intake disposes it after joined stop. */
 async run(signal:AbortSignal,startupReceiver?:ReturnType<PortableResidentLifecycle['subscribeNotifications']>):Promise<void>{
  if(this.#used)throw new TypeError('Completion pipeline already used');this.#used=true;
  if(!this.#server.observationTrackingEnabled())throw new TypeError('Install the runtime observation journal before completion intake');
  const cancel=new AbortController(),stop=()=>cancel.abort(signal.reason);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
  const failures:unknown[]=[];const track=async(work:Promise<void>)=>{try{await work;}catch(error){if(!cancel.signal.aborted||error!==cancel.signal.reason){failures.push(error);cancel.abort(error);}}};
  try{
   const intake=track(this.#intake.run(cancel.signal,undefined,startupReceiver).finally(()=>this.#scheduler.finishInput()));
   const reconcile=track(this.#reconciler.run(cancel.signal));
   const idle=track(this.#idle.run(cancel.signal));
   const typing=track(this.#typing.run(cancel.signal));
   const scheduler=track(this.#scheduler.run(cancel.signal).finally(()=>cancel.abort(new Error('Completion scheduler finished'))));
   await Promise.all([intake,reconcile,idle,typing,scheduler]);
  }finally{cancel.abort(new Error('Completion pipeline stopped'));signal.removeEventListener('abort',stop);try{await this.#nativeObservation?.close();}finally{try{await this.#nativeHeads?.close();}finally{try{await this.#nativeOwners?.close();}finally{try{await this.#nativeObserved?.close();}finally{try{await this.#nativeHistory?.close();}finally{try{await this.#nativeHttp?.close();}finally{try{await this.#nativeMetadata?.close();}finally{try{await this.#nativeTyping?.close();}finally{await this.#nativeIdleInventory?.close();}}}}}}}}}
  if(failures.length===1)throw failures[0];if(failures.length>1)throw new AggregateError(failures,'Completion pipeline failed');
 }
}
