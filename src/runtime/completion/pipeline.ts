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
import {TerminalFence} from "./terminal-fence.ts";
import {CompletionScheduler} from "./scheduler/run.ts";
import {CompletionStateAdmission,prepareCompletionState} from "./scheduler/state-admission.ts";
import {deliverCompletionEntry} from "./scheduler/http-work.ts";
import type {FinalDeliveryOptions} from "./final-delivery.ts";
const integer=(n:bigint)=>{if(typeof n!=="bigint"||n<0n||n>=(1n<<63n))throw new QueueIntegerRangeError();return n;};
type MaintenanceServer=Pick<PortableResidentLifecycle,"instanceId"|"generation"|"lifecycleSnapshot"|"forceRestartIfQuiescent">;
/** Exact source order: prepare questions first; then control admission and quarantine
 * stabilization. A busy quarantine is held, never treated as a successful restart. */
export async function maintainCompletionPipeline(server:MaintenanceServer,queue:QueueStartCoordinator,signal?:AbortSignal):Promise<void>{
 signal?.throwIfAborted();await preparePendingAsyncQuestions(queue.dbPath,server.instanceId,integer(server.generation()));signal?.throwIfAborted();
 let permit:ReturnType<QueueStartCoordinator['enterBackgroundRecovery']>=null;
 try{
  try{permit=queue.enterBackgroundRecovery();}catch(error){if(error instanceof DrainGateError&&error.kind==='Sealed')return;throw error;}
  const snapshot=server.lifecycleSnapshot();if(!snapshot.quarantined)return;
  if(await server.forceRestartIfQuiescent(signal))return;
  throw new ResidentStateError({kind:'GenerationQuarantined',generation:snapshot.generation});
 }finally{permit?.[0].release();}
}
export interface CompletionPipelineOptions{
 readonly commentaryEnabled:boolean;readonly historyReadTimeoutMs:number;
 readonly delivery:FinalDeliveryOptions;
 /** Mandatory passive public-safe rendering/reporting; never inspect arbitrary getters. */
 readonly render:(error:unknown)=>string;readonly report:(error:unknown)=>void;
 readonly terminalFence?:TerminalFence;
}
/** Composes indexed source -> owned target state -> guarded receipt delivery, plus
 * source-range reconciliation and scheduler maintenance. Caller supplies the SAME
 * resident/queue backend, installs its journal first, and owns native process lifetime.
 * Idle-release and typing drivers, production HTTP and service bootstrap are separate. */
export class CompletionPipeline{
 readonly #server:PortableResidentLifecycle;readonly #scheduler:CompletionScheduler<CompletionStateAdmission>;readonly #intake:CompletionSourceIntake;readonly #reconciler:CompletionSourceReconciler;readonly terminalFence:TerminalFence;#used=false;
 constructor(server:PortableResidentLifecycle,queue:QueueStartCoordinator,options:CompletionPipelineOptions){
  this.#server=server;const path=queue.dbPath,render=options.render,reportCallback=options.report,report=(error:unknown)=>invokeSynchronousVoid(reportCallback,options,[error]),handler=new StagedCompletionHandler(server,queue,{commentaryEnabled:options.commentaryEnabled,historyReadTimeoutMs:options.historyReadTimeoutMs,render}),delivery=options.delivery;
  this.terminalFence=options.terminalFence??new TerminalFence();
  this.#scheduler=new CompletionScheduler(path,{
   instanceId:()=>server.instanceId,generation:()=>server.generation(),prepare:work=>prepareCompletionState(path,queue.locks,work),
   state:async(work,permit,signal)=>{if(work.kind==='Live')await handler.handleLive(work.live.payload,permit,signal);else await handler.handleDurable(work.entry,permit,signal);},
   http:async(entry,signal)=>{signal.throwIfAborted();await deliverCompletionEntry(path,entry,{instanceId:()=>server.instanceId,generation:()=>server.generation()},delivery,{deliverChecked:(p,g,t,q)=>deliverCheckedAsyncQuestion(p,g,t,q,render)});},
   prepareFailed:error=>{server.markIdleObservationGap(report);report(error);},gap:()=>{server.markIdleObservationGap(report);},report,
   freshHeads:target=>state.completionHeadsForTarget(path,target,server.instanceId,integer(server.generation())),maintain:signal=>maintainCompletionPipeline(server,queue,signal),
  });
  this.#intake=new CompletionSourceIntake(path,server,this.terminalFence,options.commentaryEnabled,failure=>report(failure.error),undefined,state,event=>this.#scheduler.offer(event));
  this.#reconciler=new CompletionSourceReconciler(path,server,options.commentaryEnabled,failure=>report(failure.error));
 }
 notifyDeliveryReady():void{this.#scheduler.notifyDeliveryReady();}
 get availableEventBytes():number{return this.#intake.availableBytes;}
 async run(signal:AbortSignal):Promise<void>{
  if(this.#used)throw new TypeError('Completion pipeline already used');this.#used=true;
  if(!this.#server.observationTrackingEnabled())throw new TypeError('Install the runtime observation journal before completion intake');
  const cancel=new AbortController(),stop=()=>cancel.abort(signal.reason);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
  const failures:unknown[]=[];const track=async(work:Promise<void>)=>{try{await work;}catch(error){if(!cancel.signal.aborted||error!==cancel.signal.reason){failures.push(error);cancel.abort(error);}}};
  try{
   const intake=track(this.#intake.run(cancel.signal).finally(()=>this.#scheduler.finishInput()));
   const reconcile=track(this.#reconciler.run(cancel.signal));
   const scheduler=track(this.#scheduler.run(cancel.signal).finally(()=>cancel.abort(new Error('Completion scheduler finished'))));
   await Promise.all([intake,reconcile,scheduler]);
  }finally{cancel.abort(new Error('Completion pipeline stopped'));signal.removeEventListener('abort',stop);}
  if(failures.length===1)throw failures[0];if(failures.length>1)throw new AggregateError(failures,'Completion pipeline failed');
 }
}
