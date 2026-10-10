import {isDecodedGatewayMessage,type DecodedGatewayMessage} from '../../discord/gateway/decoded-message.ts';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {cleanupRefusalFromActionError} from '../cleanup-refusal.ts';
import {recordCleanupNotificationFailure} from '../cleanup-notification-failure.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {MessageWorkerError} from './errors.ts';
import {sendMessageReplyOnce} from './reply-delivery.ts';
/** Called only after execution began and a typed pre-delete refusal occurred.
 * Persist that known outcome before notification; never repeat the action. */
export async function deliverMessageCleanupRefusal(message:DecodedGatewayMessage,database:string,http:DiscordChannelClient,error:unknown,now:()=>number=systemNow,signal?:AbortSignal):Promise<true>{
 signal?.throwIfAborted();
 if(!isDecodedGatewayMessage(message))throw new TypeError('Expected decoded message');const refusal=cleanupRefusalFromActionError(error);if(refusal===undefined)throw new MessageWorkerError('Action',error);
 const key=`message:${message.id}`,outcome={kind:'mirror_cleanup_refused',version:1n,sync_completed:false,blocked_room_id:refusal.room,protection_reason:refusal.reason,delete_dispatched:false,earlier_changes_possible:true};
 await state.recordIngressResult(database,key,outcome,readCustodyTimestamp(now));
 const content=`Mirror sync stopped.\nroom: ${refusal.room}\nreason: ${refusal.reason}\nNo deletion was dispatched for this room. Earlier sync changes may have completed.\nPending work is preserved; this request will not retry automatically.`;
 try{await sendMessageReplyOnce(database,http,message.channel_id,message.id,'ErrorReport',content,[],signal);}
 catch(failure){throw new MessageWorkerError('KnownOutcomeNotification',await recordCleanupNotificationFailure(database,key,'delivery',failure,now));}
 return true;
}
