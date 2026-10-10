import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {steerTurn, interruptTurn} from '../../app-server/requests.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {snapshotBusyChoice, type BusyChoice} from '../../store/busy-choice.ts';
import type {BusyAction} from '../../discord/components.ts';
import {isProCommand} from '../../pro/prompt.ts';
import {ControlTurnVerifier} from '../action-executor/control-turn.ts';
import {BusyComponentError} from './busy-errors.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
async function beforeDispatch<T>(operation: () => Promise<T> | T): Promise<T> {
  try {return await operation();} catch (error) {throw new BusyComponentError('ControlNotDispatched', passiveErrorText(error, 'control preflight failed'));}
}
/** Non-Queue busy action only. The caller has claimed the original busy choice
 * and keeps it through uncertainty. Ignore is local; no target is discovered or
 * resumed. Shared ControlTurnVerifier locks serialize exact target controls. */
export async function executeBusyAction(input: BusyChoice, action: BusyAction, server: PortableResidentLifecycle, database: string,
  verifier: ControlTurnVerifier, now: () => number = systemNow): Promise<void> {
  const choice = snapshotBusyChoice(input);
  if (action === 'Ignore') return;
  if (action !== 'Steer' && action !== 'Stop') throw new TypeError('Queue acceptance belongs to the atomic enqueue branch');
  if (action === 'Steer' && isProCommand(choice.prompt)) throw new BusyComponentError('ControlNotDispatched', 'Pro requests cannot be steered; choose Queue next to run Pro connection checks');
  const thread = choice.targetThreadId; if (thread === null) throw new BusyComponentError('NoTarget');
  const lease = await beforeDispatch(() => ControlTurnVerifier.prototype.lock.call(verifier, thread));
  try {
    const expected = await beforeDispatch(() => state.resolveBusyControl(database, choice.choiceId, thread));
    if (expected === null) throw new BusyComponentError('ControlNotDispatched', 'this choice has no confirmed original turn yet; retry when its preceding task starts, or send a new request');
    const channel = await beforeDispatch(() => {if (choice.channelId < 0n) throw new RangeError('out of range integral type conversion attempted'); return choice.channelId;});
    const [turn, generation] = await beforeDispatch(() => ControlTurnVerifier.prototype.control.call(verifier, channel, thread, expected));
    if (action === 'Steer') await beforeDispatch(() => state.recordUserOrigin(database, thread, turn, choice.prompt, readCustodyTimestamp(now)));
    try {await PortableResidentLifecycle.prototype.execute.call(server, action === 'Steer' ? steerTurn(thread, choice.prompt, turn) : interruptTurn(thread, turn), generation);}
    catch (error) {throw new BusyComponentError('AppServer', error);}
  } finally {lease.release();}
}
