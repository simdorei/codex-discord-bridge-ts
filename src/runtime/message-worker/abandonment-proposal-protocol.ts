import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {publicationDigest,publicationTimeBits} from '../../store/publication-codec.ts';
import type {AbandonmentProposal} from '../../store/abandonment-codec.ts';
export const ABANDONMENT_PROPOSAL_REQUEST_BYTES=262144,ABANDONMENT_PROPOSAL_REPLY_BYTES=524288;
export type ProposalOperation='Route'|'Prepare'|'Bind';
export interface ProposalOriginal {readonly path:string;readonly ingress:string;readonly event:bigint;readonly channel:bigint;readonly actor:bigint;readonly application:bigint;readonly job:string;readonly content:string;readonly proposal:string;}
export function proposalFields(value:unknown,keys:readonly string[]):void{if(value===null||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new TypeError('Invalid exact proposal fields');for(const key of keys)own(value,key);}
export function proposalText(value:unknown,max:number):asserts value is string{requireDiscordText(value);if(Buffer.byteLength(value)>max)throw new RangeError('Proposal text exceeds native boundary');}
export function proposalId(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<=0n||value>=1n<<63n)throw new TypeError('Expected positive i64 proposal identity');}
function time(value:unknown):asserts value is number{if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new TypeError('Expected finite proposal timestamp');}
export function captureProposalOriginal(input:unknown):ProposalOriginal{
 const keys=['path','ingress','event','channel','actor','application','job','content','proposal'] as const;proposalFields(input,keys);
 const value=Object.fromEntries(keys.map(key=>[key,own(input,key)])) as unknown as ProposalOriginal;
 proposalText(value.path,32768);if(value.path.includes('\0'))throw new TypeError('Invalid proposal database');for(const key of ['event','channel','actor','application'] as const)proposalId(value[key]);
 proposalText(value.ingress,256);if(value.ingress!==`message:${value.event}`)throw new TypeError('Crossed original message ingress');
 proposalText(value.job,36);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.job))throw new TypeError('Expected exact saved job UUID');
 proposalText(value.content,131072);proposalText(value.proposal,32);if(!/^[0-9a-f]{32}$/.test(value.proposal))throw new TypeError('Expected original proposal UUID');return Object.freeze(value);
}
export function proposalBinding(requestId:string,original:ProposalOriginal,operation:ProposalOperation,target:string|null,at:number,message:bigint|null,revision:bigint|null,hash:string|null){
 const fixed=captureProposalOriginal(original);proposalText(requestId,36);if(!/^[0-9a-f-]{36}$/.test(requestId)||!['Route','Prepare','Bind'].includes(operation))throw new TypeError('Invalid proposal operation');time(at);
 if(operation==='Route'){if(target!==null||message!==null||revision!==null||hash!==null)throw new TypeError('Route cannot carry mutation authority');}
 else {proposalText(target,1024);if(target.length===0)throw new TypeError('Empty original target');if(operation==='Prepare'){if(message!==null||revision!==null||hash!==null)throw new TypeError('Prepare cannot carry delivery authority');}
 else {proposalId(message);proposalId(revision);if(typeof hash!=='string'||!/^[0-9a-f]{64}$/.test(hash))throw new TypeError('Invalid original review hash');}}
 const result=Object.freeze({...fixed,requestId,operation,target,at,message,revision,hash});if(boundedSerdeByteCount(result,ABANDONMENT_PROPOSAL_REQUEST_BYTES)===null)throw new RangeError('Proposal request exceeds native boundary');return result;
}
export function captureProposal(value:unknown,original:ProposalOriginal,target:string,at:number):AbandonmentProposal{
 if(boundedSerdeByteCount(value,ABANDONMENT_PROPOSAL_REPLY_BYTES)===null)throw new RangeError('Proposal reply exceeds boundary');
 const keys=['id','revision','job_id','thread_id','owner_user_id','channel_id','application_id','created_at_bits','expires_at_bits','review_text','review_sha256'] as const;proposalFields(value,keys);
 const p=Object.fromEntries(keys.map(key=>[key,own(value,key)])) as unknown as AbandonmentProposal;
 if(p.id!==original.proposal||p.job_id!==original.job||p.thread_id!==target||p.owner_user_id!==original.actor||p.channel_id!==original.channel||p.application_id!==original.application||p.created_at_bits!==publicationTimeBits(at)||p.expires_at_bits!==publicationTimeBits(at+120))throw new TypeError('Crossed original proposal result');
 proposalId(p.revision);proposalText(p.review_text,131072);if(p.review_sha256!==publicationDigest(p.review_text))throw new TypeError('Proposal review digest differs');return Object.freeze(p);
}
