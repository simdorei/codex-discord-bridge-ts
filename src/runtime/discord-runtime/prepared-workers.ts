import {claimPreparedRuntimeRemote,startPreparedRuntimeRemote,requestPreparedRuntimeRemoteStop,closePreparedRuntimeRemote,assertPreparedRuntimeRemoteReleased,type RuntimeRemoteBranch,type PreparedRuntimeRemote} from './remote-start.ts';
import {AttachmentHttpClient} from '../attachment-client.ts';
import {RuntimeCommandExecutor} from '../action-executor/command-executor.ts';
import {startTypedIngressWorkers} from './typed-ingress-start.ts';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {GatewayRuntime} from '../../discord/gateway/runtime.ts';
import type {DecodedGatewayInteraction} from '../../discord/gateway/decoded-interaction.ts';
import type {DiscordChannelClient} from '../../discord/channel-client.ts';
import type {AdmissionGate} from '../../admission/drain-gate.ts';
import type {AutocompleteCatalog} from '../discord-dispatch/autocomplete.ts';
import {createInteractionWorkQueue} from '../discord-dispatch/interaction-work.ts';
import {RuntimeMonitoredWorker,RuntimeWorkerExitChannel,type RuntimeWorkerJoin} from './monitored-worker.ts';
import {capturePreparedTypedIngressOptions,type PreparedTypedIngressOptions} from './prepared-typed-ingress.ts';
import {startPreparedInteractionWorker} from './interaction-bootstrap.ts';
import {capturePreparedMessageOptions,type RuntimeMessageStartup} from './message-bootstrap.ts';
import {RuntimeDeliveryWake} from './delivery-wake.ts';
import {QueueStartCoordinator} from '../queue-runner/start-coordinator.ts';
import {startRuntimeCoreWorkers,type RuntimeCoreStartup,type RuntimeCoreInterleaving} from './core-workers-start.ts';
import type {RuntimeCompletionOptions} from './completion-start.ts';
import {captureRuntimeHeartbeatInput} from './heartbeat-start.ts';
import {captureRuntimeMirrorInput} from './session-mirror-start.ts';
const claimedResidents=new WeakSet<object>();
const bindings=new WeakMap<object,Readonly<{gateway:GatewayRuntime<DecodedGatewayInteraction>;resident:RuntimeCoreStartup['owner'];gate:AdmissionGate;database:string;attachment:AttachmentHttpClient|null;remote:PreparedRuntimeRemote|null}>>();
export function preparedRuntimeWorkerBinding(owner:unknown){if(owner===null||typeof owner!=='object'||!bindings.has(owner))throw new TypeError('Expected actual prepared runtime worker owner');return bindings.get(owner)!;}
export type PreparedRuntimeWorkerOwner=Awaited<ReturnType<typeof startPreparedRuntimeWorkers>>;
export interface PreparedRuntimeWorkerOptions{
 readonly remote:RuntimeRemoteBranch;
 readonly ingress:PreparedTypedIngressOptions;
 readonly completion:RuntimeCompletionOptions;
 readonly interleaving:RuntimeCoreInterleaving;
 readonly reportInteraction:Parameters<typeof startPreparedInteractionWorker>[4];
}
export class PreparedRuntimeWorkerStartError extends AggregateError{
 readonly joined:readonly RuntimeWorkerJoin[];
 constructor(primary:unknown,joined:readonly RuntimeWorkerJoin[],cleanup:readonly unknown[]){super([primary,...cleanup],'Prepared worker startup failed after owned cleanup');this.name='PreparedRuntimeWorkerStartError';this.joined=joined;}
}
/** Source local-worker assembly under an already-owned singleton and prepared
 * resident. Remote is explicitly disabled or an authentic prepared synthetic
 * owner; no remote preparation is silently skipped. Owns the interaction queue, exit channel and exact tasks;
 * gateway/resident/HTTP/drain/instance ownership remains with the application.
 * A native AttachmentHttpClient is bound for final outer cleanup after all workers
 * join; custom transport cleanup remains with its caller.
 * Each prepared resident can be claimed once, including a failed startup; retry
 * requires a fresh prepared context after the caller finishes old ownership.
 * A failed start closes the gateway after joining accepted work, but never closes
 * a resident still borrowed by that work. Normal close joins non-heartbeat tasks;
 * the separate heartbeat must survive through final drain acknowledgement. */
export async function startPreparedRuntimeWorkers(input:RuntimeCoreStartup&RuntimeMessageStartup,gateway:GatewayRuntime<DecodedGatewayInteraction>,gate:AdmissionGate,http:DiscordChannelClient,catalog:AutocompleteCatalog,shutdown:AbortSignal,options:PreparedRuntimeWorkerOptions){
 if(types.isProxy(shutdown)||!(shutdown instanceof AbortSignal))throw new TypeError('Expected runtime shutdown signal');shutdown.throwIfAborted();
 const remoteInput=own(options,'remote') as RuntimeRemoteBranch;
 GatewayRuntime.prototype.assertTypedStartupAvailable.call(gateway);
 const report=own(options,'reportInteraction') as PreparedRuntimeWorkerOptions['reportInteraction'];if(typeof report!=='function'||types.isProxy(report)||types.isAsyncFunction(report)||types.isGeneratorFunction(report))throw new TypeError('Expected synchronous interaction report');
 const context=Object.freeze({owner:own(input,'owner'),queue:own(input,'queue'),executor:own(input,'executor'),policy:own(input,'policy'),backend:own(input,'backend'),deliveryWake:own(input,'deliveryWake'),completionReceiver:own(input,'completionReceiver'),serverRequestReceiver:own(input,'serverRequestReceiver'),disposeReceivers:own(input,'disposeReceivers')}) as RuntimeCoreStartup&RuntimeMessageStartup;
 const c=own(options,'completion'),completion=Object.freeze({commentaryEnabled:own(c,'commentaryEnabled'),historyReadTimeoutMs:own(c,'historyReadTimeoutMs'),render:own(c,'render'),report:own(c,'report')}) as RuntimeCompletionOptions;
 if(typeof completion.commentaryEnabled!=='boolean'||typeof completion.historyReadTimeoutMs!=='number'||!Number.isSafeInteger(completion.historyReadTimeoutMs)||completion.historyReadTimeoutMs<0||completion.historyReadTimeoutMs>2147483647)throw new TypeError('Invalid completion runtime options');
 for(const fn of [completion.render,completion.report])if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected synchronous completion diagnostic');
 const i=own(options,'interleaving'),h=own(i,'heartbeat'),m=own(i,'mirror'),heartbeat=captureRuntimeHeartbeatInput(own(h,'port') as RuntimeCoreInterleaving['heartbeat']['port'],own(h,'options') as RuntimeCoreInterleaving['heartbeat']['options']);
 const mirror=m===null?null:captureRuntimeMirrorInput(own(m,'config') as NonNullable<RuntimeCoreInterleaving['mirror']>['config'],own(m,'transport') as NonNullable<RuntimeCoreInterleaving['mirror']>['transport'],own(m,'render') as NonNullable<RuntimeCoreInterleaving['mirror']>['render'],own(m,'report') as NonNullable<RuntimeCoreInterleaving['mirror']>['report'],context.queue);
 const interleaving=Object.freeze({heartbeat,mirror}),ingress=own(options,'ingress') as PreparedTypedIngressOptions;
 const attachmentInput=own(ingress,'attachmentTransport');
 if(attachmentInput===null||typeof attachmentInput!=='object'||types.isProxy(attachmentInput))throw new TypeError('Expected owned attachment transport');
 const attachment=attachmentInput instanceof AttachmentHttpClient?attachmentInput:null;
 if(attachment!==null)Object.getOwnPropertyDescriptor(AttachmentHttpClient.prototype,'activeRequests')!.get!.call(attachment);
 capturePreparedMessageOptions(context,gate,http,ingress);RuntimeDeliveryWake.prototype.assertAvailable.call(context.deliveryWake);
 if(claimedResidents.has(context.owner))throw new TypeError('Prepared resident worker assembly already owned');
 const remote=claimPreparedRuntimeRemote(remoteInput,input,gate);claimedResidents.add(context.owner);
 const database=Object.getOwnPropertyDescriptor(QueueStartCoordinator.prototype,'dbPath')!.get!.call(context.queue) as string;
 const stop=new AbortController(),signal=AbortSignal.any([shutdown,stop.signal]),notifier=new RuntimeWorkerExitChannel(),exits=notifier.receiver(),work=createInteractionWorkQueue();
 let remoteWorker:RuntimeMonitoredWorker|undefined;
 let typed:RuntimeMonitoredWorker[]=[],business:Awaited<ReturnType<typeof startPreparedInteractionWorker>>|undefined,core:Awaited<ReturnType<typeof startRuntimeCoreWorkers>>|undefined;
 const requestStop=()=>{GatewayRuntime.prototype.beginStopping.call(gateway);if(remote!==null)requestPreparedRuntimeRemoteStop(remote);stop.abort();core?.requestStop();work.sender.dispose();};
 try{
  const typedOptions=capturePreparedTypedIngressOptions(context,gate,http,work,catalog,ingress);
  await RuntimeCommandExecutor.prototype.configureMirrorSync.call(context.executor,http,typedOptions.ready.guildId,signal);signal.throwIfAborted();
  typed=await startTypedIngressWorkers(gateway,signal,notifier,typedOptions);signal.throwIfAborted();
  business=await startPreparedInteractionWorker(context,work,http,notifier,report);signal.throwIfAborted();
  if(remote!==null){remoteWorker=await startPreparedRuntimeRemote(remote,notifier);signal.throwIfAborted();}
  core=await startRuntimeCoreWorkers(context,http,gate,signal,notifier,completion,interleaving);signal.throwIfAborted();
  const heartbeatOwner=core.heartbeat!;const workers=Object.freeze([...typed,business.worker,...(remoteWorker===undefined?[]:[remoteWorker]),...core.workers]),startupOrder=Object.freeze([...typed,business.worker,...(remoteWorker===undefined?[]:[remoteWorker]),...core.startupOrder]);notifier.close();let closing:Promise<readonly RuntimeWorkerJoin[]>|undefined;
  const result=Object.freeze({workers,heartbeat:heartbeatOwner,startupOrder,exits,requestStop,close:()=>{if(closing===undefined){requestStop();closing=Promise.all(workers.map(w=>w.join())).then(results=>Object.freeze(results));}return closing;},disposeMonitor:()=>{if([...workers,heartbeatOwner.worker].some(w=>w.peek()===undefined))throw new TypeError('Join all runtime workers and heartbeat before disposing monitor');exits.dispose();work.sender.dispose();work.receiver.dispose();}});
  bindings.set(result,Object.freeze({gateway,resident:context.owner,gate,database,attachment,remote}));return result;
 }catch(primary){
  const cleanup:unknown[]=[];try{GatewayRuntime.prototype.beginStopping.call(gateway);}catch(error){cleanup.push(error);}try{requestStop();}catch(error){cleanup.push(error);}
  core?.heartbeat?.requestStop();const accepted=[...typed,...(business===undefined?[]:[business.worker]),...(remoteWorker===undefined?[]:[remoteWorker]),...(core===undefined?[]:core.startupOrder)];for(const worker of accepted)worker.abort();
  const joined=Object.freeze(await Promise.all(accepted.map(w=>w.join())));for(const result of joined){if(result.kind==='Returned'&&!result.result.ok)cleanup.push(result.result.error);else if(result.kind==='TaskFailure'&&!result.cancelled)cleanup.push(result.error);}
  if(remote!==null){try{if(remoteWorker===undefined)await closePreparedRuntimeRemote(remote);assertPreparedRuntimeRemoteReleased(remote);}catch(error){cleanup.push(error);}}
  try{await GatewayRuntime.prototype.shutdown.call(gateway);}catch(error){cleanup.push(error);}
  notifier.close();exits.dispose();try{work.sender.dispose();work.receiver.dispose();}catch(error){cleanup.push(error);}throw new PreparedRuntimeWorkerStartError(primary,joined,cleanup);
 }
}
