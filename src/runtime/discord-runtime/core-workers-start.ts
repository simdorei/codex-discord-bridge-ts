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
 * not start gateway/interaction/remote-MCP/mirror/heartbeat or acquire a singleton. */
export async function startRuntimeCoreWorkers(input:RuntimeCoreStartup,http:DiscordChannelClient,admission:AdmissionGate,shutdown:AbortSignal,notifier:RuntimeWorkerExitChannel,options:RuntimeCompletionOptions){
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
 const stop=new AbortController(),signal=AbortSignal.any([shutdown,stop.signal]),workers:RuntimeMonitoredWorker[]=[],emit=(error:unknown)=>invokeSynchronousVoid(report as Function,options,[error]);
 try{
  workers.push(new RuntimeMonitoredWorker('app-server-supervisor',notifier,async force=>{try{await PortableResidentLifecycle.prototype.runRestartSupervisor.call(owner,AbortSignal.any([signal,force]),(_generation,error)=>emit(error));return {ok:true};}catch(error){return {ok:false,error};}}));
  const completion=await startCompletionRuntimeWorker(captured,http,completionOptions,signal,notifier);workers.push(completion.worker);signal.throwIfAborted();
  workers.push(startNewReplyRuntimeWorker(queue,http,signal,notifier,emit));
  workers.push(startStopControlRuntimeWorker(executor,signal,notifier,emit));
  workers.push(startPromptIntakeRuntimeWorker(executor,admission,signal,notifier,emit));
  workers.push(await startServerRequestRuntimeWorker(captured,database,http,signal,notifier,emit));signal.throwIfAborted();
  const owned=Object.freeze([...workers]);let closing:Promise<readonly RuntimeWorkerJoin[]>|undefined;
  return Object.freeze({workers:owned,requestStop:()=>stop.abort(new Error('Core workers stopping')),close:():Promise<readonly RuntimeWorkerJoin[]>=>{if(closing===undefined){stop.abort(new Error('Core workers stopping'));closing=Promise.all(owned.map(worker=>worker.join())).then(results=>Object.freeze(results));}return closing;}});
 }catch(primary){
  stop.abort(primary);for(const worker of workers)worker.abort();const joined=Object.freeze(await Promise.all(workers.map(worker=>worker.join()))),cleanup:unknown[]=[];
  for(const result of joined){if(result.kind==='Returned'&&!result.result.ok)cleanup.push(result.result.error);else if(result.kind==='TaskFailure'&&!result.cancelled)cleanup.push(result.error);}
  try{invokeSynchronousVoid(dispose as Function,input,[]);}catch(error){cleanup.push(error);}deliveryWake.close();throw new RuntimeCoreWorkerStartError(primary,joined,cleanup);
 }
}
