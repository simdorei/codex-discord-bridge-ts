import {types} from "node:util";
import {StateAccessFacade as state} from "../../store/state-access-facade.ts";
import type {PendingCommentary} from "../../store/commentary-outbox.ts";
import {requireDiscordText} from "../../discord/text.ts";
import {CompletionHeldError,CompletionDeliveryError,type DiscordReceiptTransport} from "./receipt-sender.ts";
import {commentaryIdentity} from "./delivery-identity.ts";
import {commentaryMessage} from "./message.ts";
import {sendCompletionText,attemptAllFinals} from "./final-delivery.ts";
function snapshot(input:PendingCommentary):PendingCommentary{
  if(input===null||typeof input!=="object"||types.isProxy(input))throw new TypeError("Expected stored commentary");
  const field=(key:string):unknown=>{const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own commentary field");return d.value;};
  const text=(v:unknown):string=>{requireDiscordText(v);return v;};
  const integer=(v:unknown):bigint=>{if(typeof v!=="bigint"||v<-(1n<<63n)||v>=(1n<<63n))throw new TypeError("Expected i64 commentary field");return v;};
  return {sequence:integer(field("sequence")),jobId:text(field("jobId")),threadId:text(field("threadId")),turnId:text(field("turnId")),channelId:integer(field("channelId")),text:text(field("text"))};
}
/** Source order uses separate owned reads, then a receipt writer revalidates the claim. */
export async function ensureFirstReply(path:string,job:string):Promise<void>{
  requireDiscordText(job);const reason=await state.newReplyOutputHold(path,job);if(reason!==null)throw new CompletionHeldError(reason);
  const request=await state.pendingFirstReply(path,job);if(request!==null)throw new CompletionDeliveryError(`output saved; first reply is not confirmed for ${request}. No output POST attempted; inspect the saved request if its reply failed`);
}
export async function ensureDeliveryOrder(path:string,job:string,before:bigint|null):Promise<void>{
  await ensureFirstReply(path,job);
  if(await state.hasPendingCommentary(path,job,before))throw new CompletionDeliveryError("output saved behind earlier undelivered progress; no output POST attempted");
}
export async function deliverCommentary(path:string,input:PendingCommentary,transport:DiscordReceiptTransport):Promise<void>{
  const pending=snapshot(input);
  await ensureDeliveryOrder(path,pending.jobId,pending.sequence);
  await sendCompletionText(path,transport,pending.channelId,commentaryIdentity(pending.threadId,pending.turnId,pending.text),commentaryMessage(pending.text),{jobId:pending.jobId,threadId:pending.threadId,turnId:pending.turnId});
  await state.completeCommentary(path,pending.sequence);
}
/** Continue unrelated jobs after an error; later same-job entries remain behind the failed one. */
export async function deliverPendingCommentary(path:string,transport:DiscordReceiptTransport):Promise<void>{
  await attemptAllFinals(await state.pendingCommentary(path),pending=>deliverCommentary(path,pending,transport));
}
