import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {frozenSlashTarget} from '../../store/ingress-new-input.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {snapshotActionResult, type ActionResult} from '../action-result.ts';
import {ActionThreadSelection} from './thread-selection.ts';
import {ActionTargetServices} from './action-target.ts';
import {BusyResultProducer} from './busy-result.ts';
import {PromptIntakeProcessor} from '../prompt-intake/processor.ts';
import {QueueStartCoordinator} from '../queue-runner/start-coordinator.ts';
import {submissionResult} from './submission-result.ts';
import {ActionIntegerRangeError, InvalidActionRequestError} from './errors.ts';
import {INTERVIEW_HEADER} from './interview-header.ts';
function u64(value:bigint):void {if(typeof value!=='bigint'||value<0n||value>=(1n<<64n))throw new TypeError('Expected u64 identity');}
function i64(value:bigint):bigint {if(value>=(1n<<63n))throw new ActionIntegerRangeError();return value;}
/** Source queue_prompt ordering: original route fence, saved replay, canonical
 * target, optional busy choice, then durable intake. No New/thread-start path. */
export class QueuePromptExecutor {
 readonly #database:string;readonly #selection:ActionThreadSelection;readonly #targets:ActionTargetServices;readonly #queue:QueueStartCoordinator;readonly #intake:PromptIntakeProcessor;readonly #busy:BusyResultProducer;
 constructor(database:string,selection:ActionThreadSelection,targets:ActionTargetServices,queue:QueueStartCoordinator,intake:PromptIntakeProcessor,busy:BusyResultProducer){requireDiscordText(database);this.#database=database;this.#selection=selection;this.#targets=targets;this.#queue=queue;this.#intake=intake;this.#busy=busy;Object.freeze(this);}
 async queuePrompt(channel:bigint,user:bigint,event:bigint|null,autoQueueWhenBusy:boolean,prompt:string,signal?:AbortSignal):Promise<ActionResult>{
  u64(channel);u64(user);if(event!==null)u64(event);requireDiscordText(prompt);if(typeof autoQueueWhenBusy!=='boolean')throw new TypeError('Expected queue policy');signal?.throwIfAborted();
  const [thread,source]=await this.#selection.target(channel);signal?.throwIfAborted();
  if(event!==null){const ingress=await state.ingressByOrigin(this.#database,i64(event));signal?.throwIfAborted();
   if(ingress!==null){const original=frozenSlashTarget(ingress);if(original!==null&&(original!==thread||source!=='mirror'||ingress.channelId!==i64(channel)||ingress.ownerUserId!==i64(user)))throw new InvalidActionRequestError('original slash prompt target changed; no request or busy choice was created');}
   const replay=await this.#queue.replaySubmissionForMessage(event);signal?.throwIfAborted();if(replay!==null)return snapshotActionResult(submissionResult(thread,source,replay,prompt));
  }
  const canonical=await this.#targets.canonicalizeCompletedTarget(thread);signal?.throwIfAborted();
  if(!autoQueueWhenBusy){const status=await this.#queue.reads.busyStatus(canonical,signal);signal?.throwIfAborted();if(status.busy)return this.#busy.busyResult(canonical,channel,user,prompt,status.allowSteer,source==='mirror',signal);}
  return snapshotActionResult(await this.#intake.admitPrompt({targetThreadId:canonical,source,channelId:channel,userId:user,discordMessageId:event,autoQueueWhenBusy,rawPrompt:prompt},signal));
 }
 interview(channel:bigint,user:bigint,event:bigint|null,autoQueueWhenBusy:boolean,prompt:string,signal?:AbortSignal):Promise<ActionResult>{requireDiscordText(prompt);return this.queuePrompt(channel,user,event,autoQueueWhenBusy,INTERVIEW_HEADER+prompt,signal);}
}
Object.freeze(QueuePromptExecutor.prototype);
