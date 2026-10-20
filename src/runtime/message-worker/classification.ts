import {types} from 'node:util';
import {isDecodedGatewayMessage,type DecodedGatewayMessage} from '../../discord/gateway/decoded-message.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {InteractionAccessPolicy} from '../../discord/interaction-access.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {RuntimeConfig} from '../../config/runtime.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import type {NewThreadOrigin} from '../../store/new-thread-origin.ts';
import {StoreIntegrityError} from '../../store/schema-assembly.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {isProCommand} from '../../pro/prompt.ts';
import {messageSqlId as sql,needsNewPromptArm,frozenMessagePlan,discardClassificationJob,type ClassificationFacts,type FrozenMessagePlan} from './classification-plan.ts';
export {MessageAdmissionIntegerRangeError,type FrozenMessagePlan} from './classification-plan.ts';
import {OwnedWorkerSlot,takeOwnedWorkerAdmissionRefusal,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {captureNativeMessageClassificationLimits,captureClassificationReadResult,throwClassificationReadFailure,NativeMessageClassificationError,type NativeMessageClassificationLimits,type ClassificationReadResult} from './classification-wire.ts';
export {captureNativeMessageClassificationLimits,NativeMessageClassificationError,type NativeMessageClassificationLimits} from './classification-wire.ts';
import {SettingsTargetResolver,isSettingsRequestRejection,settingsErrorText} from '../settings-binding.ts';
import type {FrozenSettingsBinding} from '../action-executor/settings-snapshot.ts';
export interface MessageCandidateParts {
 readonly message:DecodedGatewayMessage;readonly database:string;readonly persistedId:bigint;readonly channelId:bigint;readonly userId:bigint;
 readonly frozenPlan:FrozenMessagePlan;readonly routingTarget:string|null;readonly newOrigin:NewThreadOrigin;readonly newPromptMentionArm:string|null;
 readonly settingsBinding:FrozenSettingsBinding|null;readonly lifecycleBinding:FrozenSettingsBinding|null;
}
export type MessageClassification={readonly kind:'Ignore';readonly reason:string;readonly channelId:bigint;readonly userId:bigint}|{readonly kind:'Candidate';readonly candidate:MessageCandidate};
const token=Symbol('MessageCandidate');
const respond=(text:string):FrozenMessagePlan=>Object.freeze({ok:true,value:Object.freeze({Respond:text})});
function sameRoute(binding:FrozenSettingsBinding,routed:string|null){return binding.route==='Explicit'||(binding.route==='Mapped'?routed===binding.target:routed===null);}
/** Non-cloneable candidate. It must be consumed exactly once by the admission
 * owner; neither classification nor a pure frozen plan is execution permission. */
export class MessageCandidate {
 #parts:MessageCandidateParts;#consumed=false;#binding=false;
 constructor(secret:symbol,parts:MessageCandidateParts){if(secret!==token)throw new TypeError('Expected classified candidate');this.#parts=parts;Object.freeze(this);}
 #available(){if(this.#consumed||this.#binding)throw new TypeError('Candidate is consumed or borrowed');}
 isPendingReplyCandidate():boolean{this.#available();const p=this.#parts.frozenPlan;return p.ok&&'Execute'in p.value&&typeof p.value.Execute==='object'&&'Ask'in p.value.Execute&&!isProCommand(p.value.Execute.Ask.prompt);}
 isStopControl():boolean{this.#available();const p=this.#parts.frozenPlan;return p.ok&&'Execute'in p.value&&typeof p.value.Execute==='object'&&'Stop'in p.value.Execute;}
 isForceRestart():boolean{this.#available();const p=this.#parts.frozenPlan;if(!p.ok||!('Execute'in p.value))return false;const a=p.value.Execute;return a==='ForceRestartCodex'||typeof a==='object'&&('Recover'in a||'Repair'in a);}
 async bindSettings(resolver:SettingsTargetResolver):Promise<this>{
  this.#available();this.#binding=true;
  try{
   let p=this.#parts;const plan=p.frozenPlan;if(!plan.ok||!('Execute'in plan.value))return this;const action=plan.value.Execute;
   let lifecycle:FrozenSettingsBinding|null;
   try{lifecycle=await SettingsTargetResolver.prototype.bindLifecycle.call(resolver,action,p.channelId);}
   catch(error){if(isSettingsRequestRejection(error)){this.#parts=Object.freeze({...p,frozenPlan:respond('ERROR: '+settingsErrorText(error)),lifecycleBinding:null});return this;}throw new StoreIntegrityError(settingsErrorText(error));}
   if(lifecycle!==null&&!sameRoute(lifecycle,p.routingTarget)){this.#parts=Object.freeze({...p,frozenPlan:respond('ERROR: lifecycle mapping changed during admission; no lifecycle operation was sent'),lifecycleBinding:null});return this;}
   p=Object.freeze({...p,lifecycleBinding:lifecycle});this.#parts=p;let binding:FrozenSettingsBinding|null;
   try{binding=await SettingsTargetResolver.prototype.bind.call(resolver,action,p.channelId);}
   catch(error){if(isSettingsRequestRejection(error)){this.#parts=Object.freeze({...p,frozenPlan:respond('ERROR: '+settingsErrorText(error))});return this;}throw new StoreIntegrityError(settingsErrorText(error));}
   this.#parts=binding!==null&&!sameRoute(binding,p.routingTarget)
    ?Object.freeze({...p,settingsBinding:null,frozenPlan:respond('ERROR: settings mapping changed during message classification; no update was sent')})
    :Object.freeze({...p,settingsBinding:binding});return this;
  }finally{this.#binding=false;}
 }
 intoAdmissionParts():MessageCandidateParts{this.#available();this.#consumed=true;return this.#parts;}
}
Object.freeze(MessageCandidate.prototype);
type Config=Pick<RuntimeConfig,'enableMessageContent'|'plainAskMentionUserIds'>;
export type MessageClassifier=(message:DecodedGatewayMessage,database:string,config:Config,policy:InteractionAccessPolicy,botUserId:bigint|null,signal?:AbortSignal)=>Promise<MessageClassification>;
/** Callback and options are captured before the first asynchronous step. */
export function captureMessageClassifier(options:unknown):MessageClassifier{
 if(options===null||typeof options!=='object'||types.isProxy(options))throw new TypeError('Expected classification options');
 const field=Object.getOwnPropertyDescriptor(options,'classifyMessage');if(field!==undefined&&!Object.hasOwn(field,'value'))throw new TypeError('Expected classifier callback data');
 const fn=field?.value===undefined?classifyGatewayMessage:field.value;if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected message classifier');return fn as MessageClassifier;
}
function capture(message:DecodedGatewayMessage,database:string,config:Config,policy:InteractionAccessPolicy,botUserId:bigint|null){
 if(!isDecodedGatewayMessage(message))throw new TypeError('Expected fully decoded gateway message');requireDiscordText(database);
 if(botUserId!==null&&(typeof botUserId!=='bigint'||botUserId<0n||botUserId>=1n<<64n))throw new TypeError('Expected optional u64 bot identity');
 const enabled=gatewayOwnField(config,'enableMessageContent');if(typeof enabled!=='boolean')throw new TypeError('Expected message content flag');
 const raw=gatewayOwnField(config,'plainAskMentionUserIds');if(raw===null||typeof raw!=='object'||types.isProxy(raw))throw new TypeError('Expected native mention ID set');const required:bigint[]=[];
 Set.prototype.forEach.call(raw,(id:unknown)=>{if(typeof id!=='bigint'||id<0n||id>=1n<<64n)throw new TypeError('Expected u64 mention identity');required.push(id);});
 const access=InteractionAccessPolicy.prototype.messageAccess.call(policy,message);
 const persistedId=sql(message.id),channelId=sql(message.channel_id),author=message.author as Readonly<{id:bigint;bot:boolean}>,userId=author.id;
 const mentions=Object.freeze((message.mentions as readonly Readonly<{id:bigint}>[]).map(v=>v.id));
 const facts:ClassificationFacts=Object.freeze({content:message.content,messageContentEnabled:enabled,channelAllowed:access.channelAllowed,userAllowed:access.userAllowed,authorIsBot:author.bot,authorIsSelf:botUserId===userId,authorMentionsBridge:botUserId!==null&&mentions.includes(botUserId),hasAttachments:(message.attachments as readonly unknown[]).length!==0,mentionedUserIds:mentions,requiredPlainAskUserIds:Object.freeze(required)});
 return Object.freeze({message,database,persistedId,channelId,userId,facts});
}
function finish(input:ReturnType<typeof capture>,read:ClassificationReadResult):MessageClassification{
 const {message,database,persistedId,channelId,userId,facts}=input,newOrigin=read.origin,routingTarget=newOrigin.target,arm=read.arm;
 if(needsNewPromptArm(facts,routingTarget))sql(userId);
 if(!needsNewPromptArm(facts,routingTarget)&&arm!==null)throw new NativeMessageClassificationError('Unexpected mention arm');
 const frozenPlan=frozenMessagePlan(facts,routingTarget,arm),job=discardClassificationJob(frozenPlan);
 if(job!==null){sql(userId);if(read.abandonmentTarget!==routingTarget||read.abandonmentTarget===null)throw new StoreIntegrityError('discard-request mapping changed during classification; no proposal created');}
 else if(read.abandonmentTarget!==null)throw new NativeMessageClassificationError('Unexpected abandonment target');
 if(frozenPlan.ok&&'Ignore'in frozenPlan.value)return Object.freeze({kind:'Ignore',reason:frozenPlan.value.Ignore,channelId,userId});
 return Object.freeze({kind:'Candidate',candidate:new MessageCandidate(token,Object.freeze({message,database,persistedId,channelId,userId,frozenPlan,routingTarget,newOrigin,newPromptMentionArm:arm,settingsBinding:null,lifecycleBinding:null}))});
}
/** Direct compatibility path retains the original facade calls and observations. */
export async function classifyGatewayMessage(message:DecodedGatewayMessage,database:string,config:Config,policy:InteractionAccessPolicy,botUserId:bigint|null):Promise<MessageClassification>{
 const input=capture(message,database,config,policy,botUserId),{channelId,persistedId,userId,facts}=input;
 const origin=cloneOwnedSerdeValue(await state.newThreadOrigin(database,channelId)) as NewThreadOrigin;
 const arm=needsNewPromptArm(facts,origin.target)?await state.pendingNewPrompt(database,channelId,sql(userId),persistedId):null;
 const job=discardClassificationJob(frozenMessagePlan(facts,origin.target,arm)),abandonmentTarget=job===null?null:state.abandonmentCommandTarget(database,job,channelId,sql(userId));
 return finish(input,{origin,arm,abandonmentTarget});
}
const capacityOrigins=new WeakMap<object,object>(),capacityRefusals=new WeakMap<Promise<MessageClassification>,unknown>();
class MessageClassificationCapacityError extends OwnedWorkerBusyError{constructor(origin:object){super();this.name='MessageClassificationCapacityError';this.message='Message classification capacity is occupied; no read submitted';capacityOrigins.set(this,origin);}}
export function takeMessageClassificationCapacityRefusal(pending:Promise<MessageClassification>|undefined,error:unknown):boolean{
 if(pending===undefined||!capacityRefusals.has(pending)||capacityRefusals.get(pending)!==error)return false;capacityRefusals.delete(pending);return true;
}
function capturePath(path:string):string{
 requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new RangeError('Invalid native classification path');const fixed=pinNativeRuntimePath(path);if(Buffer.byteLength(fixed)>32768)throw new RangeError('Invalid native classification path');return fixed;
}
/** Read-only classification uses the shared Background lane so it cannot evict
 * the resident Control writer. Standalone calls retain zero-queue semantics;
 * cancellation/timeout joins actual native exit, never terminates database I/O. */
export function createNativeMessageClassifier(database:string,limits:NativeMessageClassificationLimits):MessageClassifier{
 const path=capturePath(database),fixed=captureNativeMessageClassificationLimits(limits);
 return (message,given,config,policy,botUserId,signal)=>{
  const origin={};
  const pending=classifyNative(origin,message,given,config,policy,botUserId,signal).catch((error:unknown)=>{if(error!==null&&typeof error==='object'&&capacityOrigins.get(error)===origin)capacityRefusals.set(pending,error);throw error;});return pending;
 };
 async function classifyNative(origin:object,message:DecodedGatewayMessage,given:string,config:Config,policy:InteractionAccessPolicy,botUserId:bigint|null,signal?:AbortSignal):Promise<MessageClassification>{
  signal?.throwIfAborted();if(given!==database)throw new TypeError('Classifier belongs to another database');
  const input=capture(message,given,config,policy,botUserId);
  if(boundedSerdeByteCount(input.facts,4194304)===null)throw new RangeError('Classification input exceeds native budget');
  const slot=new OwnedWorkerSlot('Background');let pending:Promise<unknown>|undefined,response:unknown,admitted=false,joined=Promise.resolve();
  try{
   try{pending=slot.run(new URL('./native-classification-worker.ts',import.meta.url),{path,limits:fixed,facts:input.facts,channel:input.channelId,event:input.persistedId,actor:input.userId},fixed.timeoutMs,signal);}
   finally{admitted=slot.busy;joined=slot.join();}
   response=await pending;
  }catch(error){if(!admitted&&takeOwnedWorkerAdmissionRefusal(slot,pending,error))throw new MessageClassificationCapacityError(origin);throw error;}
  finally{await joined;}
  signal?.throwIfAborted();
  if(boundedSerdeByteCount(response,fixed.maxOutputBytes+16384)===null||response===null||typeof response!=='object'||Object.getOwnPropertyNames(response).length!==2)throw new NativeMessageClassificationError('Invalid complete worker response');
  const ok=gatewayOwnField(response,'ok');if(ok===false)throwClassificationReadFailure(gatewayOwnField(response,'error'));if(ok!==true)throw new NativeMessageClassificationError('Invalid worker response');
  return finish(input,captureClassificationReadResult(gatewayOwnField(response,'value'),input.channelId,fixed));
 }
}
