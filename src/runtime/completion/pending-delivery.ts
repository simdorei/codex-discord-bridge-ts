import {StateAccessFacade as state} from "../../store/state-access-facade.ts";
import {START_NOTICE_DOMAIN,type StartNotice} from "../../store/start-notice-outbox.ts";
import {sendReceiptChunk,type DiscordReceiptTransport} from "./receipt-sender.ts";
import {attemptAllFinals,deliverFinal,validateCompletionChannel,type FinalDeliveryOptions} from "./final-delivery.ts";
import {deliverPendingCommentary} from "./commentary-delivery.ts";
/** No turn is invented; the receipt writer rechecks exact held no-turn custody. */
export async function deliverStartFailures(path:string,transport:DiscordReceiptTransport):Promise<void>{
  await attemptAllFinals(await state.pendingStartNotices(path),notice=>deliverStartNotice(path,notice,transport));
}
type Result={ok:true}|{ok:false;error:unknown};
async function settle(operation:()=>Promise<void>):Promise<Result>{try{await operation();return {ok:true};}catch(error){return {ok:false,error};}}
/** Source batch precedence: start -> commentary -> finals, but final-list read failure
 * returns immediately. All three delivery batches are attempted despite earlier errors.
 * No periodic scheduler or logger is installed by this function. */
export async function deliverPendingOutputs(path:string,options:FinalDeliveryOptions):Promise<void>{
  const fixed:FinalDeliveryOptions={transport:options.transport,failures:options.failures,now:options.now};
  const starts=await settle(()=>deliverStartFailures(path,fixed.transport));
  const commentary=await settle(()=>deliverPendingCommentary(path,fixed.transport));
  const pending=await state.listPendingDeliveries(path);
  const finals=await settle(()=>attemptAllFinals(pending,item=>deliverFinal(path,item,fixed)));
  for(const result of [starts,commentary,finals])if(!result.ok)throw result.error;
}

/** Capture an owned typed notice before any asynchronous receipt operation. */
export async function deliverStartNotice(path:string,notice:StartNotice,transport:DiscordReceiptTransport):Promise<void>{
  const channel=notice.channelId,job=notice.jobId,content=notice.content;
  validateCompletionChannel(channel);
  await sendReceiptChunk(path,transport,channel,{domain:START_NOTICE_DOMAIN,logicalKey:job,chunkIndex:0,content});
  await state.completeStartNotice(path,job);
}
