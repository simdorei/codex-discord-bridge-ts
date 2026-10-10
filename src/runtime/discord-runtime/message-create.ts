import {types} from 'node:util';
import {AdmissionGate,AdmissionPermit} from '../../admission/drain-gate.ts';
import {drainGateErrorInfo} from '../../admission/owned-key.ts';
import {InteractionAccessPolicy} from '../../discord/interaction-access.ts';
import type {DecodedGatewayMessage} from '../../discord/gateway/decoded-message.ts';
import type {RuntimeConfig} from '../../config/runtime.ts';
import {classifyGatewayMessage,MessageCandidate} from '../message-worker/classification.ts';
import {AdmittedMessage,admitMessageCandidateAt} from '../message-worker/admission.ts';
import type {MessageCustodyOptions} from '../message-worker/custody.ts';
import {messageErrorReportTarget,processMessageWithErrorReport,type MessageErrorReportTarget} from '../message-worker/processing-boundary.ts';
import {MessageWorkerError} from '../message-worker/errors.ts';
import {SettingsTargetResolver} from '../settings-binding.ts';
import {refreshMirrorPolicy} from './mirror-policy.ts';
type Kind='Ignore'|'Duplicate'|'Unavailable'|'Admitted';
const token=Symbol('PreparedGatewayMessage');
/** Owns the gate permit from preparation through processing AND error reporting.
 * The transfer and fallback disposal are single-use and joined. */
export class PreparedGatewayMessage {
 readonly kind:Kind;readonly ignored:Readonly<{reason:string;channelId:bigint;userId:bigint}>|null;
 readonly #target:MessageErrorReportTarget;readonly #admitted:AdmittedMessage|null;readonly #permit:AdmissionPermit|null;
 #consumed=false;#pending:Promise<void>|null=null;#disposal:Promise<void>|null=null;
 constructor(secret:symbol,kind:Kind,target:MessageErrorReportTarget,admitted:AdmittedMessage|null,permit:AdmissionPermit|null,ignored:PreparedGatewayMessage['ignored']=null){
  if(secret!==token)throw new TypeError('Expected prepared gateway message');this.kind=kind;this.#target=target;this.#admitted=admitted;this.#permit=permit;this.ignored=ignored;Object.freeze(this);
 }
 #cleanup():Promise<void>{return this.#disposal??=(async()=>{try{if(this.#admitted!==null)await AdmittedMessage.prototype.dispose.call(this.#admitted);}finally{if(this.#permit!==null)AdmissionPermit.prototype.release.call(this.#permit);}})();}
 dispatch(process:(admitted:AdmittedMessage)=>Promise<void>,report:(target:MessageErrorReportTarget,error:unknown)=>Promise<void>):Promise<void>{
  if(this.#consumed)throw new TypeError('Prepared gateway message already consumed');
  for(const fn of [process,report])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected native message handler');
  this.#consumed=true;
  this.#pending=Promise.resolve().then(async()=>{try{
   if(this.kind==='Ignore'||this.kind==='Duplicate')return;
   if(this.kind==='Unavailable'){const result=report(this.#target,new MessageWorkerError('Restarting'));if(!types.isPromise(result))throw new TypeError('Expected native report Promise');await result;return;}
   const admitted=this.#admitted!;AdmittedMessage.prototype.retainAdmission.call(admitted,this.#permit);
   await processMessageWithErrorReport(this.#target,admitted,process,report);
  }finally{await this.#cleanup();}});return this.#pending;
 }
 dispose():Promise<void>{if(this.#pending!==null)return this.#pending.then(()=>undefined,()=>undefined);this.#consumed=true;return this.#cleanup();}
}
Object.freeze(PreparedGatewayMessage.prototype);
export interface MessageCreateOptions {
 readonly database:string;readonly config:Pick<RuntimeConfig,'enableMessageContent'|'plainAskMentionUserIds'>;
 readonly basePolicy:InteractionAccessPolicy;readonly gate:AdmissionGate;readonly allowDrainControl:boolean;
 readonly resolver:SettingsTargetResolver|null;readonly observedAt:number;readonly custody:MessageCustodyOptions;
}
/** Mandatory fresh mirror policy precedes classification/settings binding,
 * gate entry and durable deduplication. Caller determines allowDrainControl by
 * probing the actual current pending native request; this function does not guess.
 * The outer normal/emergency consumer and cancellation wiring remain separate. */
export async function prepareGatewayMessage(message:DecodedGatewayMessage,botUserId:bigint|null,options:MessageCreateOptions):Promise<PreparedGatewayMessage>{
 const target=messageErrorReportTarget(message),{database,config,basePolicy,gate,allowDrainControl,resolver,observedAt,custody}=options;
 if(typeof allowDrainControl!=='boolean')throw new TypeError('Expected drain control availability');
 const result=await classifyGatewayMessage(message,database,config,await refreshMirrorPolicy(basePolicy,database),botUserId);
 const simple=(kind:Kind,ignored:PreparedGatewayMessage['ignored']=null)=>new PreparedGatewayMessage(token,kind,target,null,null,ignored);
 if(result.kind==='Ignore')return simple('Ignore',Object.freeze({reason:result.reason,channelId:result.channelId,userId:result.userId}));
 const candidate=result.candidate;if(resolver!==null)await MessageCandidate.prototype.bindSettings.call(candidate,resolver);
 const pendingOnly=allowDrainControl&&MessageCandidate.prototype.isPendingReplyCandidate.call(candidate),stop=MessageCandidate.prototype.isStopControl.call(candidate),force=MessageCandidate.prototype.isForceRestart.call(candidate);
 if(allowDrainControl&&!pendingOnly&&!stop&&!force)return simple('Unavailable');
 let permit:AdmissionPermit|null=null,admitted:AdmittedMessage|null=null,transferred=false;
 try{
  if(!force){try{permit=pendingOnly||stop?AdmissionGate.prototype.tryEnterControlObserved.call(gate)[0]:AdmissionGate.prototype.tryEnter.call(gate);}catch(error){if(drainGateErrorInfo(error)?.kind==='Sealed')return simple('Unavailable');throw error;}}
  admitted=await admitMessageCandidateAt(candidate,observedAt,custody);if(admitted===null)return simple('Duplicate');
  if(pendingOnly)await AdmittedMessage.prototype.requirePendingReply.call(admitted);
  const prepared=new PreparedGatewayMessage(token,'Admitted',target,admitted,permit);transferred=true;return prepared;
 }finally{if(!transferred){try{if(admitted!==null)await AdmittedMessage.prototype.dispose.call(admitted);}finally{if(permit!==null)AdmissionPermit.prototype.release.call(permit);}}}
}
