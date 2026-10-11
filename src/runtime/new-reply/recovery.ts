import {types} from 'node:util';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {parseNewReplyIdentity} from '../../store/new-reply-identity.ts';
import type {NewReply} from '../../store/new-reply-read.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {newReplyWarningText} from '../../store/new-reply-claims.ts';
import {deliverMessageReplyText} from '../message-worker/reply-delivery.ts';
import {sendReceiptChunk} from '../completion/receipt-sender.ts';
export class NewReplyAcknowledgementError extends Error{
 readonly jobId:string;
 constructor(jobId:string,cause:unknown){super('New acknowledgement was not confirmed; original receipt retained',{cause});this.name='NewReplyAcknowledgementError';this.jobId=jobId;}
}
function channel(value:bigint|null):bigint{if(typeof value!=='bigint'||value<=0n||value>=(1n<<64n))throw new RangeError('Expected original nonzero Discord identity');return value;}
/** Source normal-ACK recovery and one durable verification notice. Uses the same
 * sender/domain/key/body as the gateway path, so races share the receipt claim.
 * Existing receipt state functions remain synchronous SQLite under async wrappers;
 * no whole-runtime offload claim. Join the full call before closing shared HTTP.
 * No automatic retry when an existing or newly attempted send is unknown. */
export async function recoverNewReply(database:string,http:DiscordChannelClient,input:NewReply,report:(error:NewReplyAcknowledgementError)=>void,signal?:AbortSignal):Promise<void>{
 signal?.throwIfAborted();requireDiscordText(database);
 if(typeof report!=='function'||types.isProxy(report)||types.isAsyncFunction(report)||types.isGeneratorFunction(report))throw new TypeError('Expected synchronous acknowledgement reporter');
 Object.getOwnPropertyDescriptor(DiscordChannelClient.prototype,'activeRequests')!.get!.call(http);
 if(boundedSerdeByteCount(input,1048576)===null)throw new RangeError('New reply recovery record exceeds budget');
 const record=cloneOwnedSerdeValue(input) as NewReply,id=parseNewReplyIdentity(serializeSerdeValue(record.identity));
 if(typeof record.confirmationDelivered!=='boolean'||typeof record.acknowledgementRecoveryAllowed!=='boolean'||typeof record.warningDue!=='bigint')throw new TypeError('Invalid new reply recovery flags');
 if(!record.confirmationDelivered&&id.kind==='message'&&await state.newReplyAcknowledgementSendable(database,record)){
  const source=channel(id.event_id),origin=channel(id.origin_channel_id);
  try{await deliverMessageReplyText(database,http,origin,source,'ActionResult',id.acknowledgement,signal);}
  catch(cause){signal?.throwIfAborted();invokeSynchronousVoid(report,{},[new NewReplyAcknowledgementError(id.job_id,cause)]);}
 }
 signal?.throwIfAborted();
 if(record.warningDue===1n){
  const origin=channel(id.origin_channel_id),transport={sendValidated:(request:Parameters<DiscordChannelClient['sendValidated']>[0])=>DiscordChannelClient.prototype.sendValidated.call(http,request,signal)};
  await sendReceiptChunk(database,transport,origin,{domain:'new/verification-notice/v1',logicalKey:id.job_id,chunkIndex:0,content:newReplyWarningText(record)},[],null,signal);
 }
}
