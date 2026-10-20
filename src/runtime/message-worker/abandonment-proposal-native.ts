import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {AdmissionPermit} from '../../admission/drain-gate.ts';
import {isDecodedGatewayMessage,type DecodedGatewayMessage} from '../../discord/gateway/decoded-message.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {abandonmentDecisionRows,serializeDiscordComponent} from '../../discord/components.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {receiptHash} from '../../store/delivery-receipt-key.ts';
import {ControlTurnVerifier} from '../action-executor/control-turn.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {OwnedWorkerSlot} from '../owned-worker-slot.ts';
import {NativeCompletionReceiptStore} from '../completion/native-receipt-store.ts';
import {sendReceiptChunkWithPersistence} from '../completion/receipt-sender.ts';
import {OriginalMessageJournal} from './journal.ts';
import {captureProposalOriginal,captureProposal,proposalBinding,proposalFields,proposalText,proposalId,ABANDONMENT_PROPOSAL_REPLY_BYTES,type ProposalOriginal,type ProposalOperation} from './abandonment-proposal-protocol.ts';
const proposalFailures=new WeakSet<object>();
/** Only failures from an owned native proposal suppress another-key ERROR delivery. */
export function isNativeAbandonmentProposalFailure(value:unknown):boolean{return value!==null&&(typeof value==='object'||typeof value==='function')&&proposalFailures.has(value);}
export class NativeAbandonmentProposalUnknownError extends Error{
 readonly operation:ProposalOperation;
 constructor(operation:ProposalOperation,cause:unknown){super('Original abandonment proposal outcome unconfirmed after native exit; no automatic proposal, send or binding retry',{cause});this.name='NativeAbandonmentProposalUnknownError';this.operation=operation;}
}
function checkSignal(signal:AbortSignal|undefined):void{if(signal!==undefined&&(types.isProxy(signal)||Object.getPrototypeOf(signal)!==AbortSignal.prototype||['aborted','reason','throwIfAborted','addEventListener','removeEventListener'].some(key=>Object.hasOwn(signal,key))))throw new TypeError('Expected unmodified native AbortSignal');signal?.throwIfAborted();}
/** One private original admitted message, one proposal UUID, and one complete
 * route/lease/prepare/receipt/bind/result lifetime. There is no exposed Bind or
 * completion handle. A classifier's earlier route cannot authorize preparation. */
const originalOwners=new WeakSet<OriginalMessageJournal>();
export class NativeAbandonmentProposalOwner{
 readonly #original:ProposalOriginal;readonly #journal:OriginalMessageJournal;readonly #timeout:number;#started=false;#proposalSubmitted=false;
 constructor(journal:OriginalMessageJournal,database:string,message:DecodedGatewayMessage,job:string,application:bigint,timeoutMs=5000){
  if(!isDecodedGatewayMessage(message))throw new TypeError('Expected decoded original message');
  const event=own(message,'id'),channel=own(message,'channel_id'),author=own(message,'author'),actor=own(author,'id');if(own(author,'bot')!==false)throw new TypeError('Proposal requires original human owner');proposalId(event);
  const ingress=`message:${event}`,path=OriginalMessageJournal.prototype.nativePath.call(journal,database,ingress);if(path===null)throw new TypeError('Expected native original message custody');if(originalOwners.has(journal))throw new TypeError('Original proposal journal already consumed');
  this.#original=captureProposalOriginal({path,ingress,event,channel,actor,application,job,content:own(message,'content'),proposal:randomUUID().replaceAll('-','')});this.#journal=journal;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid proposal native deadline');this.#timeout=timeoutMs;originalOwners.add(journal);Object.freeze(this);
 }
 async run(permit:AdmissionPermit|null,http:DiscordChannelClient,verifier:ControlTurnVerifier,now:()=>number,signal?:AbortSignal):Promise<void>{
  if(this.#started)throw new TypeError('Original proposal already consumed or unconfirmed');this.#started=true;checkSignal(signal);
  if(typeof now!=='function'||types.isProxy(now)||types.isAsyncFunction(now)||types.isGeneratorFunction(now))throw new TypeError('Expected synchronous proposal clock');
  if(permit===null)throw new TypeError('Proposal requires live normal admission');const owned=AdmissionPermit.prototype.clone.call(permit);
  try{
   const target=await this.#run('Route',null,0,null,null,null,signal);proposalText(target,1024);if(target.length===0)throw new TypeError('Missing original proposal target');
   const lockAbort=new AbortController(),timer=setTimeout(()=>lockAbort.abort(),2000);let lease;
   try{lease=await ControlTurnVerifier.prototype.lock.call(verifier,target,signal===undefined?lockAbort.signal:AbortSignal.any([signal,lockAbort.signal]));}
   catch(error){if(signal?.aborted)throw signal.reason;if(lockAbort.signal.aborted)throw new Error('Proposal target is busy; no decision was recorded');throw error;}finally{clearTimeout(timer);}
   try{
    checkSignal(signal);const at=readCustodyTimestamp(now),raw=await this.#run('Prepare',target,at,null,null,null,signal);let proposal;
    try{proposal=captureProposal(raw,this.#original,target,at);}catch(error){throw new NativeAbandonmentProposalUnknownError('Prepare',error);}
    const components=abandonmentDecisionRows(proposal.id,proposal.revision),logicalKey=`${proposal.id}:${proposal.revision}`,domain='recovery-abandonment-proposal-v1',channel=this.#original.channel;
    const key=serializeSerdeValue([channel,domain,logicalKey,0n]),hash=receiptHash(`[${JSON.stringify(proposal.review_text)},[${components.map(serializeDiscordComponent).join(',')}]]`),receipt=new NativeCompletionReceiptStore(this.#original.path,key,hash,null,this.#timeout);
    const deadline=new AbortController(),deliveryTimer=setTimeout(()=>deadline.abort(),10000),deliverySignal=signal===undefined?deadline.signal:AbortSignal.any([signal,deadline.signal]);
    const transport=Object.freeze({sendValidated:(request:Parameters<DiscordChannelClient['sendValidated']>[0])=>DiscordChannelClient.prototype.sendValidated.call(http,request,deliverySignal)});
    let delivered:string|null;
    try{await sendReceiptChunkWithPersistence(receipt,transport,channel,{domain,logicalKey,chunkIndex:0,content:proposal.review_text},components,null,deliverySignal);delivered=NativeCompletionReceiptStore.prototype.confirmedMessageId.call(receipt,key,hash);}
    finally{clearTimeout(deliveryTimer);await NativeCompletionReceiptStore.prototype.close.call(receipt);}
    if(delivered===null||!/^[1-9][0-9]{0,18}$/.test(delivered))throw new TypeError('Proposal has no confirmed exact receipt');const sent=BigInt(delivered);proposalId(sent);
    // Confirmed delivery owns uncancelled completion through actual exit, result and finish.
    const bound=await this.#run('Bind',target,readCustodyTimestamp(now),sent,proposal.revision,proposal.review_sha256);
    if(bound!==true)throw new NativeAbandonmentProposalUnknownError('Bind',new TypeError('Missing exact binding result'));
    await OriginalMessageJournal.prototype.result.call(this.#journal,{kind:'abandonment_proposal',proposal_id:proposal.id,revision:proposal.revision,decision_recorded:false,request_started:false},readCustodyTimestamp(now));
    await OriginalMessageJournal.prototype.confirm.call(this.#journal,readCustodyTimestamp(now));
   }finally{lease.release();}
  }catch(error){if(this.#proposalSubmitted&&error!==null&&(typeof error==='object'||typeof error==='function'))proposalFailures.add(error);throw error;}finally{AdmissionPermit.prototype.release.call(owned);}
 }
 async #run(operation:ProposalOperation,target:string|null,at:number,message:bigint|null,revision:bigint|null,hash:string|null,signal?:AbortSignal):Promise<unknown>{
  checkSignal(signal);
  const binding=proposalBinding(randomUUID(),this.#original,operation,target,at,message,revision,hash),slot=new OwnedWorkerSlot('Control');let admitted=false;
  try{
   const url=new URL('./abandonment-proposal-native-worker.ts',import.meta.url),pending=operation==='Bind'?slot.runControlCompletion(url,binding,this.#timeout):slot.run(url,binding,this.#timeout,signal);admitted=slot.busy;if(operation==='Prepare'&&admitted)this.#proposalSubmitted=true;
   let raw:unknown;try{raw=await pending;}finally{await slot.join();}checkSignal(signal);
   if(boundedSerdeByteCount(raw,ABANDONMENT_PROPOSAL_REPLY_BYTES)===null)throw new RangeError('Proposal acknowledgement exceeds boundary');proposalFields(raw,[...Object.keys(binding),'ok','value']);
   for(const [key,value]of Object.entries(binding))if(!Object.is(own(raw,key),value))throw new TypeError('Crossed original proposal acknowledgement');
   if(own(raw,'ok')!==true)throw new TypeError('Unconfirmed original proposal acknowledgement');return own(raw,'value');
  }catch(error){if(admitted)throw new NativeAbandonmentProposalUnknownError(operation,error);throw error;}
 }
}
Object.freeze(NativeAbandonmentProposalOwner.prototype);
