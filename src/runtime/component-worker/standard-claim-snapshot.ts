import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {parseComponentId,persistentComponentClaimKey} from '../../discord/components.ts';
import {standardReadyMarker} from './confirmation.ts';
export const STANDARD_CLAIM_REQUEST_BYTES=65536,STANDARD_CLAIM_REPLY_BYTES=65536;
export type StandardClaimOperation='Claim'|'RecoverReady'|'Ready'|'Release';
export interface StandardClaimIdentity{
 readonly interactionIngressId:string;readonly interactionId:bigint;readonly applicationId:bigint;
 readonly actorId:bigint;readonly channelId:bigint;readonly sourceMessageId:bigint;readonly customId:string;
 readonly actionClaim:string;readonly readyMarker:string;
}
function id(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<=0n||value>=1n<<64n)throw new TypeError('Expected original positive u64 component identity');}
/** Exact primitive transport identity. The caller must separately own routed
 * work and execution custody; neither this snapshot nor a claim authorizes respond. */
export function captureStandardClaimIdentity(input:unknown):StandardClaimIdentity{
 const interactionIngressId=own(input,'interactionIngressId'),interactionId=own(input,'interactionId'),applicationId=own(input,'applicationId'),actorId=own(input,'actorId'),channelId=own(input,'channelId'),sourceMessageId=own(input,'sourceMessageId'),customId=own(input,'customId');
 id(interactionId);id(applicationId);id(actorId);id(channelId);id(sourceMessageId);requireDiscordText(interactionIngressId);requireDiscordText(customId);
 if(interactionIngressId!==`interaction:${interactionId}`||Buffer.byteLength(customId)>400)throw new TypeError('Expected original component click identity');
 const component=parseComponentId(customId);if(component===null||(!('BoundApproval'in component)&&!('BoundInput'in component)))throw new TypeError('Expected exact bound standard component');
 const actionClaim=`actor-v1:${persistentComponentClaimKey(sourceMessageId,component)}:${actorId}:${channelId}`;
 return Object.freeze({interactionIngressId,interactionId,applicationId,actorId,channelId,sourceMessageId,customId,actionClaim,readyMarker:standardReadyMarker(actionClaim)});
}
export function standardClaimBinding(id:string,path:string,operation:StandardClaimOperation,identity:StandardClaimIdentity,now:number){
 if(typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id))throw new TypeError('Expected native claim operation ID');requireDiscordText(path);
 if(path.includes('\0')||Buffer.byteLength(path)>32768||!['Claim','RecoverReady','Ready','Release'].includes(operation))throw new TypeError('Invalid native standard claim operation');
 if(!Number.isFinite(now)||now<0||!Number.isFinite(now+1800))throw new TypeError('Invalid standard claim timestamp');
 return Object.freeze({id,path,operation,...identity,now,expiresAt:now+1800});
}
