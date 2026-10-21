import {requireApprovalPolicy,type ApprovalPolicy,requireLocalToolApprovalPolicy,type LocalToolApprovalPolicy} from '../../config/runtime.ts';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {AdmissionGate} from '../../admission/drain-gate.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {AppServerTurnBackend} from '../app-server-turn-backend.ts';
import {RuntimeCommandExecutor} from '../action-executor/command-executor.ts';
import {QueueStartCoordinator} from '../queue-runner/start-coordinator.ts';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {RuntimeDeliveryWake} from './delivery-wake.ts';
import {RuntimeMonitoredWorker,RuntimeWorkerExitChannel,type RuntimeWorkerJoin} from './monitored-worker.ts';
import {startCompletionRuntimeWorker,type RuntimeCompletionStartup,type RuntimeCompletionOptions} from './completion-start.ts';
import {startNewReplyRuntimeWorker} from './new-reply-start.ts';
import {startStopControlRuntimeWorker} from './stop-control-start.ts';
import {startPromptIntakeRuntimeWorker} from './prompt-intake-start.ts';
import {startServerRequestRuntimeWorker,type RuntimeServerRequestStartup} from './server-request-start.ts';
import {captureRuntimeHeartbeatInput,startRuntimeHeartbeatWorker} from './heartbeat-start.ts';
import type {RuntimeHeartbeatPort,RuntimeHeartbeatOptions} from '../runtime-heartbeat.ts';
import type {RuntimeHeartbeatOwner} from './finalize-shutdown.ts';
import {captureRuntimeMirrorInput,startSessionMirrorRuntimeWorker,type RuntimeMirrorObservation} from './session-mirror-start.ts';
import type {BoundMirrorWorkerConfig} from '../session-mirror/bound-poll.ts';
import type {DiscordReceiptTransport} from '../completion/receipt-sender.ts';
export interface RuntimeCoreInterleaving{
 readonly heartbeat:{readonly port:RuntimeHeartbeatPort;readonly options:RuntimeHeartbeatOptions};
 readonly mirror:null|{readonly config:BoundMirrorWorkerConfig;readonly transport:DiscordReceiptTransport;readonly render:(error:unknown)=>string;readonly report:(event:RuntimeMirrorObservation)=>void};
}
export interface RuntimeCoreStartup extends RuntimeCompletionStartup,RuntimeServerRequestStartup{
 readonly executor:RuntimeCommandExecutor;readonly deliveryWake:RuntimeDeliveryWake;readonly disposeReceivers:()=>void;
}
export class RuntimeCoreWorkerStartError extends AggregateError{
 readonly joined:readonly RuntimeWorkerJoin[];
 constructor(primary:unknown,joined:readonly RuntimeWorkerJoin[],cleanup:readonly unknown[]){super([primary,...cleanup],'Core worker startup failed after joining accepted work');this.name='RuntimeCoreWorkerStartError';this.joined=joined;}
}
/** Source-ordered core workers borrowing the prepared resident/executor/queue,
 * original subscriptions and shared HTTP. Startup failure stops and joins every
 * accepted worker before disposing leftover receivers. Success exposes exact
 * task handles for the existing common-deadline shutdown controller. This does
 * not start gateway/interaction/remote-MCP or acquire a singleton. Optional
 * interleaving starts heartbeat after supervisor and mirror before server-request.
 * Heartbeat is returned separately and remains alive after normal core close;
 * caller must finalize it after resident cleanup and drain acknowledgement. */
export async function startRuntimeCoreWorkers(input:RuntimeCoreStartup,http:DiscordChannelClient,admission:AdmissionGate,shutdown:AbortSignal,notifier:RuntimeWorkerExitChannel,options:RuntimeCompletionOptions,interleaving?:RuntimeCoreInterleaving,localToolApprovalPolicy:LocalToolApprovalPolicy='ask',approvalPolicy:ApprovalPolicy='ask'){
 requireLocalToolApprovalPolicy(localToolApprovalPolicy);
 requireApprovalPolicy(approvalPolicy);
 if(types.isProxy(shutdown)||!(shutdown instanceof AbortSignal))throw new TypeError('Expected core shutdown signal');shutdown.throwIfAborted();
 const owner=own(input,'owner') as PortableResidentLifecycle,queue=own(input,'queue') as QueueStartCoordinator,executor=own(input,'executor') as RuntimeCommandExecutor,deliveryWake=own(input,'deliveryWake') as RuntimeDeliveryWake,dispose=own(input,'disposeReceivers');
 const report=own(options,'report'),render=own(options,'render'),commentaryEnabled=own(options,'commentaryEnabled'),historyReadTimeoutMs=own(options,'historyReadTimeoutMs');
 if(typeof commentaryEnabled!=='boolean'||typeof historyReadTimeoutMs!=='number'||!Number.isSafeInteger(historyReadTimeoutMs)||historyReadTimeoutMs<0||historyReadTimeoutMs>2147483647)throw new TypeError('Invalid core completion options');
 const completionOptions={commentaryEnabled,historyReadTimeoutMs,render:render as RuntimeCompletionOptions['render'],report:report as RuntimeCompletionOptions['report']};
 for(const fn of [report,render,dispose])if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected synchronous core callback');
 RuntimeCommandExecutor.prototype.requireRuntimeQueue.call(executor,queue);QueueStartCoordinator.prototype.requireAdmissionGate.call(queue,admission);RuntimeDeliveryWake.prototype.assertAvailable.call(deliveryWake);PortableResidentLifecycle.prototype.lifecycleSnapshot.call(owner);
 const captured=Object.freeze({owner,queue,executor,deliveryWake,backend:own(input,'backend') as RuntimeCoreStartup['backend'],completionReceiver:own(input,'completionReceiver') as RuntimeCoreStartup['completionReceiver'],serverRequestReceiver:own(input,'serverRequestReceiver') as RuntimeCoreStartup['serverRequestReceiver']}),database=Object.getOwnPropertyDescriptor(QueueStartCoordinator.prototype,'dbPath')!.get!.call(queue) as string;
 Object.getOwnPropertyDescriptor(DiscordChannelClient.prototype,'activeRequests')!.get!.call(http);QueueStartCoordinator.prototype.requireBackend.call(queue,captured.backend);
 if(AppServerTurnBackend.prototype.residentInstanceId.call(captured.backend)!==owner.instanceId||AppServerTurnBackend.prototype.generation.call(captured.backend)!==PortableResidentLifecycle.prototype.generation.call(owner))throw new TypeError('Core backend resident differs');
 if(!PortableResidentLifecycle.prototype.observationTrackingEnabled.call(owner))throw new TypeError('Install runtime observation journal before core workers');
 let heartbeatInput:ReturnType<typeof captureRuntimeHeartbeatInput>|null=null,mirrorInput:ReturnType<typeof captureRuntimeMirrorInput>|null=null;
 if(interleaving!==undefined){
  const h=own(interleaving,'heartbeat'),m=own(interleaving,'mirror');
  heartbeatInput=captureRuntimeHeartbeatInput(own(h,'port') as RuntimeHeartbeatPort,own(h,'options') as RuntimeHeartbeatOptions);
  if(m!==null)mirrorInput=captureRuntimeMirrorInput(own(m,'config') as BoundMirrorWorkerConfig,own(m,'transport') as DiscordReceiptTransport,own(m,'render') as (error:unknown)=>string,own(m,'report') as (event:RuntimeMirrorObservation)=>void,queue);
 }
 let heartbeat:RuntimeHeartbeatOwner|null=null;const started:RuntimeMonitoredWorker[]=[];
 const stop=new AbortController(),signal=AbortSignal.any([shutdown,stop.signal]),workers:RuntimeMonitoredWorker[]=[],emit=(error:unknown)=>invokeSynchronousVoid(report as Function,options,[error]);
 const accept=(worker:RuntimeMonitoredWorker)=>{workers.push(worker);started.push(worker);};
 try{
  accept(new RuntimeMonitoredWorker('app-server-supervisor',notifier,async force=>{try{await PortableResidentLifecycle.prototype.runRestartSupervisor.call(owner,AbortSignal.any([signal,force]),(_generation,error)=>emit(error));return {ok:true};}catch(error){return {ok:false,error};}}));
  if(heartbeatInput!==null){heartbeat=startRuntimeHeartbeatWorker(heartbeatInput.port,notifier,heartbeatInput.options);started.push(heartbeat.worker);}
  const completion=await startCompletionRuntimeWorker(captured,http,completionOptions,signal,notifier);accept(completion.worker);signal.throwIfAborted();
  accept(startNewReplyRuntimeWorker(queue,http,signal,notifier,emit));
  accept(startStopControlRuntimeWorker(executor,signal,notifier,emit));
  accept(startPromptIntakeRuntimeWorker(executor,admission,signal,notifier,emit));
  if(mirrorInput!==null){const mirror=startSessionMirrorRuntimeWorker(true,mirrorInput.config,mirrorInput.transport,signal,notifier,mirrorInput.render,mirrorInput.report,queue)!;accept(mirror);}
  accept(await startServerRequestRuntimeWorker(captured,database,http,signal,notifier,emit,localToolApprovalPolicy,approvalPolicy));signal.throwIfAborted();
  const owned=Object.freeze([...workers]);let closing:Promise<readonly RuntimeWorkerJoin[]>|undefined;
  return Object.freeze({workers:owned,heartbeat,startupOrder:Object.freeze([...started]),requestStop:()=>stop.abort(new Error('Core workers stopping')),close:():Promise<readonly RuntimeWorkerJoin[]>=>{if(closing===undefined){stop.abort(new Error('Core workers stopping'));closing=Promise.all(owned.map(worker=>worker.join())).then(results=>Object.freeze(results));}return closing;}});
 }catch(primary){
  stop.abort(primary);heartbeat?.requestStop();for(const worker of started)worker.abort();const joined=Object.freeze(await Promise.all(started.map(worker=>worker.join()))),cleanup:unknown[]=[];
  for(const result of joined){if(result.kind==='Returned'&&!result.result.ok)cleanup.push(result.result.error);else if(result.kind==='TaskFailure'&&!result.cancelled)cleanup.push(result.error);}
  try{invokeSynchronousVoid(dispose as Function,input,[]);}catch(error){cleanup.push(error);}deliveryWake.close();throw new RuntimeCoreWorkerStartError(primary,joined,cleanup);
 }
}
