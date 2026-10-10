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
import {planMessage,MessagePlanError,type MessagePlan} from '../message-plan.ts';
import {SettingsTargetResolver,isSettingsRequestRejection,settingsErrorText} from '../settings-binding.ts';
import type {FrozenSettingsBinding} from '../action-executor/settings-snapshot.ts';
export type FrozenMessagePlan={readonly ok:true;readonly value:MessagePlan}|{readonly ok:false;readonly error:MessagePlanError};
export interface MessageCandidateParts {
 readonly message:DecodedGatewayMessage;readonly database:string;readonly persistedId:bigint;readonly channelId:bigint;readonly userId:bigint;
 readonly frozenPlan:FrozenMessagePlan;readonly routingTarget:string|null;readonly newOrigin:NewThreadOrigin;readonly newPromptMentionArm:string|null;
 readonly settingsBinding:FrozenSettingsBinding|null;readonly lifecycleBinding:FrozenSettingsBinding|null;
}
export type MessageClassification={readonly kind:'Ignore';readonly reason:string;readonly channelId:bigint;readonly userId:bigint}|{readonly kind:'Candidate';readonly candidate:MessageCandidate};
export class MessageAdmissionIntegerRangeError extends Error{constructor(){super('Discord identifier does not fit the SQLite integer contract');this.name='MessageAdmissionIntegerRangeError';Object.freeze(this);}}
const sql=(id:bigint)=>{if(id<0n||id>=1n<<63n)throw new MessageAdmissionIntegerRangeError();return id;};
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
export async function classifyGatewayMessage(message:DecodedGatewayMessage,database:string,
 config:Pick<RuntimeConfig,'enableMessageContent'|'plainAskMentionUserIds'>,policy:InteractionAccessPolicy,botUserId:bigint|null):Promise<MessageClassification>{
 if(!isDecodedGatewayMessage(message))throw new TypeError('Expected fully decoded gateway message');requireDiscordText(database);
 if(botUserId!==null&&(typeof botUserId!=='bigint'||botUserId<0n||botUserId>=1n<<64n))throw new TypeError('Expected optional u64 bot identity');
 const enabled=gatewayOwnField(config,'enableMessageContent');if(typeof enabled!=='boolean')throw new TypeError('Expected message content flag');
 const raw=gatewayOwnField(config,'plainAskMentionUserIds');if(raw===null||typeof raw!=='object'||types.isProxy(raw))throw new TypeError('Expected native mention ID set');const required:bigint[]=[];
 Set.prototype.forEach.call(raw,(id:unknown)=>{if(typeof id!=='bigint'||id<0n||id>=1n<<64n)throw new TypeError('Expected u64 mention identity');required.push(id);});
 const access=InteractionAccessPolicy.prototype.messageAccess.call(policy,message);
 const persistedId=sql(message.id),channelId=message.channel_id,storedChannel=sql(channelId),author=message.author as Readonly<{id:bigint;bot:boolean}>,userId=author.id;
 const newOrigin=cloneOwnedSerdeValue(await state.newThreadOrigin(database,storedChannel)) as NewThreadOrigin,routingTarget=newOrigin.target;
 const mentions=(message.mentions as readonly Readonly<{id:bigint}>[]).map(v=>v.id);
 const arm=routingTarget===null&&!author.bot&&!message.content.replace(/^\p{White_Space}+/u,'').startsWith('!')&&required.length!==0&&!mentions.some(id=>required.includes(id))
  ?await state.pendingNewPrompt(database,storedChannel,sql(userId),persistedId):null;
 let frozenPlan:FrozenMessagePlan;
 try{frozenPlan=Object.freeze({ok:true,value:planMessage({content:message.content,messageContentEnabled:enabled,channelAllowed:access.channelAllowed,userAllowed:access.userAllowed,authorIsBot:author.bot,authorIsSelf:botUserId===userId,authorMentionsBridge:botUserId!==null&&mentions.includes(botUserId),hasAttachments:(message.attachments as readonly unknown[]).length!==0,mirroredTarget:routingTarget!==null||arm!==null,mentionedUserIds:mentions,requiredPlainAskUserIds:required})});}
 catch(error){if(!(error instanceof MessagePlanError))throw error;frozenPlan=Object.freeze({ok:false,error});}
 if(frozenPlan.ok&&'Execute'in frozenPlan.value&&typeof frozenPlan.value.Execute==='object'&&'DiscardRequest'in frozenPlan.value.Execute){
  const target=state.abandonmentCommandTarget(database,frozenPlan.value.Execute.DiscardRequest.job_id,storedChannel,sql(userId));
  if(routingTarget!==target)throw new StoreIntegrityError('discard-request mapping changed during classification; no proposal created');
 }
 if(frozenPlan.ok&&'Ignore'in frozenPlan.value)return Object.freeze({kind:'Ignore',reason:frozenPlan.value.Ignore,channelId,userId});
 return Object.freeze({kind:'Candidate',candidate:new MessageCandidate(token,Object.freeze({message,database,persistedId,channelId,userId,frozenPlan,routingTarget,newOrigin,newPromptMentionArm:arm,settingsBinding:null,lifecycleBinding:null}))});
}
