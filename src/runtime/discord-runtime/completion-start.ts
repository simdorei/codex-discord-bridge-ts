import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {AppServerTurnBackend} from '../app-server-turn-backend.ts';
import {QueueStartCoordinator} from '../queue-runner/start-coordinator.ts';
import {CompletionPipeline} from '../completion/pipeline.ts';
import {RuntimeMonitoredWorker,RuntimeWorkerExitChannel} from './monitored-worker.ts';
export interface RuntimeCompletionStartup{readonly owner:PortableResidentLifecycle;readonly queue:QueueStartCoordinator;readonly backend:AppServerTurnBackend;readonly completionReceiver:ReturnType<PortableResidentLifecycle['subscribeNotifications']>;}
export interface RuntimeCompletionOptions{readonly commentaryEnabled:boolean;readonly historyReadTimeoutMs:number;readonly render:(error:unknown)=>string;readonly report:(error:unknown)=>void;}
const httpRequests=Object.getOwnPropertyDescriptor(DiscordChannelClient.prototype,'activeRequests')!.get!,send=DiscordChannelClient.prototype.sendValidated,typing=DiscordChannelClient.prototype.createTyping;
const usedReceivers=new WeakSet<object>();
/** Binds exact startup receiver, resident, queue backend and shared HTTP owner.
 * All identity/precondition checks precede subscription transfer. Callback entry
 * is announced before exposing its task handle, including pre-aborted startup.
 * Completion owns its whole pipeline until joined; caller retains native/HTTP
 * lifetime and must connect returned wake callback to delivery notifications. */
export async function startCompletionRuntimeWorker(startup:RuntimeCompletionStartup,http:DiscordChannelClient,input:RuntimeCompletionOptions,shutdown:AbortSignal,notifier:RuntimeWorkerExitChannel){
 if(types.isProxy(shutdown)||!(shutdown instanceof AbortSignal))throw new TypeError('Expected completion shutdown signal');
 const owner=own(startup,'owner') as PortableResidentLifecycle,queue=own(startup,'queue') as QueueStartCoordinator,backend=own(startup,'backend') as AppServerTurnBackend,receiver=own(startup,'completionReceiver') as RuntimeCompletionStartup['completionReceiver'];
 const commentaryEnabled=own(input,'commentaryEnabled'),historyReadTimeoutMs=own(input,'historyReadTimeoutMs'),render=own(input,'render'),report=own(input,'report');
 if(typeof commentaryEnabled!=='boolean'||typeof historyReadTimeoutMs!=='number'||!Number.isSafeInteger(historyReadTimeoutMs)||historyReadTimeoutMs<0||historyReadTimeoutMs>2147483647)throw new TypeError('Invalid completion runtime options');
 for(const fn of [render,report])if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected synchronous completion diagnostic');
 PortableResidentLifecycle.prototype.lifecycleSnapshot.call(owner);QueueStartCoordinator.prototype.requireBackend.call(queue,backend);
 if(AppServerTurnBackend.prototype.residentInstanceId.call(backend)!==owner.instanceId||AppServerTurnBackend.prototype.generation.call(backend)!==PortableResidentLifecycle.prototype.generation.call(owner))throw new TypeError('Completion backend resident differs');
 if(!PortableResidentLifecycle.prototype.observationTrackingEnabled.call(owner))throw new TypeError('Install runtime observation journal before completion');Reflect.apply(httpRequests,http,[]);
 const dispose=own(receiver,'dispose');if(typeof dispose!=='function'||types.isProxy(dispose)||types.isAsyncFunction(dispose)||types.isGeneratorFunction(dispose))throw new TypeError('Expected startup completion receiver');if(usedReceivers.has(receiver))throw new TypeError('Completion startup receiver already consumed');
 const transport=Object.freeze({sendValidated:(request:Parameters<typeof send>[0])=>Reflect.apply(send,http,[request]) as Promise<bigint>}),typed=Object.freeze({createTyping:(channel:bigint,signal:AbortSignal)=>Reflect.apply(typing,http,[channel,signal]) as Promise<void>});
 const pipeline=new CompletionPipeline(owner,queue,{commentaryEnabled,historyReadTimeoutMs,render:render as RuntimeCompletionOptions['render'],report:report as RuntimeCompletionOptions['report'],typing:typed,delivery:{transport,failures:{render:render as RuntimeCompletionOptions['render']},now:()=>Date.now()/1000}});
 let announce!:()=>void;const entered=new Promise<void>(resolve=>announce=resolve);
 const worker=new RuntimeMonitoredWorker('completion',notifier,async force=>{announce();try{await pipeline.run(AbortSignal.any([shutdown,force]),receiver);return {ok:true};}catch(error){if(force.aborted&&error===force.reason)throw error;return {ok:false,error};}finally{invokeSynchronousVoid(dispose,receiver,[]);}});
 usedReceivers.add(receiver);await entered;return Object.freeze({worker,notifyDeliveryReady:()=>CompletionPipeline.prototype.notifyDeliveryReady.call(pipeline)});
}
