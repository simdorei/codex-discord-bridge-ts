import {types} from 'node:util';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {QueueStartCoordinator} from '../queue-runner/start-coordinator.ts';
import {AppServerTurnBackend} from '../app-server-turn-backend.ts';
import {PromptIntakeProcessor} from '../prompt-intake/processor.ts';
import {BridgeState} from '../bridge-state.ts';
import {SettingsTargetResolver} from '../settings-binding.ts';
import type {DiagnosticPaths} from '../diagnostic-report.ts';
import type {MessageBusinessServices,MessageActionContext} from '../message-worker/processor.ts';
import type {CommandAction} from '../command-plan.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
import {BasicActionDispatcher} from './basic-dispatcher.ts';
import {snapshotRuntimeCommand,snapshotActionContext} from './command-snapshot.ts';
import {ActionThreadSelection} from './thread-selection.ts';
import {ControlTurnVerifier} from './control-turn.ts';
import {BusyResultProducer} from './busy-result.ts';
import {ActionTargetServices} from './action-target.ts';
import {NewThreadExecutor,type NewMirrorLink} from './new-executor.ts';
import type {NewAttemptReport} from './new-attempt.ts';
import {QueuePromptExecutor} from './queue-prompt.ts';
import {RetractAction} from './retract-action.ts';
import {PromptControlActions} from './prompt-controls.ts';
import {OpenThreadAction} from './open-thread.ts';
import {SettingsAction} from './settings-action.ts';
import {AdmittedSettingsExecutor} from './settings-custody.ts';
import {AdmittedArchiveExecutor} from './archive-action.ts';
import {AdmittedResumeExecutor} from './resume-action.ts';
import {AdmittedStopExecutor} from './stop-custody.ts';
import {StopActionExecutor} from './stop-action.ts';
import {AdmittedRepairExecutor} from './repair-action.ts';
import {InvalidActionRequestError,MissingActionAppServerError} from './errors.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
export interface RuntimeExecutorDependencies{
 readonly paths:DiagnosticPaths;readonly bridge:BridgeState;readonly server:PortableResidentLifecycle|null;
 readonly backend:AppServerTurnBackend|null;readonly queue:QueueStartCoordinator;
 readonly render:(error:unknown)=>string;readonly preparePrompt:(raw:string,target:string,signal?:AbortSignal)=>Promise<string>;
 readonly mirror:NewMirrorLink|null;readonly reportNewAttempt:(report:NewAttemptReport)=>void;readonly resumeTimeoutMs:number;
}
/** Concrete message business composition. All controls share queue.locks, and
 * lifecycle/settings mutations only enter their original-admission wrappers.
 * Missing Windows recovery/mirror synchronization/archive deletion remain explicit
 * Unsupported results in the basic dispatcher, never a successful no-op.
 * A native server, queue backend and live gateway still require bootstrap and
 * ownership qualification; this constructor does not start any of them. */
export class RuntimeCommandExecutor implements MessageBusinessServices{
 readonly #basic:BasicActionDispatcher;readonly #queue:QueueStartCoordinator;readonly #new:NewThreadExecutor;readonly #prompts:QueuePromptExecutor;readonly #retract:RetractAction;readonly #controls:PromptControlActions;readonly #open:OpenThreadAction;readonly #settings:AdmittedSettingsExecutor;readonly #archive:AdmittedArchiveExecutor|null;readonly #resume:AdmittedResumeExecutor|null;readonly #stop:AdmittedStopExecutor;readonly #repair:AdmittedRepairExecutor|null;
 constructor(input:RuntimeExecutorDependencies){
  const get=<K extends keyof RuntimeExecutorDependencies>(key:K)=>gatewayOwnField(input,key) as RuntimeExecutorDependencies[K];
  const paths=cloneOwnedSerdeValue(get('paths')) as DiagnosticPaths;for(const key of ['state','mirror','bridge'] as const)requireDiscordText(paths[key]);
  const bridge=get('bridge'),server=get('server'),backend=get('backend'),queue=get('queue'),render=get('render'),prepare=get('preparePrompt'),timeout=get('resumeTimeoutMs');
  if(queue.dbPath!==paths.mirror)throw new InvalidActionRequestError('queue and action database differ');
  if(typeof prepare!=='function'||types.isProxy(prepare)||types.isGeneratorFunction(prepare))throw new TypeError('Expected prompt preparation function');
  const locks=queue.locks,selection=new ActionThreadSelection(paths.state,paths.mirror,bridge),control=new ControlTurnVerifier(paths.mirror,server,bridge,locks),busy=new BusyResultProducer(paths.mirror,control,queue.reads);
  const targets=new ActionTargetServices(paths.mirror,bridge,queue,{preparePrompt:prepare,busyResult:BusyResultProducer.prototype.busyResult.bind(busy)}),intake=new PromptIntakeProcessor(paths.mirror,queue,targets);
  this.#queue=queue;this.#basic=new BasicActionDispatcher(paths,bridge,server,locks,render,timeout);
  this.#new=new NewThreadExecutor(paths.mirror,paths.state,queue,intake,bridge,server,backend,get('mirror'),get('reportNewAttempt'));
  this.#prompts=new QueuePromptExecutor(paths.mirror,selection,targets,queue,intake,busy);this.#retract=new RetractAction(paths.mirror,selection);
  this.#controls=new PromptControlActions(paths.mirror,selection,targets,control,server);this.#open=new OpenThreadAction(selection,targets,bridge,server,timeout);
  this.#settings=new AdmittedSettingsExecutor(paths.mirror,new SettingsAction(selection,new SettingsTargetResolver(paths.state,paths.mirror,bridge),bridge,server,control,timeout));
  this.#stop=new AdmittedStopExecutor(paths.mirror,bridge,new StopActionExecutor(paths.mirror,server,bridge,locks,render));
  this.#archive=server===null?null:new AdmittedArchiveExecutor(paths.mirror,paths.state,bridge,server,locks,timeout);
  this.#resume=server===null?null:new AdmittedResumeExecutor(paths.mirror,paths.state,bridge,server,locks,timeout);
  this.#repair=server===null?null:new AdmittedRepairExecutor(paths.mirror,bridge,server,locks,render);Object.freeze(this);
 }
 targetThreadId(channel:bigint,signal?:AbortSignal):Promise<string>{return this.#basic.targetThreadId(channel,signal);}
 notifyDeliveryReady():void{invokeSynchronousVoid(QueueStartCoordinator.prototype.notifyDeliveryReady,this.#queue,[]);}
 /** Own-data functions match the processor's strict service capture contract. */
 messageServices():MessageBusinessServices{return Object.freeze({targetThreadId:RuntimeCommandExecutor.prototype.targetThreadId.bind(this),executeWithIngressContext:RuntimeCommandExecutor.prototype.executeWithIngressContext.bind(this),notifyDeliveryReady:RuntimeCommandExecutor.prototype.notifyDeliveryReady.bind(this)});}
 async executeWithIngressContext(input:CommandAction,inputActor:MessageActionContext,key:string,signal?:AbortSignal):Promise<ActionResult>{
  signal?.throwIfAborted();const action=snapshotRuntimeCommand(input),actor=snapshotActionContext(inputActor);requireDiscordText(key);if(actor.discordMessageId===null)throw new InvalidActionRequestError('admitted message/interaction event identity is required');let result:ActionResult;
  if(typeof action==='object'){
   if('New'in action)result=await this.#new.execute(actor,action.New.prompt,signal);
   else if('Ask'in action)result=await this.#prompts.queuePrompt(actor.channelId,actor.userId,actor.discordMessageId,actor.autoQueueWhenBusy,action.Ask.prompt,signal);
   else if('Interview'in action)result=await this.#prompts.interview(actor.channelId,actor.userId,actor.discordMessageId,actor.autoQueueWhenBusy,action.Interview.prompt,signal);
   else if('Settings'in action||'AutoReserve'in action)result=await this.#settings.execute(actor,action,key,signal);
   else if('Archive'in action){if(this.#archive===null)throw new MissingActionAppServerError();result=await this.#archive.execute(actor,action.Archive.reference,key,signal);}
   else if('Resume'in action){if(this.#resume===null)throw new MissingActionAppServerError();result=await this.#resume.execute(actor,action.Resume.reference,key,signal);}
   else if('Stop'in action)result=await this.#stop.execute(actor,action.Stop.reference,key,signal);
   else if('Repair'in action){if(this.#repair===null)throw new MissingActionAppServerError();result=await this.#repair.execute(actor,action.Repair.reference,key,signal);}
   else if('Retract'in action)result={text:await this.#retract.retract(actor.channelId,actor.userId,action.Retract.reference,signal),waitsForFinal:false,ui:null};
   else if('Steer'in action)result=await this.#controls.steer(actor.channelId,action.Steer.prompt,signal);
   else if('Open'in action)result=await this.#open.open(action.Open.reference,action.Open.abort,signal);
   else if('DiscardRequest'in action)throw new InvalidActionRequestError('discard-request requires authenticated message custody and live normal admission');
   else result=await this.#basic.execute(action,actor,signal);
  }else if(action==='Approval')result=await this.#controls.approval(actor.channelId,actor.userId,signal);
  else result=await this.#basic.execute(action,actor,signal);
  signal?.throwIfAborted();return snapshotActionResult(result);
 }
}
Object.freeze(RuntimeCommandExecutor.prototype);
