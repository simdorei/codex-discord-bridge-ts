import {types} from 'node:util';
import {AdmissionPermit} from '../../admission/drain-gate.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {isProCommand} from '../../pro/prompt.ts';
import {ControlTurnVerifier} from '../action-executor/control-turn.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
import type {CommandAction} from '../command-plan.ts';
import {renderActionUi} from '../action-ui.ts';
import {deliverServerPrompts} from '../server-prompt-delivery.ts';
import {handlePendingTextReply} from '../component-worker/text-reply.ts';
import {enrichMessageAttachments,type AttachmentConfig,type AttachmentReporter} from '../attachments.ts';
import type {AttachmentTransport} from '../attachment-download.ts';
import {recordCleanupNotificationFailure} from '../cleanup-notification-failure.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {AdmittedMessage} from './admission.ts';
import {MessageCustody} from './custody.ts';
import {MessageWorkerError} from './errors.ts';
import {deliverMessageReplyText,sendMessageReplyOnce} from './reply-delivery.ts';
import {deliverMessageCleanupRefusal} from './cleanup-refusal.ts';
import {proposeMessageAbandonment} from './recovery-abandonment.ts';
export interface MessageActionContext {readonly channelId:bigint;readonly userId:bigint;readonly discordMessageId:bigint;readonly autoQueueWhenBusy:boolean}
/** Required, source-backed business ports. This processor does not manufacture
 * command execution, target selection or delivery wake implementations. */
export interface MessageBusinessServices {
 targetThreadId(channel:bigint,signal?:AbortSignal):Promise<string>;
 executeWithIngressContext(action:CommandAction,actor:MessageActionContext,key:string,signal?:AbortSignal):Promise<ActionResult>;
 notifyDeliveryReady():void;
}
export interface MessageProcessorContext {
 readonly database:string;readonly applicationId:bigint;readonly server:PortableResidentLifecycle;readonly http:DiscordChannelClient;
 readonly config:AttachmentConfig;readonly attachmentRoot:string;readonly attachmentTransport:AttachmentTransport;
 readonly attachmentReport:AttachmentReporter;readonly controlVerifier:ControlTurnVerifier;readonly services:MessageBusinessServices;readonly now?:()=>number;
}
function method(input:object,key:string,synchronous=false):Function {
 const f=gatewayOwnField(input,key);if(typeof f!=='function'||types.isProxy(f)||types.isGeneratorFunction(f)||(synchronous&&types.isAsyncFunction(f)))throw new TypeError('Expected owned message service');return f;
}
async function runMessageOperation<T>(kind:ConstructorParameters<typeof MessageWorkerError>[0],run:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
 signal?.throwIfAborted();
 try{const result=run();if(!types.isPromise(result))throw new TypeError('Expected native message operation Promise');return await result;}catch(error){if(signal?.aborted&&error===signal.reason)throw error;throw new MessageWorkerError(kind,error);}
}
/** Exact message processing order and joined custody, with explicit unimplemented
 * business ports. Call through the central error-report boundary. No auto retry. */
export function createMessageProcessor(context:MessageProcessorContext):(admitted:AdmittedMessage,signal?:AbortSignal)=>Promise<void>{
 const database=gatewayOwnField(context,'database'),applicationId=gatewayOwnField(context,'applicationId'),root=gatewayOwnField(context,'attachmentRoot');requireDiscordText(database);requireDiscordText(root);
 if(typeof applicationId!=='bigint'||applicationId<=0n||applicationId>=1n<<64n)throw new TypeError('Expected application ID');
 const services=gatewayOwnField(context,'services') as MessageBusinessServices,execute=method(services,'executeWithIngressContext'),target=method(services,'targetThreadId'),notify=method(services,'notifyDeliveryReady',true);
 const server=gatewayOwnField(context,'server') as PortableResidentLifecycle,http=gatewayOwnField(context,'http') as DiscordChannelClient,rawConfig=gatewayOwnField(context,'config') as AttachmentConfig,transport=gatewayOwnField(context,'attachmentTransport') as AttachmentTransport,report=gatewayOwnField(context,'attachmentReport') as AttachmentReporter,verifier=gatewayOwnField(context,'controlVerifier') as ControlTurnVerifier;
 const config=Object.freeze({attachmentsEnabled:gatewayOwnField(rawConfig,'attachmentsEnabled') as boolean,attachmentMaxBytes:gatewayOwnField(rawConfig,'attachmentMaxBytes') as bigint,attachmentTextInlineMaxBytes:gatewayOwnField(rawConfig,'attachmentTextInlineMaxBytes') as bigint});
 const descriptor=Object.getOwnPropertyDescriptor(context,'now');if(descriptor!==undefined&&!Object.hasOwn(descriptor,'value'))throw new TypeError('Expected clock data');const now=descriptor?.value??systemNow;
 if(typeof now!=='function'||types.isProxy(now)||types.isAsyncFunction(now)||types.isGeneratorFunction(now))throw new TypeError('Expected synchronous clock');
 return async (admitted,signal)=>{
  const operation=<T>(kind:ConstructorParameters<typeof MessageWorkerError>[0],run:()=>Promise<T>)=>runMessageOperation(kind,run,signal);
  const selected=async(channel:bigint)=>{const result=await operation<string>('Action',()=>Reflect.apply(target,services,[channel,signal]));requireDiscordText(result);return result;};
  let parts;
  try{signal?.throwIfAborted();parts=AdmittedMessage.prototype.intoProcessingParts.call(admitted,database);}catch(error){try{await AdmittedMessage.prototype.dispose.call(admitted);}finally{throw error;}}
  const {message,channelId,userId,custody,admissionPermit}=parts,key=`message:${message.id}`;
  const record=(outcome:unknown)=>operation('Store',()=>state.recordIngressResult(database,key,outcome,readCustodyTimestamp(now)));
  const text=(kind:Parameters<typeof deliverMessageReplyText>[4],content:string)=>operation('Delivery',()=>deliverMessageReplyText(database,http,message.channel_id,message.id,kind,content,signal));
  try {
   if(!parts.frozenPlan.ok)throw new MessageWorkerError('Plan',parts.frozenPlan.error);
   let plan=parts.frozenPlan.value;if('Ignore'in plan)throw new TypeError('Ignored message cannot execute');
   const action='Execute'in plan?plan.Execute:null;
   const initialTarget=action!==null&&typeof action==='object'&&('Ask'in action||'Interview'in action)?await selected(channelId):null;
   await operation('Store',()=>MessageCustody.prototype.begin.call(custody,initialTarget));
   let handled=false;
   if(action!==null&&typeof action==='object'&&'Ask'in action&&!isProCommand(action.Ask.prompt)){
    const thread=await selected(channelId),confirmation=await operation('Component',()=>handlePendingTextReply(thread,action.Ask.prompt,server,database,channelId,userId,signal));
    if(confirmation!==null){await record({pending_reply:'handled',confirmation});await text('PendingConfirmation',confirmation);handled=true;}
   }
   if(handled){await operation('Store',()=>MessageCustody.prototype.finish.call(custody));return;}
   if(parts.processingMode==='PendingReplyOnly')throw new MessageWorkerError('Restarting');
   if(action!==null&&typeof action==='object'&&'DiscardRequest'in action){
    await proposeMessageAbandonment(message,action.DiscardRequest.job_id,admissionPermit,database,applicationId,http,verifier,now,signal);await operation('Store',()=>MessageCustody.prototype.finish.call(custody));return;
   }
   if(action!==null&&typeof action==='object'&&'New'in action&&(message.attachments as readonly unknown[]).length>0){
    const prepared=await operation('Attachment',()=>enrichMessageAttachments(message,action.New.prompt,config,root,transport,true,report,signal));
    await operation('Store',()=>state.recordNewInput(database,key,action.New.prompt,prepared,readCustodyTimestamp(now)));
   }else if(action!==null&&typeof action==='object'&&'Ask'in action){
    const prompt=await operation('Attachment',()=>enrichMessageAttachments(message,action.Ask.prompt,config,root,transport,false,report,signal));plan=Object.freeze({Execute:Object.freeze({Ask:Object.freeze({prompt})})});
   }
   let knownRefusal=false;
   if('Respond'in plan){await record({response:plan.Respond});await text('PlannedResponse',plan.Respond);}
   else if('Execute'in plan){
    let result:ActionResult|null=null;
    try{const pending=Reflect.apply(execute,services,[plan.Execute,Object.freeze({channelId,userId,discordMessageId:message.id,autoQueueWhenBusy:(message.author as {bot:boolean}).bot}),key,signal]);if(!types.isPromise(pending))throw new TypeError('Expected native action Promise');result=snapshotActionResult(await pending as ActionResult);}
    catch(error){if(signal?.aborted&&error===signal.reason)throw error;knownRefusal=await deliverMessageCleanupRefusal(message,database,http,error,now,signal);}
    if(result!==null){
     await record({response:result.text,waits_for_final:result.waitsForFinal});
     if(result.ui?.kind==='ServerPrompts'){const prompts=result.ui.prompts;await operation('PromptDelivery',()=>deliverServerPrompts({database,server,http,channelId,userId,commandKey:key,...(signal===undefined?{}:{signal})},prompts));}
     else {
      let components;try{components=renderActionUi(result.ui);}catch(error){throw new MessageWorkerError('Ui',error);}
      if(components.length===0)await text(typeof plan.Execute==='object'&&'SavedRequest'in plan.Execute?'SavedRequest':'ActionResult',result.text);
      else await operation('RecordedDelivery',()=>sendMessageReplyOnce(database,http,message.channel_id,message.id,'ActionResult',result.text,components,signal));
     }
    }
   }
   signal?.throwIfAborted();try{await MessageCustody.prototype.finish.call(custody);}catch(error){if(knownRefusal)throw new MessageWorkerError('KnownOutcomeNotification',await recordCleanupNotificationFailure(database,key,'confirmation',error,now));throw new MessageWorkerError('Store',error);}
   signal?.throwIfAborted();invokeSynchronousVoid(notify,services,[]);
  }finally{try{await MessageCustody.prototype.dispose.call(custody);}finally{if(admissionPermit!==null)AdmissionPermit.prototype.release.call(admissionPermit);}}
 };
}
