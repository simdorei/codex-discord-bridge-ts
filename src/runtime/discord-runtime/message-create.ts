import {types} from 'node:util';
import {AdmissionGate,AdmissionPermit} from '../../admission/drain-gate.ts';
import {drainGateErrorInfo} from '../../admission/owned-key.ts';
import {InteractionAccessPolicy} from '../../discord/interaction-access.ts';
import type {DecodedGatewayMessage} from '../../discord/gateway/decoded-message.ts';
import type {RuntimeConfig} from '../../config/runtime.ts';
import {captureMessageClassifier,takeMessageClassificationCapacityRefusal,MessageCandidate,type MessageClassifier,type MessageClassification} from '../message-worker/classification.ts';
import {AdmittedMessage,admitMessageCandidateAt} from '../message-worker/admission.ts';
import {captureMessageCustodyOptions,type MessageCustodyOptions} from '../message-worker/custody.ts';
import {messageErrorReportTarget,processMessageWithErrorReport,type MessageErrorReportTarget} from '../message-worker/processing-boundary.ts';
import {MessageWorkerError} from '../message-worker/errors.ts';
import {SettingsTargetResolver} from '../settings-binding.ts';
import {refreshMirrorPolicy} from './mirror-policy.ts';
import {takeMirrorPolicyCapacityRefusal} from './native-mirror-policy.ts';
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
export type MessagePolicyRefresh=(policy:InteractionAccessPolicy,database:string,signal?:AbortSignal)=>Promise<InteractionAccessPolicy>;
/** A captured own-data port; direct callers retain the compatibility refresh. */
export function captureMessagePolicyRefresh(options:unknown):MessagePolicyRefresh{
 if(options===null||typeof options!=='object'||types.isProxy(options))throw new TypeError('Expected message options');
 const field=Object.getOwnPropertyDescriptor(options,'refreshPolicy');if(field!==undefined&&!Object.hasOwn(field,'value'))throw new TypeError('Expected message policy callback data');
 const refresh=field?.value===undefined?refreshMirrorPolicy:field.value;
 if(typeof refresh!=='function'||types.isProxy(refresh)||types.isGeneratorFunction(refresh))throw new TypeError('Expected message policy refresh function');return refresh as MessagePolicyRefresh;
}
const capacityOrigins=new WeakMap<object,object>(),capacityRefusals=new WeakMap<Promise<PreparedGatewayMessage>,unknown>();
const classificationOrigins=new WeakMap<object,object>(),classificationRefusals=new WeakMap<Promise<PreparedGatewayMessage>,unknown>();
class GatewayMessageClassificationCapacityError extends Error{constructor(source:unknown,origin:object){super('Gateway message classification capacity is occupied; no read submitted',{cause:source});this.name='GatewayMessageClassificationCapacityError';classificationOrigins.set(this,origin);}}
export function takeGatewayMessageClassificationCapacityRefusal(pending:Promise<PreparedGatewayMessage>|undefined,error:unknown):boolean{
 if(pending===undefined||!classificationRefusals.has(pending)||classificationRefusals.get(pending)!==error)return false;classificationRefusals.delete(pending);return true;
}
class GatewayMessagePolicyCapacityError extends Error{constructor(source:unknown,origin:object){super('Gateway message policy capacity is occupied; no refresh submitted',{cause:source});this.name='GatewayMessagePolicyCapacityError';capacityOrigins.set(this,origin);}}
/** Only this exact preparation Promise can consume its single-use retry proof. */
export function takeGatewayMessagePolicyCapacityRefusal(pending:Promise<PreparedGatewayMessage>|undefined,error:unknown):boolean{
 if(pending===undefined||!capacityRefusals.has(pending)||capacityRefusals.get(pending)!==error)return false;capacityRefusals.delete(pending);return true;
}
export interface MessageCreateOptions {
 readonly database:string;readonly config:Pick<RuntimeConfig,'enableMessageContent'|'plainAskMentionUserIds'>;
 readonly basePolicy:InteractionAccessPolicy;readonly gate:AdmissionGate;readonly allowDrainControl:boolean;
 readonly resolver:SettingsTargetResolver|null;readonly observedAt:number;readonly custody:MessageCustodyOptions;readonly refreshPolicy?:MessagePolicyRefresh;readonly classifyMessage?:MessageClassifier;
}
/** Mandatory fresh mirror policy precedes classification/settings binding,
 * gate entry and durable deduplication. Caller determines allowDrainControl by
 * probing the actual current pending native request; this function does not guess.
 * The outer normal/emergency consumer and cancellation wiring remain separate. */
export function prepareGatewayMessage(message:DecodedGatewayMessage,botUserId:bigint|null,options:MessageCreateOptions,signal?:AbortSignal):Promise<PreparedGatewayMessage>{
 const origin={};
 const pending=prepare(message,botUserId,options,signal,origin).catch((error:unknown)=>{if(error!==null&&typeof error==='object'&&capacityOrigins.get(error)===origin)capacityRefusals.set(pending,error);if(error!==null&&typeof error==='object'&&classificationOrigins.get(error)===origin)classificationRefusals.set(pending,error);throw error;});
 return pending;
}
async function prepare(message:DecodedGatewayMessage,botUserId:bigint|null,options:MessageCreateOptions,signal:AbortSignal|undefined,origin:object):Promise<PreparedGatewayMessage>{
 signal?.throwIfAborted();
 const target=messageErrorReportTarget(message),{database,config,basePolicy,gate,allowDrainControl,resolver,observedAt}=options;
 const custody=captureMessageCustodyOptions(database,options.custody);
 if(typeof allowDrainControl!=='boolean')throw new TypeError('Expected drain control availability');
 const refresh=captureMessagePolicyRefresh(options),classify=captureMessageClassifier(options);let policy:InteractionAccessPolicy,refreshPending:Promise<InteractionAccessPolicy>|undefined;
 try{refreshPending=refresh(basePolicy,database,signal);if(!types.isPromise(refreshPending))throw new TypeError('Expected message policy refresh Promise');policy=await refreshPending;}
 catch(error){if(signal?.aborted&&error===signal.reason)throw error;if(takeMirrorPolicyCapacityRefusal(refreshPending,error))throw new GatewayMessagePolicyCapacityError(error,origin);throw error;}
 signal?.throwIfAborted();
 let result:MessageClassification,classificationPending:Promise<MessageClassification>|undefined;
 try{classificationPending=classify(message,database,config,policy,botUserId,signal);if(!types.isPromise(classificationPending))throw new TypeError('Expected classifier Promise');result=await classificationPending;}
 catch(error){if(signal?.aborted&&error===signal.reason)throw error;if(takeMessageClassificationCapacityRefusal(classificationPending,error))throw new GatewayMessageClassificationCapacityError(error,origin);throw error;}
 const simple=(kind:Kind,ignored:PreparedGatewayMessage['ignored']=null)=>new PreparedGatewayMessage(token,kind,target,null,null,ignored);
 if(result.kind==='Ignore')return simple('Ignore',Object.freeze({reason:result.reason,channelId:result.channelId,userId:result.userId}));
 signal?.throwIfAborted();const candidate=result.candidate;if(resolver!==null)await MessageCandidate.prototype.bindSettings.call(candidate,resolver);
 signal?.throwIfAborted();const pendingOnly=allowDrainControl&&MessageCandidate.prototype.isPendingReplyCandidate.call(candidate),stop=MessageCandidate.prototype.isStopControl.call(candidate),force=MessageCandidate.prototype.isForceRestart.call(candidate);
 if(allowDrainControl&&!pendingOnly&&!stop&&!force)return simple('Unavailable');
 let permit:AdmissionPermit|null=null,admitted:AdmittedMessage|null=null,transferred=false;
 try{
  if(!force){try{permit=pendingOnly||stop?AdmissionGate.prototype.tryEnterControlObserved.call(gate)[0]:AdmissionGate.prototype.tryEnter.call(gate);}catch(error){if(drainGateErrorInfo(error)?.kind==='Sealed')return simple('Unavailable');throw error;}}
  admitted=await admitMessageCandidateAt(candidate,observedAt,custody);if(admitted===null)return simple('Duplicate');
  if(pendingOnly)await AdmittedMessage.prototype.requirePendingReply.call(admitted);
  signal?.throwIfAborted();const prepared=new PreparedGatewayMessage(token,'Admitted',target,admitted,permit);transferred=true;return prepared;
 }finally{if(!transferred){try{if(admitted!==null)await AdmittedMessage.prototype.dispose.call(admitted);}finally{if(permit!==null)AdmissionPermit.prototype.release.call(permit);}}}
}
