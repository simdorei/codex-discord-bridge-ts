import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {QueueStartCoordinator} from '../queue-runner/start-coordinator.ts';
import {RuntimeCommandExecutor} from '../action-executor/command-executor.ts';
import {createInteractionProcessor} from '../interaction-worker/processor.ts';
import type {InteractionWorkerReportCode} from '../interaction-worker/worker.ts';
import type {InteractionWorkQueue} from '../discord-dispatch/interaction-work.ts';
import {RuntimeWorkerExitChannel} from './monitored-worker.ts';
import {startInteractionRuntimeWorker} from './interaction-start.ts';
export interface RuntimeInteractionStartup {readonly owner:PortableResidentLifecycle;readonly queue:QueueStartCoordinator;readonly executor:RuntimeCommandExecutor;}
/** Uses the prepared runtime's exact private executor, resident and queue. Slash
 * and component services are concrete existing implementations; response delivery
 * remains after durable action recording. Full ingress and all command coverage
 * remain separate qualifications. No new backend, locks or native child created. */
export async function startPreparedInteractionWorker(input:RuntimeInteractionStartup,work:InteractionWorkQueue,http:DiscordChannelClient,notifier:RuntimeWorkerExitChannel,report:(code:InteractionWorkerReportCode,detail:string)=>void){
 const owner=own(input,'owner') as PortableResidentLifecycle,queue=own(input,'queue') as QueueStartCoordinator,executor=own(input,'executor') as RuntimeCommandExecutor;
 if(typeof report!=='function'||types.isProxy(report)||types.isAsyncFunction(report)||types.isGeneratorFunction(report))throw new TypeError('Expected synchronous interaction report');
 RuntimeCommandExecutor.prototype.requireRuntimeQueue.call(executor,queue);RuntimeCommandExecutor.prototype.requireRuntimeResident.call(executor,owner);PortableResidentLifecycle.prototype.lifecycleSnapshot.call(owner);Object.getOwnPropertyDescriptor(DiscordChannelClient.prototype,'activeRequests')!.get!.call(http);
 const database=Object.getOwnPropertyDescriptor(QueueStartCoordinator.prototype,'dbPath')!.get!.call(queue) as string,services=RuntimeCommandExecutor.prototype.interactionServices.call(executor,http),process=createInteractionProcessor(database,owner,http,services);
 return startInteractionRuntimeWorker(work,database,http,{process,notifyDeliveryReady:()=>RuntimeCommandExecutor.prototype.notifyDeliveryReady.call(executor),report:(...args)=>invokeSynchronousVoid(report,{},args)},notifier);
}
