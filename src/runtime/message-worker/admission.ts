import {AdmissionPermit} from '../../admission/drain-gate.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {getOwn,pointer} from '../../store/async-resolution-json-helpers.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {StoreIntegrityError} from '../../store/schema-assembly.ts';
import type {NewIngress} from '../../store/ingress-types.ts';
import {MessageCandidate,type MessageCandidateParts,type FrozenMessagePlan} from './classification.ts';
import {MessageCustody,type MessageCustodyOptions} from './custody.ts';
export type MessageProcessingMode='Normal'|'PendingReplyOnly';
export interface MessageProcessingParts {
 readonly message:MessageCandidateParts['message'];readonly channelId:bigint;readonly userId:bigint;
 readonly frozenPlan:FrozenMessagePlan;readonly processingMode:MessageProcessingMode;
 readonly custody:MessageCustody;readonly admissionPermit:AdmissionPermit|null;
}
export class MessageDatabaseMismatchError extends Error {
 readonly claimedDatabase:string;readonly contextDatabase:string;
 constructor(claimed:string,context:string){super(`admitted Discord message database mismatch: claimed=${JSON.stringify(claimed)} context=${JSON.stringify(context)}`);this.name='MessageDatabaseMismatchError';this.claimedDatabase=claimed;this.contextDatabase=context;Object.freeze(this);}
}
/** Rust Path::components comparison on Unix UTF-8 paths. No filesystem lookup,
 * symlink resolution or '..' collapse. Windows path semantics remain gated. */
export function sameMessageDatabasePath(a:string,b:string):boolean {
 requireDiscordText(a);requireDiscordText(b);if(process.platform==='win32')throw new TypeError('Windows message path affinity is not implemented');
 const components=(s:string)=>{const out:string[]=[];if(s.startsWith('/'))out.push('/');else if(s==='.'||s.startsWith('./'))out.push('.');for(const p of s.split('/'))if(p!==''&&p!=='.')out.push(p);return out;};
 const left=components(a),right=components(b);return left.length===right.length&&left.every((v,i)=>v===right[i]);
}
function request(parts:MessageCandidateParts,now:number):NewIngress {
 for(const [id,label] of [[parts.channelId,'channel'],[parts.userId,'owner']] as const)if(id<0n||id>=1n<<63n)throw new StoreIntegrityError(`invalid message ${label}`);
 const attachments=(parts.message.attachments as readonly Record<string,unknown>[]).map(a=>({id:a.id,filename:a.filename,size:a.size,content_type:a.content_type,artifact_status:'metadata_only_requires_reupload_if_unavailable'}));
 return {ingressId:`message:${parts.persistedId}`,kind:'message',eventId:parts.persistedId,applicationId:null,channelId:parts.channelId,ownerUserId:parts.userId,sourceMessageId:parts.persistedId,
  payload:{version:1n,content:parts.message.content,plan:parts.frozenPlan.ok?parts.frozenPlan.value:{Error:parts.frozenPlan.error.message},attachments,processing_mode:'normal',author_is_bot:(parts.message.author as {bot:boolean}).bot,
   routing:{mirrored_target:parts.routingTarget,selected_target:'resolved_before_processing'},new_origin:parts.newOrigin,new_prompt_mention_arm:parts.newPromptMentionArm,settings_binding:parts.settingsBinding,lifecycle_binding:parts.lifecycleBinding},
  targetThreadId:parts.lifecycleBinding?.target??parts.settingsBinding?.target??parts.routingTarget,canonicalOwner:null,now};
}
const token=Symbol('AdmittedMessage');
/** Single-owner local custody. Always await dispose unless ownership was
 * transferred through intoProcessingParts. This is not a live execution permit. */
export class AdmittedMessage {
 readonly #parts:MessageCandidateParts;readonly #custody:MessageCustody;readonly #plan:FrozenMessagePlan;
 #mode:MessageProcessingMode='Normal';#permit:AdmissionPermit|null=null;#closed=false;#pending:Promise<unknown>|null=null;#disposal:Promise<void>|null=null;
 constructor(secret:symbol,parts:MessageCandidateParts,plan:FrozenMessagePlan,custody:MessageCustody){if(secret!==token)throw new TypeError('Expected durably admitted message');this.#parts=parts;this.#plan=plan;this.#custody=custody;Object.freeze(this);}
 #available(){if(this.#closed||this.#pending!==null)throw new TypeError('Admitted message is consumed or borrowed');}
 retainAdmission(permit:AdmissionPermit|null):this {
  this.#available();const next=permit===null?null:AdmissionPermit.prototype.clone.call(permit);if(this.#permit!==null)AdmissionPermit.prototype.release.call(this.#permit);this.#permit=next;return this;
 }
 requirePendingReply():Promise<this>{
  this.#available();const pending=state.recordIngressProcessingMode(this.#parts.database,`message:${this.#parts.persistedId}`,'pending_reply_only').then(()=>{this.#mode='PendingReplyOnly';return this;}).finally(()=>{this.#pending=null;});this.#pending=pending;return pending;
 }
 intoProcessingParts(contextDatabase:string):MessageProcessingParts {
  this.#available();if(!sameMessageDatabasePath(this.#parts.database,contextDatabase))throw new MessageDatabaseMismatchError(this.#parts.database,contextDatabase);
  this.#closed=true;const permit=this.#permit;this.#permit=null;return Object.freeze({message:this.#parts.message,channelId:this.#parts.channelId,userId:this.#parts.userId,frozenPlan:this.#plan,processingMode:this.#mode,custody:this.#custody,admissionPermit:permit});
 }
 dispose():Promise<void>{
  if(this.#disposal!==null)return this.#disposal;if(this.#closed)return Promise.resolve();this.#closed=true;const pending=this.#pending;
  this.#disposal=(async()=>{try{if(pending!==null){try{await pending;}catch{/* Original caller owns transition failure. */}}await this.#custody.dispose();}finally{if(this.#permit!==null)AdmissionPermit.prototype.release.call(this.#permit);this.#permit=null;}})();return this.#disposal;
 }
}
Object.freeze(AdmittedMessage.prototype);
/** Only the private candidate mint can supply admission. Store atomically claims
 * the message and consumes !new reservations; reload its decision after commit.
 * Gateway gap fencing and caller permit retention are separate mandatory layers. */
export async function admitMessageCandidateAt(candidate:MessageCandidate,observedAt:number,options:MessageCustodyOptions):Promise<AdmittedMessage|null>{
 const parts=MessageCandidate.prototype.intoAdmissionParts.call(candidate);
 if(process.platform==='win32')throw new TypeError('Windows message admission affinity is not implemented');
 if(typeof observedAt!=='number'||!Number.isFinite(observedAt)||observedAt<0)throw new TypeError('Expected nonnegative finite admission time');
 const input=request(parts,observedAt),custody=new MessageCustody(parts.database,input.ingressId,options);
 const admission=await state.admitIngress(parts.database,input);if(!admission.created)return null;
 let plan=parts.frozenPlan;const payload=admission.record?.payload;
 if(payload!==undefined&&(getOwn(payload,'new_prompt_arm')!==undefined||getOwn(payload,'new_prompt_arm_ref')!==undefined||typeof getOwn(payload,'new_prompt_mention_arm')==='string')){
  const response=pointer(payload,'/plan/Respond'),prompt=pointer(payload,'/plan/Execute/New/prompt');
  if(typeof response==='string')plan=Object.freeze({ok:true,value:Object.freeze({Respond:response})});
  else if(typeof prompt==='string')plan=Object.freeze({ok:true,value:Object.freeze({Execute:Object.freeze({New:Object.freeze({prompt})})})});
  else throw new StoreIntegrityError('invalid persisted !new decision');
 }
 return new AdmittedMessage(token,parts,plan,custody);
}
