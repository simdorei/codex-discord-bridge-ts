import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {AdmissionGate} from '../../admission/drain-gate.ts';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {InteractionAccessPolicy} from '../../discord/interaction-access.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {QueueStartCoordinator} from '../queue-runner/start-coordinator.ts';
import {RuntimeCommandExecutor} from '../action-executor/command-executor.ts';
import type {MessageProcessorContext} from '../message-worker/processor.ts';
import {createGatewayMessageHandler,type MessageHandlerOptions} from './message-handler.ts';
import type {RuntimeInteractionStartup} from './interaction-bootstrap.ts';
export interface RuntimeMessageStartup extends RuntimeInteractionStartup{readonly policy:InteractionAccessPolicy;}
export interface RuntimeMessageStartupOptions extends Pick<MessageProcessorContext,'config'|'attachmentRoot'|'attachmentTransport'|'attachmentReport'|'now'>{readonly classification:MessageHandlerOptions['classification'];readonly report:MessageHandlerOptions['report'];}
/** Builds normal/emergency message handling from the same private executor and
 * its original settings resolver/control verifier. Attachment transport remains
 * explicit. Existing per-message fresh mirror policy and durable admission are
 * retained; this does not claim their synchronous store reads are offloaded. */
export function createPreparedMessageHandler(input:RuntimeMessageStartup,gate:AdmissionGate,http:DiscordChannelClient,options:RuntimeMessageStartupOptions){
 const owner=own(input,'owner') as PortableResidentLifecycle,queue=own(input,'queue') as QueueStartCoordinator,executor=own(input,'executor') as RuntimeCommandExecutor,policy=own(input,'policy') as InteractionAccessPolicy;
 RuntimeCommandExecutor.prototype.requireRuntimeQueue.call(executor,queue);RuntimeCommandExecutor.prototype.requireRuntimeResident.call(executor,owner);QueueStartCoordinator.prototype.requireAdmissionGate.call(queue,gate);PortableResidentLifecycle.prototype.lifecycleSnapshot.call(owner);InteractionAccessPolicy.prototype.withMirroredChannelIds.call(policy,[]);Object.getOwnPropertyDescriptor(DiscordChannelClient.prototype,'activeRequests')!.get!.call(http);
 const database=Object.getOwnPropertyDescriptor(QueueStartCoordinator.prototype,'dbPath')!.get!.call(queue) as string,binding=RuntimeCommandExecutor.prototype.messageRuntimeBinding.call(executor);
 const context={database,server:owner,http,config:own(options,'config') as MessageProcessorContext['config'],attachmentRoot:own(options,'attachmentRoot') as string,attachmentTransport:own(options,'attachmentTransport') as MessageProcessorContext['attachmentTransport'],attachmentReport:own(options,'attachmentReport') as MessageProcessorContext['attachmentReport'],controlVerifier:binding.controlVerifier,services:binding.services,...(Object.hasOwn(options,'now')?{now:own(options,'now') as ()=>number}:{})};
 return createGatewayMessageHandler({context,gate,policy,resolver:binding.resolver,classification:own(options,'classification') as MessageHandlerOptions['classification'],report:own(options,'report') as MessageHandlerOptions['report']});
}
