import {types} from 'node:util';
import {gatewayOwnField} from './gateway/values.ts';
import {isDecodedGatewayInteraction,type DecodedGatewayInteraction} from './gateway/decoded-interaction.ts';
import {isDecodedGatewayMessage,type DecodedGatewayMessage} from './gateway/decoded-message.ts';
import {discordInteractionAuthor} from './model/interaction.ts';
export interface InteractionAccessPolicyInput{readonly allowedChannelIds:readonly bigint[];readonly allowedUserIds:readonly bigint[];readonly mirroredChannelIds:readonly bigint[];readonly allowAllChannels:boolean}
export interface InteractionAccessDecision{readonly kind:'Allowed'|'DeniedUser'|'DeniedChannel';readonly channelId:bigint|null;readonly userId:bigint|null;readonly sourceMessageId:bigint|null}
function ids(input:unknown):Set<bigint>{if(!Array.isArray(input)||types.isProxy(input))throw new TypeError('Expected owned u64 allowlist');const values=new Set<bigint>();for(let i=0;i<input.length;i++){const value=gatewayOwnField(input,String(i));if(typeof value!=='bigint'||value<0n||value>(1n<<64n)-1n)throw new TypeError('Expected u64 policy entry');values.add(value);}return values;}
/** Source access gate only. Allowed is not command validity, runtime admission or
 * execution permission. Policy snapshots are privately copied; source u64 sets
 * permit zero entries although no decoded Discord Id can match zero. */
export class InteractionAccessPolicy{
 readonly #channels:Set<bigint>;readonly #users:Set<bigint>;readonly #mirrors:Set<bigint>;readonly #all:boolean;
 constructor(input:InteractionAccessPolicyInput={allowedChannelIds:[],allowedUserIds:[],mirroredChannelIds:[],allowAllChannels:false}){
  if(new.target!==InteractionAccessPolicy)throw new TypeError('Expected exact interaction access policy');this.#channels=ids(gatewayOwnField(input,'allowedChannelIds'));this.#users=ids(gatewayOwnField(input,'allowedUserIds'));this.#mirrors=ids(gatewayOwnField(input,'mirroredChannelIds'));const all=gatewayOwnField(input,'allowAllChannels');if(typeof all!=='boolean')throw new TypeError('Expected channel policy flag');this.#all=all;Object.freeze(this);
 }
 /** Replace only dynamic mirror IDs, retaining the original static access policy. */
 withMirroredChannelIds(mirroredChannelIds:readonly bigint[]):InteractionAccessPolicy{
  return new InteractionAccessPolicy({allowedChannelIds:[...this.#channels],allowedUserIds:[...this.#users],mirroredChannelIds,allowAllChannels:this.#all});
 }
 /** Independent flags retain message planner's channel-before-user gate order. */
 messageAccess(message:DecodedGatewayMessage):Readonly<{channelAllowed:boolean;userAllowed:boolean}>{
  if(!isDecodedGatewayMessage(message))throw new TypeError('Expected fully decoded message');
  const user=(message.author as Readonly<{id:bigint}>).id;
  return Object.freeze({channelAllowed:this.#all||this.#channels.has(message.channel_id)||this.#mirrors.has(message.channel_id),userAllowed:this.#users.size===0||this.#users.has(user)});
 }
 evaluate(interaction:DecodedGatewayInteraction):InteractionAccessDecision{
  if(!isDecodedGatewayInteraction(interaction))throw new TypeError('Expected fully decoded interaction');
  const channel=interaction.channel as Readonly<{id:bigint}>|null,author=discordInteractionAuthor(interaction) as Readonly<{id:bigint}>|null,message=interaction.message as Readonly<{id:bigint}>|null;
  const channelId=channel?.id??interaction.channel_id as bigint|null,userId=author?.id??null,sourceMessageId=message?.id??null;
  const kind=this.#users.size!==0&&(userId===null||!this.#users.has(userId))?'DeniedUser':channelId===null||!(this.#all||this.#channels.has(channelId)||this.#mirrors.has(channelId))?'DeniedChannel':'Allowed';
  return Object.freeze({kind,channelId,userId,sourceMessageId});
 }
}
Object.freeze(InteractionAccessPolicy.prototype);
