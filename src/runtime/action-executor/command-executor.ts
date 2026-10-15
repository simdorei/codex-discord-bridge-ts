import {NativeRecoveryDecisionOwner} from '../component-worker/recovery-decision-native.ts';
import {NativeBusyCreateWriter} from './busy-create-native.ts';
import {NativeSteerOriginWriter} from './steer-origin-native.ts';
import type {NativeBusySteerServices} from '../component-worker/busy-control.ts';
import {NativeStopDispatchWriter} from './stop-dispatch-native.ts';
import {NativeRetractWriter} from './retract-write-native.ts';
import {NativeStopAcceptanceWriter} from './stop-acceptance-native.ts';
import {AdmittedRecoverExecutor} from './recover-action.ts';
import {NativeArchiveWriter} from './archive-write-native.ts';
import {NativeStopPendingReader} from './stop-pending-native.ts';
import {createNativeControlReads} from './control-evidence-state.ts';
import {StateAccessFacade as controlStore} from '../../store/state-access-facade.ts';
import {NativeBridgeStateOwner} from '../bridge-state-native.ts';
import {createNativeSettingsBindingReads} from '../settings-binding-native.ts';
import {readArchivedScopeOffThread} from '../../codex-state/reference-reader.ts';
import {createNativeActionThreadReads} from './thread-selection-native.ts';
import {createNativeQueueReadState} from '../queue-runner/native-read-state.ts';
import {createNativeNewProjectLookup} from './new-project-native.ts';
import {StopControlWorker,type StopWorkerFailure} from './stop-worker.ts';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import type {InteractionBusinessServices} from '../interaction-worker/processor.ts';
import {createOrdinaryComponentHandler} from '../component-worker/ordinary-handler.ts';
import {NativeStandardClaimOwner} from '../component-worker/standard-claim-native.ts';
import {createNativePromptAuthorityReads, type PromptAuthorityReads} from '../server-prompt-authority-reads.ts';
import {NativeAsyncChoiceOwner} from '../component-worker/async-choice-native.ts';
import {NativeBusyClaimOwner} from '../component-worker/busy-claim-native.ts';
import {BusyQueueExecutor} from './busy-queue.ts';
import {ActionExecutionError} from './action-error.ts';
import {MirrorInspector} from '../mirror-sync/inspection.ts';
import {MirrorSynchronizer} from '../mirror-sync/sync.ts';
import {DiscordNewMirrorTransport} from '../mirror-sync/new-mirror-http.ts';
import {formatMirrorSyncResult} from '../mirror-sync/result.ts';
import {types} from 'node:util';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {QueueStartCoordinator} from '../queue-runner/start-coordinator.ts';
import {AppServerTurnBackend} from '../app-server-turn-backend.ts';
import {PromptIntakeProcessor} from '../prompt-intake/processor.ts';
import {createNativePromptIntakeState} from '../prompt-intake/native-state.ts';
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
 * Missing Windows recovery/archive deletion remain explicit
 * Unsupported results in the basic dispatcher, never a successful no-op.
 * A native server, queue backend and live gateway still require bootstrap and
 * ownership qualification; this constructor does not start any of them. */
export class RuntimeCommandExecutor implements MessageBusinessServices{
 readonly #bridgeOwner:NativeBridgeStateOwner;readonly #busySteer:NativeBusySteerServices;
 #recovery:AdmittedRecoverExecutor|null=null;
 readonly #stopWorkerFactory:(report:(event:StopWorkerFailure)=>void)=>StopControlWorker;
 readonly #intake:PromptIntakeProcessor;readonly #settingsResolver:SettingsTargetResolver;
 readonly #server:PortableResidentLifecycle|null;readonly #componentQueue:BusyQueueExecutor;readonly #control:ControlTurnVerifier;
 readonly #standardClaims:NativeStandardClaimOwner;readonly #busyClaims:NativeBusyClaimOwner;readonly #asyncChoices:NativeAsyncChoiceOwner;readonly #recoveryDecisions:NativeRecoveryDecisionOwner;
 readonly #promptAuthorityReads:PromptAuthorityReads;
 readonly #codex:string;readonly #database:string;#inspection:MirrorInspector|null=null;#mirrorSync:MirrorSynchronizer|null=null;#mirrorConfiguring=false;
 readonly #basic:BasicActionDispatcher;readonly #queue:QueueStartCoordinator;readonly #new:NewThreadExecutor;readonly #prompts:QueuePromptExecutor;readonly #retract:RetractAction;readonly #controls:PromptControlActions;readonly #open:OpenThreadAction;readonly #settings:AdmittedSettingsExecutor;readonly #archive:AdmittedArchiveExecutor|null;readonly #resume:AdmittedResumeExecutor|null;readonly #stop:AdmittedStopExecutor;readonly #repair:AdmittedRepairExecutor|null;
 constructor(input:RuntimeExecutorDependencies){
  const get=<K extends keyof RuntimeExecutorDependencies>(key:K)=>gatewayOwnField(input,key) as RuntimeExecutorDependencies[K];
  const paths=cloneOwnedSerdeValue(get('paths')) as DiagnosticPaths;for(const key of ['state','mirror','bridge'] as const)requireDiscordText(paths[key]);
  const bridge=get('bridge'),server=get('server'),backend=get('backend'),queue=get('queue'),render=get('render'),prepare=get('preparePrompt'),timeout=get('resumeTimeoutMs');
  if(queue.dbPath!==paths.mirror)throw new InvalidActionRequestError('queue and action database differ');
  if(typeof prepare!=='function'||types.isProxy(prepare)||types.isGeneratorFunction(prepare))throw new TypeError('Expected prompt preparation function');
  this.#codex=paths.state;this.#database=paths.mirror;
  this.#standardClaims=new NativeStandardClaimOwner(paths.mirror);this.#busyClaims=new NativeBusyClaimOwner(paths.mirror);this.#asyncChoices=new NativeAsyncChoiceOwner(paths.mirror);this.#recoveryDecisions=new NativeRecoveryDecisionOwner(paths.mirror);
  this.#promptAuthorityReads=createNativePromptAuthorityReads(paths.mirror);
  const intakeState=createNativePromptIntakeState(paths.mirror),threadReads=createNativeActionThreadReads(paths.state,BridgeState.prototype.path.call(bridge));
  const controlReads=createNativeControlReads(paths.mirror,intakeState.mirroredThreadId),stopActionState=Object.freeze({acceptRunningStop:controlStore.acceptRunningStop,acceptUnresolvedStop:controlStore.acceptUnresolvedStop,...controlReads}),stopWorkerState=Object.freeze({pendingStopControlsAfter:controlStore.pendingStopControlsAfter,claimStopControl:controlStore.claimStopControl,recordStopControlError:controlStore.recordStopControlError,...controlReads});
  const bridgeOwner=new NativeBridgeStateOwner(BridgeState.prototype.path.call(bridge));this.#bridgeOwner=bridgeOwner;
  const locks=queue.locks,selection=new ActionThreadSelection(paths.state,paths.mirror,bridge,intakeState.mirroredThreadId,threadReads,bridgeOwner),control=new ControlTurnVerifier(paths.mirror,server,bridge,locks,controlReads,bridgeOwner),busy=new BusyResultProducer(paths.mirror,control,queue.reads,undefined,new NativeBusyCreateWriter(paths.mirror));
  const targets=new ActionTargetServices(paths.mirror,bridge,queue,{preparePrompt:prepare,busyResult:BusyResultProducer.prototype.busyResult.bind(busy)},intakeState,bridgeOwner),intake=new PromptIntakeProcessor(paths.mirror,queue,targets,{state:intakeState});
  const pendingStopReader=new NativeStopPendingReader(paths.mirror),stopDispatchWriter=new NativeStopDispatchWriter(paths.mirror,bridgeOwner);
  this.#stopWorkerFactory=report=>new StopControlWorker(paths.mirror,server,bridge,locks,render,report,stopWorkerState,bridgeOwner,pendingStopReader,server===null?undefined:{queue,server},stopDispatchWriter);
  this.#intake=intake;  this.#server=server;this.#control=control;this.#componentQueue=new BusyQueueExecutor(paths.mirror,Object.freeze({processAdmittedPrompt:PromptIntakeProcessor.prototype.processAdmittedPrompt.bind(intake)}),undefined,intakeState.admitBusyQueue,intakeState.mirroredThreadId);
  this.#queue=queue;this.#basic=new BasicActionDispatcher(paths,bridge,server,locks,render,timeout,intakeState.mirroredThreadId,threadReads,bridgeOwner,controlReads);
  this.#new=new NewThreadExecutor(paths.mirror,paths.state,queue,intake,bridge,server,backend,get('mirror'),get('reportNewAttempt'),undefined,intakeState.admitPromptIntakeWithIngress,intakeState.getNewFirstReplyFinish,intakeState,createNativeNewProjectLookup(paths.state),bridgeOwner);
  this.#prompts=new QueuePromptExecutor(paths.mirror,selection,targets,queue,intake,busy,intakeState);this.#retract=new RetractAction(paths.mirror,selection,undefined,new NativeRetractWriter(paths.mirror));
  const steerOrigin=new NativeSteerOriginWriter(paths.mirror);this.#busySteer=Object.freeze({writer:steerOrigin,selection,bridge:bridgeOwner});
  this.#controls=new PromptControlActions(paths.mirror,selection,targets,control,server,undefined,steerOrigin,bridgeOwner,this.#promptAuthorityReads);this.#open=new OpenThreadAction(selection,targets,bridge,server,timeout,bridgeOwner);
  this.#settingsResolver=new SettingsTargetResolver(paths.state,paths.mirror,bridge,createNativeSettingsBindingReads(paths.state,BridgeState.prototype.path.call(bridge),intakeState.mirroredThreadId),bridgeOwner);
  this.#settings=new AdmittedSettingsExecutor(paths.mirror,new SettingsAction(selection,this.#settingsResolver,bridge,server,control,timeout,bridgeOwner),intakeState);
  this.#stop=new AdmittedStopExecutor(paths.mirror,bridge,new StopActionExecutor(paths.mirror,server,bridge,locks,render,stopActionState,bridgeOwner,new NativeStopAcceptanceWriter(paths.mirror,bridgeOwner)),bridgeOwner,intakeState);
  this.#archive=server===null?null:new AdmittedArchiveExecutor(paths.mirror,paths.state,bridge,server,locks,timeout,intakeState.mirroredThreadId,threadReads,{unfinishedArchiveRequest:intakeState.unfinishedArchiveRequest,listFiltered:createNativeQueueReadState(paths.mirror).listFiltered,listPromptIntakes:intakeState.listPromptIntakes,exact:threadReads.exact},readArchivedScopeOffThread,bridgeOwner,new NativeArchiveWriter(paths.mirror),intakeState);
  this.#resume=server===null?null:new AdmittedResumeExecutor(paths.mirror,paths.state,bridge,server,locks,timeout,intakeState.mirroredThreadId,threadReads,bridgeOwner,intakeState);
  this.#repair=server===null?null:new AdmittedRepairExecutor(paths.mirror,bridge,server,locks,render,undefined,{listFiltered:createNativeQueueReadState(paths.mirror).listFiltered,listPromptIntakes:intakeState.listPromptIntakes},bridgeOwner,intakeState);Object.freeze(this);
 }
 /** Startup-only lease release/recovery; caller owns singleton and has not
  * started the live or periodic intake workers. No new recovery authority. */
 recoverPromptIntakesOnStartup(){return PromptIntakeProcessor.prototype.recoverPromptIntakesOnStartup.call(this.#intake);}
 /** Periodic recovery shares the original processor and never releases foreign
  * intake claims. Own-data port captures this executor's private identity. */
 promptIntakeRecoveryServices(){const intake=this.#intake;return Object.freeze({recoverPromptIntakes:()=>PromptIntakeProcessor.prototype.recoverPromptIntakes.call(intake)});}
 /** Shares the action executor's original resident, binding and queue locks. */
 createStopControlWorker(report:(event:StopWorkerFailure)=>void):StopControlWorker{return this.#stopWorkerFactory(report);}
 configureMirrorInspection(inspector:MirrorInspector):void{if(this.#inspection!==null||this.#mirrorConfiguring)throw new InvalidActionRequestError('mirror inspection is already configured');MirrorInspector.prototype.requireScope.call(inspector,this.#codex,this.#database);this.#inspection=inspector;}
 /** One startup configuration owns both inspection and mutation transports.
  * Reserve configuration before awaiting preparation, so concurrent callers
  * cannot replace a prepared owner or install a second operation lock. */
 async configureMirrorSync(http:DiscordChannelClient,guild:bigint|null,signal:AbortSignal):Promise<void>{
  if(this.#mirrorConfiguring||this.#mirrorSync!==null||this.#inspection!==null)throw new InvalidActionRequestError('mirror sync is already configured');
  this.#mirrorConfiguring=true;
  try{
   const sync=await MirrorSynchronizer.create(this.#codex,this.#database,http,this.#queue.locks,guild,signal);
   signal.throwIfAborted();
   const inspector=new MirrorInspector(this.#codex,this.#database,new DiscordNewMirrorTransport(http),this.#queue.locks,guild);
   this.#mirrorSync=sync;this.#inspection=inspector;
  }finally{this.#mirrorConfiguring=false;}
 }
 /** Startup-only installation of an explicitly owned recovery controller. */
 configureRecovery(executor:AdmittedRecoverExecutor):void{if(this.#recovery!==null)throw new InvalidActionRequestError('recovery controller is already configured');AdmittedRecoverExecutor.prototype.requireDatabase.call(executor,this.#database);AdmittedRecoverExecutor.prototype.configureBridge.call(executor,this.#bridgeOwner);this.#recovery=executor;}
 async #syncMirror(channel:bigint,limit:bigint|null,signal?:AbortSignal):Promise<ActionResult>{
  if(this.#mirrorSync===null)throw new ActionExecutionError('Unsupported','mirror sync transport is not configured');
  try{return snapshotActionResult({text:formatMirrorSyncResult(await this.#mirrorSync.sync(channel,limit,signal)),waitsForFinal:false,ui:null});}
  catch(error){signal?.throwIfAborted();throw new ActionExecutionError('MirrorSync',error);}
 }
 async #inspect(channel:bigint,limit:bigint|null,list:boolean,signal?:AbortSignal):Promise<ActionResult>{if(this.#inspection===null)throw new ActionExecutionError('Unsupported','mirror inspection transport is not configured; remote state was not checked');return snapshotActionResult({text:await MirrorInspector.prototype.inspect.call(this.#inspection,channel,limit,list,signal),waitsForFinal:false,ui:null});}
 targetThreadId(channel:bigint,signal?:AbortSignal):Promise<string>{return this.#basic.targetThreadId(channel,signal);}
 requireRuntimeQueue(queue:QueueStartCoordinator):void{if(this.#queue!==queue)throw new TypeError('Action executor queue differs from runtime binding');}
 requireRuntimeResident(server:PortableResidentLifecycle):void{if(this.#server!==server)throw new TypeError('Action executor resident differs from runtime binding');}
 notifyDeliveryReady():void{invokeSynchronousVoid(QueueStartCoordinator.prototype.notifyDeliveryReady,this.#queue,[]);}
 /** Own-data functions match the processor's strict service capture contract. */
 messageRuntimeBinding(){return Object.freeze({promptAuthorityReads:this.#promptAuthorityReads,services:RuntimeCommandExecutor.prototype.messageServices.call(this),resolver:this.#settingsResolver,controlVerifier:this.#control});}
 messageServices():MessageBusinessServices{return Object.freeze({targetThreadId:RuntimeCommandExecutor.prototype.targetThreadId.bind(this),executeWithIngressContext:RuntimeCommandExecutor.prototype.executeWithIngressContext.bind(this),notifyDeliveryReady:RuntimeCommandExecutor.prototype.notifyDeliveryReady.bind(this)});}
 /** Slash commands and components use this same queue, target locks and native
  * owner. Preparation never sends confirmation before the processor commits its
  * completed-action receipt. This does not start gateway or worker loops. */
 interactionServices(http:DiscordChannelClient):InteractionBusinessServices{
  if(this.#server===null)throw new MissingActionAppServerError();
  return Object.freeze({executeWithIngressContext:RuntimeCommandExecutor.prototype.executeWithIngressContext.bind(this),prepareComponent:createOrdinaryComponentHandler(this.#database,this.#server,http,this.#componentQueue,this.#control,RuntimeCommandExecutor.prototype.notifyDeliveryReady.bind(this),this.#busySteer,true,this.#standardClaims,this.#busyClaims,this.#promptAuthorityReads,this.#asyncChoices,this.#recoveryDecisions)});
 }
 async executeWithIngressContext(input:CommandAction,inputActor:MessageActionContext,key:string,signal?:AbortSignal):Promise<ActionResult>{
  signal?.throwIfAborted();const action=snapshotRuntimeCommand(input),actor=snapshotActionContext(inputActor);requireDiscordText(key);if(actor.discordMessageId===null)throw new InvalidActionRequestError('admitted message/interaction event identity is required');let result:ActionResult;
  if(typeof action==='object'){
   if('BridgeSync'in action)result=await this.#syncMirror(actor.channelId,action.BridgeSync.limit,signal);
   else if('MirrorInspect'in action)result=await this.#inspect(actor.channelId,action.MirrorInspect.limit,action.MirrorInspect.list,signal);
   else if('New'in action)result=await this.#new.execute(actor,action.New.prompt,signal);
   else if('Ask'in action)result=await this.#prompts.queuePrompt(actor.channelId,actor.userId,actor.discordMessageId,actor.autoQueueWhenBusy,action.Ask.prompt,signal,key);
   else if('Interview'in action)result=await this.#prompts.interview(actor.channelId,actor.userId,actor.discordMessageId,actor.autoQueueWhenBusy,action.Interview.prompt,signal,key);
   else if('Settings'in action||'AutoReserve'in action)result=await this.#settings.execute(actor,action,key,signal);
   else if('Archive'in action){if(this.#archive===null)throw new MissingActionAppServerError();result=await this.#archive.execute(actor,action.Archive.reference,key,signal);}
   else if('Resume'in action){if(this.#resume===null)throw new MissingActionAppServerError();result=await this.#resume.execute(actor,action.Resume.reference,key,signal);}
   else if('Stop'in action)result=await this.#stop.execute(actor,action.Stop.reference,key,signal);
   else if('Recover'in action){if(this.#recovery===null)throw new ActionExecutionError('Unsupported','recovery controller is not configured');result=await AdmittedRecoverExecutor.prototype.execute.call(this.#recovery,{key,channelId:actor.channelId,ownerUserId:actor.userId,eventId:actor.discordMessageId,reference:action.Recover.reference},signal);}
   else if('Repair'in action){if(this.#repair===null)throw new MissingActionAppServerError();result=await this.#repair.execute(actor,action.Repair.reference,key,signal);}
   else if('Retract'in action)result={text:await this.#retract.retract(actor.channelId,actor.userId,action.Retract.reference,signal,{key,eventId:actor.discordMessageId}),waitsForFinal:false,ui:null};
   else if('Steer'in action)result=await this.#controls.steer(actor.channelId,action.Steer.prompt,signal,{ingressKey:key,eventId:actor.discordMessageId,ownerUserId:actor.userId});
   else if('Open'in action)result=await this.#open.open(action.Open.reference,action.Open.abort,signal);
   else if('DiscardRequest'in action)throw new InvalidActionRequestError('discard-request requires authenticated message custody and live normal admission');
   else result=await this.#basic.execute(action,actor,signal);
  }else if(action==='MirrorCheck')result=await this.#inspect(actor.channelId,null,false,signal);
  else if(action==='Approval')result=await this.#controls.approval(actor.channelId,actor.userId,signal);
  else result=await this.#basic.execute(action,actor,signal);
  signal?.throwIfAborted();return snapshotActionResult(result);
 }
}
Object.freeze(RuntimeCommandExecutor.prototype);
