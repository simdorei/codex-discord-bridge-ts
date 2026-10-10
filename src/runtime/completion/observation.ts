import {StateAccessFacade as state} from "../../store/state-access-facade.ts";
import {extractCompletedFinalAnswer,parseTurnCompletion,completionJournalPayload} from "../../app-server/outcomes.ts";
import {cloneOwnedSerdeValue} from "../../core/owned-serde-value.ts";
import {serializeSerdeValue} from "../../core/serde-json.ts";
import type {ResidentNotificationEvent} from "../../app-server/resident-forwarders.ts";
import {QueueIntegerRangeError} from "../queue-runner/errors.ts";
import {I64_MAX} from "../../protocol/ids.ts";
/** Exact live-resident producer only. Caller must receive from its owning native
 * subscription. Recovery/history JSON must never be routed here to mint provenance.
 * Await persistence before confirming any observation prefix or scheduling delivery.
 * Source report/logging is handled by the caller's central error/report boundary. */
export async function observeCompletionTerminal(path:string,resident:string,input:ResidentNotificationEvent):Promise<void>{
  const event=cloneOwnedSerdeValue(input) as ResidentNotificationEvent;if(event.kind==="Gap")return;
  if(event.kind!=="Notification")throw new TypeError("Expected native notification event");
  const {generation,notification}=event;if(typeof generation!=="bigint"||generation<0n||generation>I64_MAX)throw new QueueIntegerRangeError();
  if(notification.method==="item/completed"){
    const answer=extractCompletedFinalAnswer(notification.params);if(answer!==null)await state.recordObservedFinalAnswer(path,answer.threadId,answer.turnId,generation,answer.text);return;
  }
  if(notification.method!=="turn/completed")return;
  const completion=parseTurnCompletion(notification.params,false);await state.recordObservedCompletionForResident(path,completion.threadId,completion.turnId,generation,serializeSerdeValue(completionJournalPayload(completion)),resident);
}
