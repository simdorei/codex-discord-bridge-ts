import {StateAccessFacade as state} from "../../../store/state-access-facade.ts";
import type {CompletionEntry} from "../../../store/completion-metadata.ts";
import type {StoredAsyncQuestion} from "../../../store/async-question-read.ts";
import {QueueIntegerRangeError} from "../../queue-runner/errors.ts";
import {deliverCommentary} from "../commentary-delivery.ts";
import {deliverGoalProgress} from "../goal-delivery.ts";
import {deliverFinal,type FinalDeliveryOptions} from "../final-delivery.ts";
import {deliverStartNotice} from "../pending-delivery.ts";
import type {DiscordReceiptTransport} from "../receipt-sender.ts";
export interface CompletionResidentIdentity{instanceId():string;generation():bigint}
/** REQUIRED checked UI adapter: must validate the original occurrence/current generation
 * and receipt claim before any send. No unchecked/default question sender is supplied. */
export interface CheckedQuestionDelivery{deliverChecked(path:string,currentGeneration:bigint,transport:DiscordReceiptTransport,question:StoredAsyncQuestion):Promise<void>}
/** Called by a separately channel-serialized HTTP lane. Loading is revalidated metadata,
 * not send authority; each branch retains its own writer/preflight and receipt guards. */
export async function deliverCompletionEntry(path:string,input:CompletionEntry,resident:CompletionResidentIdentity,options:FinalDeliveryOptions,questions:CheckedQuestionDelivery):Promise<void>{
  const fixed:FinalDeliveryOptions={transport:options.transport,failures:options.failures,now:options.now},checked=questions.deliverChecked.bind(questions);
  const runtime=resident.instanceId(),generation=resident.generation();if(typeof generation!=="bigint"||generation<0n||generation>=(1n<<63n))throw new QueueIntegerRangeError();
  const payload=await state.loadCompletionPayload(path,input,runtime,generation);if(payload===null)return;
  switch(payload.kind){
    case "Commentary":await deliverCommentary(path,payload.value,fixed.transport);return;
    case "Goal":await deliverGoalProgress(path,payload.value,fixed.transport,fixed.failures);return;
    case "Final":await deliverFinal(path,payload.value,fixed);return;
    case "StartFailure":await deliverStartNotice(path,payload.value,fixed.transport);return;
    case "Question":{
      const current=resident.generation();if(typeof current!=="bigint"||current<0n||current>=(1n<<64n))throw new QueueIntegerRangeError();
      await checked(path,current,fixed.transport,payload.value);return;
    }
    case "Observed":return;
  }
}
