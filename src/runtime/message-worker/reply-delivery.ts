import {DiscordChannelClient} from '../../discord/channel-client.ts';
import type {DiscordComponent} from '../../discord/components.ts';
import {requireDiscordText,splitDeliveryChunks,splitExactDeliveryChunks} from '../../discord/text.ts';
import {deliverChunksIndexed} from '../../discord/delivery.ts';
import {sendReceiptChunk} from '../completion/receipt-sender.ts';
export const MESSAGE_REPLY_DOMAIN='message/reply/v1';
export const MESSAGE_ERROR_DOMAIN='message/error/v1';
export type MessageReplyKind='PendingConfirmation'|'PlannedResponse'|'ActionResult'|'SavedRequest'|'ErrorReport';
function id(value:bigint){if(typeof value!=='bigint'||value<=0n||value>=1n<<64n)throw new TypeError('Expected nonzero Discord u64 identity');}
/** A stable logical receipt identity, not authority to execute an action. Saved
 * request and action result deliberately share the same source identity. */
export function messageReplyIdentity(sourceMessageId:bigint,kind:MessageReplyKind):Readonly<{domain:string;logicalKey:string}>{
 id(sourceMessageId);let segment:string;
 switch(kind){case 'PendingConfirmation':segment='pending-confirmation';break;case 'PlannedResponse':segment='planned-response';break;case 'ActionResult':case 'SavedRequest':segment='action-result';break;case 'ErrorReport':segment='error-report';break;default:throw new TypeError('Expected message reply kind');}
 return Object.freeze({domain:kind==='ErrorReport'?MESSAGE_ERROR_DOMAIN:MESSAGE_REPLY_DOMAIN,logicalKey:`inbound-message/${sourceMessageId}/${segment}`});
}
const policy=Object.freeze({retryDelaysMs:Object.freeze([]),chunkMarkers:true});
/** Sequential durable chunk receipts. An unknown send outcome never auto-retries.
 * Await the whole operation, including receipt commit, before releasing custody. */
export async function deliverMessageReplyText(database:string,client:DiscordChannelClient,channelId:bigint,sourceMessageId:bigint,kind:MessageReplyKind,text:string):Promise<number>{
 requireDiscordText(database);requireDiscordText(text);id(channelId);const identity=messageReplyIdentity(sourceMessageId,kind);
 const chunks=kind==='SavedRequest'?splitExactDeliveryChunks(text,true):splitDeliveryChunks(text,true);
 const transport=Object.freeze({sendValidated:DiscordChannelClient.prototype.sendValidated.bind(client)});
 return deliverChunksIndexed(chunks,policy,(chunkIndex,content)=>sendReceiptChunk(database,transport,channelId,{...identity,chunkIndex,content}));
}
export async function sendMessageReplyOnce(database:string,client:DiscordChannelClient,channelId:bigint,sourceMessageId:bigint,kind:MessageReplyKind,text:string,components:readonly DiscordComponent[]=[]):Promise<void>{
 requireDiscordText(database);requireDiscordText(text);id(channelId);const identity=messageReplyIdentity(sourceMessageId,kind);
 const transport=Object.freeze({sendValidated:DiscordChannelClient.prototype.sendValidated.bind(client)});
 await sendReceiptChunk(database,transport,channelId,{...identity,chunkIndex:0,content:text},components);
}
