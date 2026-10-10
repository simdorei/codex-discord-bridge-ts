import {types} from 'node:util';
import {AdmissionGate} from '../../admission/drain-gate.ts';
import {gatewayId,gatewayOwnField} from '../../discord/gateway/values.ts';
import {isDecodedGatewayMessage} from '../../discord/gateway/decoded-message.ts';
import {isEmergencyMessage} from '../../discord/gateway/routing.ts';
import {InteractionAccessPolicy} from '../../discord/interaction-access.ts';
import type {RuntimeConfig} from '../../config/runtime.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {SettingsTargetResolver} from '../settings-binding.ts';
import {pendingTextReplyAvailable} from '../component-worker/text-reply.ts';
import {createMessageProcessor,type MessageProcessorContext} from '../message-worker/processor.ts';
import {reportMessageProcessingError} from '../message-worker/processing-boundary.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {prepareGatewayMessage} from './message-create.ts';
import type {GatewayMessageHandler} from './message-consumer.ts';
export type MessageRuntimeReport=(code:string,detail:string)=>void;
export interface MessageHandlerOptions {
 readonly context:Omit<MessageProcessorContext,'applicationId'>;readonly gate:AdmissionGate;
 readonly classification:Pick<RuntimeConfig,'enableMessageContent'|'plainAskMentionUserIds'>;
 readonly policy:InteractionAccessPolicy;readonly resolver:SettingsTargetResolver;readonly report:MessageRuntimeReport;
}
/** Actual shared normal/emergency message handler. Native request availability
 * is probed during drain; authorization/dedup remain mandatory for force commands.
 * The consumer owns identity-conflict/shutdown signals. All active processing and
 * reporting is joined before handler return; business ports must honor signals. */
export function createGatewayMessageHandler(options:MessageHandlerOptions):GatewayMessageHandler {
 const original=gatewayOwnField(options,'context') as MessageHandlerOptions['context'];
 const capture=<K extends keyof MessageHandlerOptions['context']>(key:K)=>gatewayOwnField(original,key) as MessageHandlerOptions['context'][K];
 const sourceServices=capture('services');const bound=(key:keyof typeof sourceServices)=>{const fn=gatewayOwnField(sourceServices,key);if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned business service');return (...args:unknown[])=>Reflect.apply(fn,sourceServices,args);};
 const sourceConfig=capture('config'),clock=Object.getOwnPropertyDescriptor(original,'now');if(clock!==undefined&&!Object.hasOwn(clock,'value'))throw new TypeError('Expected clock data');
 const context=Object.freeze({database:capture('database'),server:capture('server'),http:capture('http'),config:Object.freeze({attachmentsEnabled:gatewayOwnField(sourceConfig,'attachmentsEnabled') as boolean,attachmentMaxBytes:gatewayOwnField(sourceConfig,'attachmentMaxBytes') as bigint,attachmentTextInlineMaxBytes:gatewayOwnField(sourceConfig,'attachmentTextInlineMaxBytes') as bigint}),attachmentRoot:capture('attachmentRoot'),attachmentTransport:capture('attachmentTransport'),attachmentReport:capture('attachmentReport'),controlVerifier:capture('controlVerifier'),services:Object.freeze({targetThreadId:bound('targetThreadId'),executeWithIngressContext:bound('executeWithIngressContext'),notifyDeliveryReady:bound('notifyDeliveryReady')}) as MessageHandlerOptions['context']['services'],now:clock?.value??systemNow});
 const gate=gatewayOwnField(options,'gate') as AdmissionGate,policy=gatewayOwnField(options,'policy') as InteractionAccessPolicy,resolver=gatewayOwnField(options,'resolver') as SettingsTargetResolver,report=gatewayOwnField(options,'report') as MessageRuntimeReport;
 if(resolver===null||types.isProxy(resolver)||!(resolver instanceof SettingsTargetResolver))throw new TypeError('Expected original settings resolver');
 if(typeof report!=='function'||types.isProxy(report)||types.isAsyncFunction(report)||types.isGeneratorFunction(report))throw new TypeError('Expected synchronous runtime reporter');
 const emit=(code:string,detail:string)=>invokeSynchronousVoid(report,{},[code,detail]);
 const sourceClassification=gatewayOwnField(options,'classification'),raw=gatewayOwnField(sourceClassification,'plainAskMentionUserIds');if(types.isProxy(raw))throw new TypeError('Expected native mention set');const mentions=new Set<bigint>();Set.prototype.forEach.call(raw,(id:bigint)=>mentions.add(id));
 const classification=Object.freeze({enableMessageContent:gatewayOwnField(sourceClassification,'enableMessageContent') as boolean,plainAskMentionUserIds:mentions});
 const services=context.services,target=gatewayOwnField(services,'targetThreadId');if(typeof target!=='function'||types.isProxy(target)||types.isGeneratorFunction(target))throw new TypeError('Expected target service');
 const now=context.now??systemNow;
 return async(message,identity,signal)=>{
  signal.throwIfAborted();if(!isDecodedGatewayMessage(message))throw new TypeError('Expected decoded message');
  const bot=gatewayId(gatewayOwnField(identity,'userId')),application=gatewayId(gatewayOwnField(identity,'applicationId'));
  let allowDrainControl=false;
  if(!isEmergencyMessage(message.content)&&AdmissionGate.prototype.isSealed.call(gate)){
   let phase='restart_drain_text_control_target_failed';
   try{const pending=Reflect.apply(target,services,[message.channel_id,signal]);if(!types.isPromise(pending))throw new TypeError('Expected native target Promise');const thread=await pending;signal.throwIfAborted();phase='restart_drain_text_control_probe_failed';allowDrainControl=pendingTextReplyAvailable(thread as string,context.server);}
   catch(error){if(signal.aborted&&error===signal.reason)throw error;emit(phase,passiveErrorText(error,'pending text probe failed'));}
  }
  signal.throwIfAborted();const process=createMessageProcessor({...context,applicationId:application});
  const prepared=await prepareGatewayMessage(message,bot,{database:context.database,config:classification,basePolicy:policy,gate,allowDrainControl,resolver,observedAt:readCustodyTimestamp(now),custody:{now,report:value=>emit(value.code,passiveErrorText(value.error,'custody hold failed'))}},signal);
  try{
   if(prepared.ignored!==null)emit('ignored_message',`${prepared.ignored.reason} chat=${prepared.ignored.channelId} user=${prepared.ignored.userId}`);
   await prepared.dispatch(admitted=>process(admitted,signal),(target,error)=>{
    signal.throwIfAborted();return reportMessageProcessingError(context.database,context.http,target,error,emit,signal);
   });
  }finally{await prepared.dispose();}
 };
}
