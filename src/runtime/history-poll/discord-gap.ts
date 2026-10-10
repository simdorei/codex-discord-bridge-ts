import {types} from 'node:util';
import {AdmissionGate,AdmissionPermit} from '../../admission/drain-gate.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {isDecodedGatewayMessage,type DecodedGatewayMessage} from '../../discord/gateway/decoded-message.ts';
import {isForceRestartMessage} from '../../discord/gateway/routing.ts';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {InteractionAccessPolicy} from '../../discord/interaction-access.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {SettingsTargetResolver} from '../settings-binding.ts';
import {classifyGatewayMessage,MessageCandidate} from '../message-worker/classification.ts';
import {AdmittedMessage,admitMessageCandidateAt} from '../message-worker/admission.ts';
import {createMessageProcessor,type MessageProcessorContext} from '../message-worker/processor.ts';
import {messageErrorReportTarget,processMessageWithErrorReport,reportMessageProcessingError,type MessageErrorReportTarget} from '../message-worker/processing-boundary.ts';
import type {MessageHandlerOptions} from '../discord-runtime/message-handler.ts';
import {refreshMirrorPolicy} from '../discord-runtime/mirror-policy.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {historyMessageWatermark,type HistoryBatchItem,type HistoryWatermark} from './state.ts';
import {runHistoryGapRecovery,type HistoryPollIo,type HistoryGapOutcome} from './runner.ts';
export interface DiscordHistoryGapOptions extends MessageHandlerOptions {readonly applicationId:bigint;readonly botUserId:bigint|null}
interface Claimed {readonly admitted:AdmittedMessage;readonly target:MessageErrorReportTarget}
/** One real HTTP -> oldest-first classification -> durable admission -> message
 * processor cycle. Caller owns sticky-gap acknowledgement and policy for incomplete
 * coverage. This gap-only adapter never performs priming/discard claims: the
 * synchronous source discard fence has not been extended across SQLite awaits. */
export async function recoverDiscordHistoryChannel(options:DiscordHistoryGapOptions,channel:bigint,floor:HistoryWatermark,signal?:AbortSignal):Promise<HistoryGapOutcome>{
 signal?.throwIfAborted();if(typeof channel!=='bigint'||channel<=0n||channel>=1n<<64n)throw new TypeError('Expected history channel');
 const raw=own(options,'context'),context={} as Record<string,unknown>;
 for(const key of ['database','server','http','config','attachmentRoot','attachmentTransport','attachmentReport','controlVerifier','services'])context[key]=own(raw,key);
 const clock=Object.getOwnPropertyDescriptor(raw as object,'now');if(clock!==undefined&&!Object.hasOwn(clock,'value'))throw new TypeError('Expected clock data');context.now=clock?.value??systemNow;context.applicationId=own(options,'applicationId');
 const processor=createMessageProcessor(context as unknown as MessageProcessorContext),database=context.database as string,http=context.http as DiscordChannelClient,now=context.now as ()=>number;
 const gate=own(options,'gate') as AdmissionGate,basePolicy=own(options,'policy') as InteractionAccessPolicy,resolver=own(options,'resolver') as SettingsTargetResolver,bot=own(options,'botUserId') as bigint|null,report=own(options,'report') as MessageHandlerOptions['report'];
 if(typeof report!=='function'||types.isProxy(report)||types.isAsyncFunction(report)||types.isGeneratorFunction(report))throw new TypeError('Expected synchronous history reporter');
 if(resolver===null||types.isProxy(resolver)||!(resolver instanceof SettingsTargetResolver))throw new TypeError('Expected settings resolver');
 const rawConfig=own(options,'classification'),ids=own(rawConfig,'plainAskMentionUserIds');if(types.isProxy(ids))throw new TypeError('Expected mention set');const mentions=new Set<bigint>();Set.prototype.forEach.call(ids,(id:bigint)=>mentions.add(id));const config={enableMessageContent:own(rawConfig,'enableMessageContent') as boolean,plainAskMentionUserIds:mentions};
 const emit=(code:string,detail:string)=>invokeSynchronousVoid(report,{},[code,detail]);
 const permit=AdmissionGate.prototype.tryEnter.call(gate),pending=new Set<AdmittedMessage>();
 try{
  const policy=await refreshMirrorPolicy(basePolicy,database);signal?.throwIfAborted();const observedAt=readCustodyTimestamp(now);
  const io:HistoryPollIo<DecodedGatewayMessage,DecodedGatewayMessage,Claimed>=Object.freeze({
   fetch:async(id:bigint,limit:number,ownedSignal?:AbortSignal)=>{if(id!==channel||limit!==10)throw new TypeError('Expected fixed history page');return DiscordChannelClient.prototype.fetchLatestChannelMessages.call(http,id,ownedSignal);},
   adapt:(message:DecodedGatewayMessage):HistoryBatchItem<DecodedGatewayMessage>=>{if(!isDecodedGatewayMessage(message)||message.channel_id!==channel)throw new TypeError('History response channel mismatch');return {watermark:historyMessageWatermark(message.timestamp.unixNanoseconds/1000n,message.id),item:(message.author as {bot:boolean}).bot?{kind:'Ignore'}:{kind:'Candidate',value:message}};},
   claim:async(message:DecodedGatewayMessage,purpose:'Discard'|'Process',ownedSignal?:AbortSignal)=>{
    ownedSignal?.throwIfAborted();if(purpose!=='Process')throw new TypeError('Gap-only adapter cannot discard historical messages');
    if(isForceRestartMessage(message.content))return {kind:'Lost'} as const;
    const classified=await classifyGatewayMessage(message,database,config,policy,bot);ownedSignal?.throwIfAborted();if(classified.kind==='Ignore')return {kind:'Lost'} as const;
    await MessageCandidate.prototype.bindSettings.call(classified.candidate,resolver);ownedSignal?.throwIfAborted();
    const admitted=await admitMessageCandidateAt(classified.candidate,observedAt,{now,report:value=>emit(value.code,passiveErrorText(value.error,'history custody hold failed'))});
    if(admitted===null)return {kind:'Lost'} as const;pending.add(admitted);AdmittedMessage.prototype.retainAdmission.call(admitted,permit);
    return {kind:'Won',admitted:{admitted,target:messageErrorReportTarget(message)}} as const;
   },
   process:async(work:Claimed,ownedSignal?:AbortSignal)=>{
    if(!pending.has(work.admitted))throw new TypeError('History admission is not owned');
    try{ownedSignal?.throwIfAborted();await processMessageWithErrorReport(work.target,work.admitted,a=>processor(a,ownedSignal),(target,error)=>{ownedSignal?.throwIfAborted();return reportMessageProcessingError(database,http,target,error,emit,ownedSignal);});}
    finally{await AdmittedMessage.prototype.dispose.call(work.admitted);pending.delete(work.admitted);}
   },
  });
  return await runHistoryGapRecovery(channel,floor,io,signal);
 }finally{try{for(const admitted of pending)await AdmittedMessage.prototype.dispose.call(admitted);}finally{AdmissionPermit.prototype.release.call(permit);}}
}
