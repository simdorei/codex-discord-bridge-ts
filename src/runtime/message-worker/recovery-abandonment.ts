import {randomUUID} from 'node:crypto';
import {AdmissionPermit} from '../../admission/drain-gate.ts';
import {isDecodedGatewayMessage,type DecodedGatewayMessage} from '../../discord/gateway/decoded-message.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {abandonmentDecisionRows,serializeDiscordComponent} from '../../discord/components.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {StoreIntegrityError} from '../../store/schema-assembly.ts';
import {receiptHash} from '../../store/delivery-receipt-key.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {serdeField} from '../../app-server/value.ts';
import {ControlTurnVerifier} from '../action-executor/control-turn.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {sendReceiptChunk} from '../completion/receipt-sender.ts';
const DOMAIN='recovery-abandonment-proposal-v1';
function invalid(reason:string):never{throw new StoreIntegrityError(`saved-request proposal held: ${reason}`);}
function sql(value:bigint):bigint{if(typeof value!=='bigint'||value<=0n||value>=1n<<63n)throw new StoreIntegrityError('Discord ID exceeds SQLite range');return value;}
/** Authenticated proposal producer only. No queue execution, cancellation or
 * native approval occurs. Permit and shared target lease survive every await. */
export async function proposeMessageAbandonment(message:DecodedGatewayMessage,job:string,permit:AdmissionPermit|null,database:string,
 applicationId:bigint,http:DiscordChannelClient,verifier:ControlTurnVerifier,now:()=>number=systemNow):Promise<void>{
 if(!isDecodedGatewayMessage(message))throw new TypeError('Expected decoded gateway message');requireDiscordText(database);requireDiscordText(job);
 let owned:AdmissionPermit;try{if(permit===null)return invalid('proposal requires live normal admission');owned=AdmissionPermit.prototype.clone.call(permit);}catch{return invalid('proposal requires live normal admission');}
 try{
  const author=message.author as {id:bigint;bot:boolean};if(author.bot)return invalid('proposal requires the original human owner');
  const channel=sql(message.channel_id),owner=sql(author.id),event=sql(message.id);sql(applicationId);
  const target=state.abandonmentCommandTarget(database,job,channel,owner),lockAbort=new AbortController(),lockTimer=setTimeout(()=>lockAbort.abort(),2000);let lease;
  try{lease=await ControlTurnVerifier.prototype.lock.call(verifier,target,lockAbort.signal);}catch(error){if(lockAbort.signal.aborted)return invalid('proposal target is busy; no decision was recorded');throw error;}finally{clearTimeout(lockTimer);}
  try{
   if(state.abandonmentCommandTarget(database,job,channel,owner)!==target)return invalid('proposal target changed while waiting for the lock');
   const ingress=`message:${event}`,saved=await state.getIngress(database,ingress);if(saved===null)return invalid('proposal ingress is unavailable');
   if(saved.eventId!==event||saved.sourceMessageId!==event||saved.applicationId!==null||saved.channelId!==channel||saved.ownerUserId!==owner||saved.targetThreadId!==target||serdeField(saved.payload,'content')!==message.content||serdeField(saved.payload,'processing_mode')!=='normal')return invalid('proposal differs from its frozen authenticated ingress');
   const at=readCustodyTimestamp(now),proposal=state.proposeAbandonment(database,{proposal_id:randomUUID().replaceAll('-',''),job_id:job,ingress_id:ingress,application_id:applicationId,now:at,expires_at:at+120});
   const components=abandonmentDecisionRows(proposal.id,proposal.revision),logicalKey=`${proposal.id}:${proposal.revision}`,deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),10000);
   const transport=Object.freeze({sendValidated:(request:Parameters<DiscordChannelClient['sendValidated']>[0])=>DiscordChannelClient.prototype.sendValidated.call(http,request,deadline.signal)});
   try{await sendReceiptChunk(database,transport,channel,{domain:DOMAIN,logicalKey,chunkIndex:0,content:proposal.review_text},components);if(deadline.signal.aborted)return invalid('proposal delivery is unconfirmed; no automatic resend');}
   catch(error){if(deadline.signal.aborted)return invalid('proposal delivery is unconfirmed; no automatic resend');throw error;}finally{clearTimeout(timer);}
   const key=serializeSerdeValue([channel,DOMAIN,logicalKey,0n]),hash=receiptHash(`[${JSON.stringify(proposal.review_text)},[${components.map(serializeDiscordComponent).join(',')}]]`),receipt=await state.beginDeliveryReceipt(database,key,hash);
   if(receipt.kind!=='Delivered')return invalid('proposal has no confirmed exact message receipt');
   const matched=/^[+-]?[0-9]+/u.exec(receipt.messageId);if(matched===null||matched[0]!==receipt.messageId)return invalid('proposal receipt identity is invalid');const sent=BigInt(receipt.messageId);if(sent<-(1n<<63n)||sent>=1n<<63n)return invalid('proposal receipt identity is invalid');
   state.bindAbandonmentDelivery(database,proposal.id,sent,proposal.review_sha256,readCustodyTimestamp(now));
   await state.recordIngressResult(database,ingress,{kind:'abandonment_proposal',proposal_id:proposal.id,revision:proposal.revision,decision_recorded:false,request_started:false},readCustodyTimestamp(now));
  }finally{lease.release();}
 }finally{AdmissionPermit.prototype.release.call(owned);}
}
