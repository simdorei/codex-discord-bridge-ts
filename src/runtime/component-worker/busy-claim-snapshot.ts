import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {parseComponentId,type BusyAction} from '../../discord/components.ts';
import {parseBusyChoice,serializeBusyChoice} from '../../store/busy-choice.ts';
import {busyReadyMarker} from './confirmation.ts';
export const BUSY_CLAIM_REQUEST_BYTES=524288,BUSY_CLAIM_REPLY_BYTES=524288;
export type BusyClaimOperation='Claim'|'ReadReady'|'RecoverReady'|'Ready'|'Release'|'Resolve';
export interface BusyClaimIdentity{
 readonly interactionIngressId:string;readonly interactionId:bigint;readonly applicationId:bigint;
 readonly actorId:bigint;readonly channelId:bigint;readonly sourceMessageId:bigint|null;readonly customId:string;
 readonly choiceJson:string;readonly choiceId:string;readonly action:BusyAction;readonly readyMarker:string;
}
function id(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<=0n||value>=1n<<64n)throw new TypeError('Expected original positive u64 Busy identity');}
/** Primitive transport binding only. The pre-ACK snapshot stays original; a
 * current row is never substituted as action authority. */
export function captureBusyClaimIdentity(input:unknown):BusyClaimIdentity{
 const interactionIngressId=own(input,'interactionIngressId'),interactionId=own(input,'interactionId'),applicationId=own(input,'applicationId'),actorId=own(input,'actorId'),channelId=own(input,'channelId'),sourceMessageId=own(input,'sourceMessageId'),customId=own(input,'customId'),choiceJson=own(input,'choiceJson');
 id(interactionId);id(applicationId);id(actorId);id(channelId);if(sourceMessageId!==null)id(sourceMessageId);requireDiscordText(interactionIngressId);requireDiscordText(customId);requireDiscordText(choiceJson);
 if(interactionIngressId!==`interaction:${interactionId}`||Buffer.byteLength(customId)>400||Buffer.byteLength(choiceJson)>393216)throw new TypeError('Expected original Busy click identity');
 const component=parseComponentId(customId);if(component===null||!('Busy'in component))throw new TypeError('Expected exact Busy component');
 const choice=parseBusyChoice(choiceJson),{choice_id:choiceId,action}=component.Busy;
 if(serializeBusyChoice(choice)!==choiceJson||choice.choiceId!==choiceId||choice.ownerUserId!==actorId||choice.channelId!==channelId||!Number.isFinite(choice.createdAt)||!Number.isFinite(choice.expiresAt))throw new TypeError('Crossed original Busy authorization snapshot');
 return Object.freeze({interactionIngressId,interactionId,applicationId,actorId,channelId,sourceMessageId,customId,choiceJson,choiceId,action,readyMarker:busyReadyMarker(choiceId,actorId,channelId)});
}
export function busyClaimBinding(id:string,path:string,operation:BusyClaimOperation,identity:BusyClaimIdentity,now:number){
 if(typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id))throw new TypeError('Expected native Busy operation ID');requireDiscordText(path);
 if(path.includes('\0')||Buffer.byteLength(path)>32768||!['Claim','ReadReady','RecoverReady','Ready','Release','Resolve'].includes(operation))throw new TypeError('Invalid native Busy claim operation');
 if(!Number.isFinite(now)||now<0||!Number.isFinite(now+1800))throw new TypeError('Invalid Busy claim timestamp');
 if(operation==='Resolve'&&(identity.action!=='Stop'&&identity.action!=='Steer'||parseBusyChoice(identity.choiceJson).targetThreadId===null))throw new TypeError('Resolution requires original Stop or Steer target');
 if((operation==='Claim'||operation==='Ready'||operation==='Release')&&identity.action==='Queue')throw new TypeError('Queue owns its atomic admission and ready transaction');
 return Object.freeze({id,path,operation,...identity,now,expiresAt:now+1800});
}
