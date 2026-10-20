import {createNativeMessageClassifier,type NativeMessageClassificationLimits} from '../message-worker/classification.ts';
import {createNativeMirrorPolicyRefresh,type NativeMirrorPolicyLimits} from './native-mirror-policy.ts';
import {createNativeMessageJournal} from '../message-worker/journal.ts';
import {AttachmentHttpClient} from '../attachment-client.ts';
import {types} from 'node:util';
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
export interface RuntimeMessageStartupOptions extends Pick<MessageProcessorContext,'config'|'attachmentRoot'|'attachmentTransport'|'attachmentReport'|'now'>{readonly policyRetryClock?:NonNullable<MessageHandlerOptions['policyRetryClock']>;readonly classification:MessageHandlerOptions['classification'];readonly report:MessageHandlerOptions['report'];}
/** Builds normal/emergency message handling from the same private executor and
 * its original settings resolver/control verifier. Attachment transport remains
 * explicit. Existing per-message fresh mirror policy and durable admission are
 * retained; this shared context capture does not install a classifier. */
export function capturePreparedMessageOptions(input:RuntimeMessageStartup,gate:AdmissionGate,http:DiscordChannelClient,options:RuntimeMessageStartupOptions):MessageHandlerOptions{
 const owner=own(input,'owner') as PortableResidentLifecycle,queue=own(input,'queue') as QueueStartCoordinator,executor=own(input,'executor') as RuntimeCommandExecutor,policy=own(input,'policy') as InteractionAccessPolicy;
 RuntimeCommandExecutor.prototype.requireRuntimeQueue.call(executor,queue);RuntimeCommandExecutor.prototype.requireRuntimeResident.call(executor,owner);QueueStartCoordinator.prototype.requireAdmissionGate.call(queue,gate);PortableResidentLifecycle.prototype.lifecycleSnapshot.call(owner);InteractionAccessPolicy.prototype.withMirroredChannelIds.call(policy,[]);Object.getOwnPropertyDescriptor(DiscordChannelClient.prototype,'activeRequests')!.get!.call(http);
 const database=Object.getOwnPropertyDescriptor(QueueStartCoordinator.prototype,'dbPath')!.get!.call(queue) as string,binding=RuntimeCommandExecutor.prototype.messageRuntimeBinding.call(executor);
 const config=own(options,'config'),transport=own(options,'attachmentTransport') as MessageProcessorContext['attachmentTransport'];
 if(transport===null||typeof transport!=='object'||types.isProxy(transport))throw new TypeError('Expected attachment transport owner');
 let get:unknown;
 if(transport instanceof AttachmentHttpClient){Object.getOwnPropertyDescriptor(AttachmentHttpClient.prototype,'activeRequests')!.get!.call(transport);get=AttachmentHttpClient.prototype.get;}else get=own(transport,'get');
 if(typeof get!=='function'||types.isProxy(get)||types.isGeneratorFunction(get))throw new TypeError('Expected owned attachment transport');
 const classification=own(options,'classification'),rawMentions=own(classification,'plainAskMentionUserIds');if(rawMentions===null||typeof rawMentions!=='object'||types.isProxy(rawMentions))throw new TypeError('Expected native mention set');const mentions=new Set<bigint>();Set.prototype.forEach.call(rawMentions,(id:bigint)=>mentions.add(id));
 const context={messageJournal:createNativeMessageJournal(database,5000,true),nativePromptReceipts:true,promptAuthorityReads:binding.promptAuthorityReads,database,server:owner,http,config:Object.freeze({attachmentsEnabled:own(config,'attachmentsEnabled') as boolean,attachmentMaxBytes:own(config,'attachmentMaxBytes') as bigint,attachmentTextInlineMaxBytes:own(config,'attachmentTextInlineMaxBytes') as bigint}),attachmentRoot:own(options,'attachmentRoot') as string,attachmentTransport:Object.freeze({get:(url:string,signal?:AbortSignal)=>Reflect.apply(get,transport,[url,signal]) as ReturnType<MessageProcessorContext['attachmentTransport']['get']>}),attachmentReport:own(options,'attachmentReport') as MessageProcessorContext['attachmentReport'],controlVerifier:binding.controlVerifier,services:binding.services,...(Object.hasOwn(options,'now')?{now:own(options,'now') as ()=>number}:{})};
 return Object.freeze({...(Object.hasOwn(options,'policyRetryClock')?{policyRetryClock:own(options,'policyRetryClock') as NonNullable<MessageHandlerOptions['policyRetryClock']>}:{}),context:Object.freeze(context),gate,policy,resolver:binding.resolver,classification:Object.freeze({enableMessageContent:own(classification,'enableMessageContent') as boolean,plainAskMentionUserIds:mentions}),report:own(options,'report') as MessageHandlerOptions['report']});
}

export interface PreparedMessageStartupOptions extends RuntimeMessageStartupOptions{readonly messagePolicyLimits:NativeMirrorPolicyLimits;readonly messageClassificationLimits:NativeMessageClassificationLimits;}
export function createPreparedMessageHandler(input:RuntimeMessageStartup,gate:AdmissionGate,http:DiscordChannelClient,options:PreparedMessageStartupOptions){const captured=capturePreparedMessageOptions(input,gate,http,options);return createGatewayMessageHandler({...captured,classifyMessage:createNativeMessageClassifier(captured.context.database,own(options,'messageClassificationLimits') as NativeMessageClassificationLimits),refreshPolicy:createNativeMirrorPolicyRefresh(captured.context.database,own(options,'messagePolicyLimits') as NativeMirrorPolicyLimits)});}
