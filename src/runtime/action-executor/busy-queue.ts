import {types} from 'node:util';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {snapshotBusyChoice, type BusyChoice} from '../../store/busy-choice.ts';
import type {StoredPromptIntake} from '../../store/prompt-intake.ts';
import {snapshotActionResult, type ActionResult} from '../action-result.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {busyReadyMarker} from '../component-worker/confirmation.ts';
import {ActionExecutionError} from './action-error.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
export interface AdmittedBusyPromptProcessor {processAdmittedPrompt(intake: StoredPromptIntake): Promise<ActionResult>}
/** Atomic intake and confirmation receipt are committed by admitBusyQueue before
 * prompt preparation. Do not preclaim busy_choices or retry a returned receipt. */
export class BusyQueueExecutor {
  readonly #admit:typeof state.admitBusyQueue;readonly #mapping:typeof state.mirroredThreadId;
  readonly #database: string; readonly #receiver: AdmittedBusyPromptProcessor; readonly #process: Function; readonly #now: () => number;
  constructor(database: string, processor: AdmittedBusyPromptProcessor, now: () => number = systemNow, admit:typeof state.admitBusyQueue=state.admitBusyQueue, mapping:typeof state.mirroredThreadId=state.mirroredThreadId) {
    requireDiscordText(database); const process = gatewayOwnField(processor, 'processAdmittedPrompt');
    if (typeof process !== 'function' || types.isProxy(process) || types.isGeneratorFunction(process)) throw new TypeError('Expected admitted prompt processor');
    if (typeof now !== 'function' || types.isProxy(now) || types.isAsyncFunction(now) || types.isGeneratorFunction(now)) throw new TypeError('Expected synchronous busy queue clock');
    if(typeof admit!=='function'||types.isProxy(admit)||types.isGeneratorFunction(admit))throw new TypeError('Expected owned busy admission function');this.#admit=admit;
    if(typeof mapping!=='function'||types.isProxy(mapping)||types.isGeneratorFunction(mapping))throw new TypeError('Expected owned mirror lookup function');this.#mapping=mapping;
    this.#database = database; this.#receiver = processor; this.#process = process; this.#now = now; Object.freeze(this);
  }
  async enqueueBusyChoice(input: BusyChoice): Promise<ActionResult> {
    const choice = snapshotBusyChoice(input), target = choice.targetThreadId;
    if (target === null) throw new ActionExecutionError('NoTarget');
    let mapped: boolean;
    try {const pending=Reflect.apply(this.#mapping,undefined,[this.#database,choice.channelId]);if(!types.isPromise(pending))throw new TypeError('Expected native mirror lookup Promise');mapped = await pending !== null;}
    catch (error) {throw new ActionExecutionError('Store', error);}
    if (choice.channelId < 0n || choice.ownerUserId < 0n) throw new ActionExecutionError('IntegerRange');
    let now: number; try {now = readCustodyTimestamp(this.#now);} catch (error) {throw new ActionExecutionError('SystemTime', error);}
    let admission: Awaited<ReturnType<typeof state.admitBusyQueue>>;
    try {const pending=Reflect.apply(this.#admit,undefined,[this.#database,choice,target,mapped,busyReadyMarker(choice.choiceId,choice.ownerUserId,choice.channelId),now]);if(!types.isPromise(pending))throw new TypeError('Expected native busy admission Promise');admission=await pending as typeof admission;}
    catch (error) {throw new ActionExecutionError('Store', error);}
    if (admission.intake === null) return snapshotActionResult({text: `This busy request was already accepted; no duplicate was queued.\njob_id: ${admission.jobId}`, waitsForFinal: false, ui: null});
    const pending = Reflect.apply(this.#process, this.#receiver, [admission.intake]);
    if (!types.isPromise(pending)) throw new TypeError('Expected native prompt-processing Promise');
    return snapshotActionResult(await pending as ActionResult);
  }
}
