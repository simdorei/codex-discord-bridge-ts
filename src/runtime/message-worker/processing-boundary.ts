import {types} from 'node:util';
import {isDecodedGatewayMessage,type DecodedGatewayMessage} from '../../discord/gateway/decoded-message.ts';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {isMessageDatabaseMismatch} from './admission.ts';
import {messageWorkerErrorInfo} from './errors.ts';
import {sendMessageReplyOnce} from './reply-delivery.ts';
export interface MessageErrorReportTarget {readonly channelId:bigint;readonly messageId:bigint}
const targets=new WeakSet<object>();
export function messageErrorReportTarget(message:DecodedGatewayMessage):MessageErrorReportTarget {
 if(!isDecodedGatewayMessage(message))throw new TypeError('Expected decoded message');const target=Object.freeze({channelId:message.channel_id,messageId:message.id});targets.add(target);return target;
}
function requireTarget(target:MessageErrorReportTarget){if(target===null||typeof target!=='object'||!targets.has(target))throw new TypeError('Expected original message report target');}
function fn(value:unknown){if(typeof value!=='function'||types.isProxy(value)||types.isGeneratorFunction(value))throw new TypeError('Expected native asynchronous operation');}
/** Wrong-database failures are fatal and never use the context DB to report.
 * Other failures reach the one caller-supplied reporting boundary exactly once. */
export async function processMessageWithErrorReport<T>(target:MessageErrorReportTarget,work:T,process:(work:T)=>Promise<void>,report:(target:MessageErrorReportTarget,error:unknown)=>Promise<void>):Promise<void>{
 requireTarget(target);fn(process);fn(report);
 try{const result=process(work);if(!types.isPromise(result))throw new TypeError('Expected native processing Promise');await result;}
 catch(error){const info=messageWorkerErrorInfo(error);if(isMessageDatabaseMismatch(error)||info?.kind==='Admission'&&isMessageDatabaseMismatch(info.source))throw info?.kind==='Admission'?info.source:error;
  const reported=report(target,error);if(!types.isPromise(reported))throw new TypeError('Expected native report Promise');await reported;
 }
}
export type MessageErrorReporter=(code:'on_message_error'|'on_message_error_report_failed',detail:string)=>void;
/** A known, saved refusal with failed notification must not emit another-key
 * ERROR. Ordinary error notices use their original message/error/v1 receipt. */
export async function reportMessageProcessingError(database:string,http:DiscordChannelClient,target:MessageErrorReportTarget,error:unknown,report:MessageErrorReporter,signal?:AbortSignal):Promise<void>{
 signal?.throwIfAborted();
 requireTarget(target);if(typeof report!=='function'||types.isProxy(report)||types.isAsyncFunction(report)||types.isGeneratorFunction(report))throw new TypeError('Expected synchronous message reporter');
 const info=messageWorkerErrorInfo(error),detail=info?.text??passiveErrorText(error,'message processing failed');invokeSynchronousVoid(report,{},['on_message_error',detail]);
 if(info?.kind==='KnownOutcomeNotification')return;
 if(isMessageDatabaseMismatch(error)||info?.kind==='Admission'&&isMessageDatabaseMismatch(info.source))throw info?.kind==='Admission'?info.source:error;
 try{await sendMessageReplyOnce(database,http,target.channelId,target.messageId,'ErrorReport','ERROR: '+detail,[],signal);}
 catch(failure){if(signal?.aborted&&failure===signal.reason)throw failure;invokeSynchronousVoid(report,{},['on_message_error_report_failed',passiveErrorText(failure,'message error report failed')]);}
}
