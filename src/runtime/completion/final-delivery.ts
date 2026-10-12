import {NativeFinalStateOwner} from './native-final-state.ts';
import type {DeliveryGuard} from "../../store/delivery-receipt-key.ts";
import {StateAccessFacade as state} from "../../store/state-access-facade.ts";
import {snapshotStoredDelivery,type StoredDelivery} from "../../store/delivery.ts";
import {requireDiscordText,splitDeliveryChunks} from "../../discord/text.ts";
import {idempotentMessageRequestWithComponents} from "../../discord/idempotent-message.ts";
import {DeliveryFailure} from "../../discord/delivery.ts";
import {deliverIdempotentChunks,outboxIdentity,type CompletionDeliveryIdentity} from "./delivery-identity.ts";
import {sendReceiptChunk,CompletionHeldError,CompletionDeliveryError,isCompletionHeld,type DiscordReceiptTransport} from "./receipt-sender.ts";

export interface CompletionFailureContext {readonly deliveryId:string;readonly stage:"preflight-or-send"|"goal-send"}
/** Central diagnostic adapter is mandatory: it must be synchronous, passive and public-safe.
 * Exact Rust Display/Debug formatting is not implemented by this orchestration module. */
export interface CompletionFailureRenderer {render(error:unknown,context:CompletionFailureContext):string}
export interface FinalDeliveryOptions {
  readonly transport:DiscordReceiptTransport;
  /** Explicit native completion profile: receipt and Final state owners are joined. */
  readonly nativeReceipts?:boolean;
  readonly failures:CompletionFailureRenderer;
  /** Unix seconds, sampled only for failures that are not Held. */
  readonly now:()=>number;
}
export class CompletionChannelIdError extends Error{
  constructor(){super("Discord channel identifier does not fit the unsigned contract");this.name="CompletionChannelIdError";}
}
/** Preserves partial-chunk metadata and raw cause for the central diagnostic adapter. */
export class CompletionChunkFailure extends Error{
  readonly failure:DeliveryFailure;
  constructor(failure:DeliveryFailure){super("Discord final chunk delivery failed",{cause:failure});this.name="CompletionChunkFailure";this.failure=failure;}
}
/** Borrow no read snapshot across transport awaits. Await ownership through receipt commit.
 * No retry timers, background work, runtime scheduling or native transport are installed. */
export async function deliverFinal(path:string,input:StoredDelivery,options:FinalDeliveryOptions):Promise<void>{
  const pending=snapshotStoredDelivery(input),transport=options.transport,failures=options.failures,now=options.now,native=options.nativeReceipts??false;if(typeof native!=="boolean")throw new TypeError("Expected native receipt profile flag");
  let owner:NativeFinalStateOwner|undefined;
  try{
   try{
    if(native)owner=new NativeFinalStateOwner(path,pending);
    const chunks=confirmedChunks(pending);
    if(chunks!==null&&(owner?await owner.confirmed(chunks):state.completeConfirmedDelivery(path,pending,chunks)))return;
    const readiness=owner?await owner.preflight():state.finalDeliveryPreflight(path,pending);
    switch(readiness.kind){
      case "Held":throw new CompletionHeldError(readiness.reason);
      case "FirstReply":throw new CompletionDeliveryError(`output saved; first reply is not confirmed for ${readiness.request}. No output POST attempted; inspect the saved request if its reply failed`);
      case "Commentary":throw new CompletionDeliveryError("output saved behind earlier undelivered progress; no output POST attempted");
      case "GoalProgress":throw new CompletionDeliveryError("final saved behind undelivered goal progress; no final POST attempted");
      case "Ready":break;
    }
    const guard=Object.freeze({jobId:pending.jobId,threadId:pending.targetThreadId,turnId:pending.turnId});
    await sendCompletionText(path,transport,pending.channelId,outboxIdentity(pending.deliveryId),pending.content,guard,native);
  }catch(error){
    if(isCompletionHeld(error))throw error;
    const timestamp=now();
    if(typeof timestamp!=="number"||!Number.isFinite(timestamp)||timestamp<0)throw new RangeError("Expected finite Unix failure timestamp");
    const display=failures.render(error,Object.freeze({deliveryId:pending.deliveryId,stage:"preflight-or-send"}));requireDiscordText(display);
    if(native){owner??=new NativeFinalStateOwner(path,pending);await owner.recordFailure(display,timestamp);}
    else await state.recordDeliveryFailure(path,pending.deliveryId,display,timestamp);
    throw error;
  }
  // Source phase-1 ignores false; deletion failure is not recorded as a send failure.
  if(owner)await owner.complete();else await state.completeDelivery(path,pending.deliveryId);
  }finally{await owner?.close();}
}
/** Each final is awaited even after failure; undefined can itself be a thrown value. */
export async function attemptAllFinals<T>(items:Iterable<T>,attempt:(item:T)=>Promise<void>):Promise<void>{
  let failed=false,first:unknown;
  for(const item of items){try{await attempt(item);}catch(error){if(!failed){failed=true;first=error;}}}
  if(failed)throw first;
}

/** Shared source send_idempotent_text boundary for final and progress delivery. */
export async function sendCompletionText(path:string,transport:DiscordReceiptTransport,channel:bigint,identity:CompletionDeliveryIdentity,text:string,guard:DeliveryGuard,native=false):Promise<void>{
  validateCompletionChannel(channel);
  const fixedGuard=Object.freeze({jobId:guard.jobId,threadId:guard.threadId,turnId:guard.turnId});
  try{await deliverIdempotentChunks(text,{retryDelaysMs:[],chunkMarkers:true},identity,chunk=>sendReceiptChunk(path,transport,channel,chunk,[],fixedGuard,undefined,native));}
  catch(error){if(error instanceof DeliveryFailure){if(isCompletionHeld(error.source))throw error.source;throw new CompletionChunkFailure(error);}throw error;}
}

export function validateCompletionChannel(channel:bigint):void{if(typeof channel!=="bigint"||channel<=0n||channel>=(1n<<63n))throw new CompletionChannelIdError();}

/** Current Rust main: only normally rendered/validated chunks reach the store fast path. */
function confirmedChunks(pending:StoredDelivery):string[]|null{
  if(pending.channelId<=0n||pending.channelId>=(1n<<63n))return null;
  const identity=outboxIdentity(pending.deliveryId),chunks=splitDeliveryChunks(pending.content,true);
  for(const[index,chunk]of chunks.entries()){try{idempotentMessageRequestWithComponents(pending.channelId,chunk,[],identity.domain,identity.logicalKey,index);}catch{return null;}}
  return chunks;
}
