import {NativeProgressStateOwner} from './native-progress-state.ts';
import {types} from "node:util";
import {StateAccessFacade as state} from "../../store/state-access-facade.ts";
import type {PendingGoalProgress} from "../../store/goal-progress.ts";
import {requireDiscordText} from "../../discord/text.ts";
import {CompletionDeliveryError,type DiscordReceiptTransport} from "./receipt-sender.ts";
import {goalProgressIdentity} from "./delivery-identity.ts";
import {ensureFirstReply} from "./commentary-delivery.ts";
import {sendCompletionText,validateCompletionChannel,attemptAllFinals,type CompletionFailureRenderer} from "./final-delivery.ts";
function snapshot(input:PendingGoalProgress):PendingGoalProgress{
  if(input===null||typeof input!=="object"||types.isProxy(input))throw new TypeError("Expected saved Goal progress");
  const field=(key:string):unknown=>{const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own Goal progress field");return d.value;};
  const text=(v:unknown):string=>{requireDiscordText(v);return v;};
  const job=field("jobId"),channel=field("channel");if(typeof channel!=="bigint"||channel<-(1n<<63n)||channel>=(1n<<63n))throw new TypeError("Expected i64 Goal channel");
  return {jobId:job===null?null:text(job),thread:text(field("thread")),turn:text(field("turn")),channel,content:text(field("content")),lastError:text(field("lastError"))};
}
/** Source records only send-stage failures, including a late Held. Preflight failures stay untouched. */
export async function deliverGoalProgress(path:string,input:PendingGoalProgress,transport:DiscordReceiptTransport,failures:CompletionFailureRenderer,native=false):Promise<void>{
  const pending=snapshot(input);
  if(pending.jobId===null)throw new CompletionDeliveryError("legacy goal progress has no durable request identity; saved for review without sending");
  if(typeof native!=="boolean")throw new TypeError("Expected native progress profile");
  const owner=native?new NativeProgressStateOwner(path,{kind:"Goal",job:pending.jobId,thread:pending.thread,turn:pending.turn}):undefined;
  try{
  if(owner)await owner.ensure();else await ensureFirstReply(path,pending.jobId);
  const identity=goalProgressIdentity(pending.thread,pending.turn);
  validateCompletionChannel(pending.channel);
  try{await sendCompletionText(path,transport,pending.channel,identity,pending.content,{jobId:pending.jobId,threadId:pending.thread,turnId:pending.turn},native);}
  catch(error){const display=failures.render(error,Object.freeze({deliveryId:identity.logicalKey,stage:"goal-send"}));requireDiscordText(display);if(owner)await owner.recordFailure(display);else await state.recordGoalProgressError(path,pending,display);throw error;}
  if(owner)await owner.complete();else await state.completeGoalProgress(path,pending);
  }finally{await owner?.close();}
}
/** Recovery utility, not an installed runtime scheduler. */
export async function recoverGoalProgress(path:string,transport:DiscordReceiptTransport,failures:CompletionFailureRenderer):Promise<void>{
  await attemptAllFinals(await state.pendingGoalProgress(path),pending=>deliverGoalProgress(path,pending,transport,failures));
}
