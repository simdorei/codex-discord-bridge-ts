import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import type {ComponentId} from '../../discord/components.ts';
import {snapshotComponentId} from '../discord-dispatch/delivery-identity.ts';
import type {InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {authorizedBusyChoice, validateBusyChoice} from './busy-preflight.ts';
import {busyConfirmationPlan, busyReadyMarker, confirmationReady, recordConfirmationReady, ConfirmationError, type ConfirmationPlan} from './confirmation.ts';
import {BusyComponentError} from './busy-errors.ts';
import {retainOrReleaseBusyClaim} from './claim-failure.ts';
import {executeBusyAction} from './busy-control.ts';
import {BusyQueueExecutor} from '../action-executor/busy-queue.ts';
import type {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import type {ControlTurnVerifier} from '../action-executor/control-turn.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
async function stored<T>(run: () => Promise<T> | T): Promise<T> {try {return await run();} catch (error) {throw new BusyComponentError('Store', error);}}
async function confirmationIfReady(database: string, marker: string, now: number, plan: ConfirmationPlan): Promise<ConfirmationPlan> {
  if (!await stored(() => confirmationReady(database, marker, now))) throw new BusyComponentError('ActionUnconfirmed'); return plan;
}
/** Original pre-ACK choice only. Queue uses atomic intake+receipt without a prior
 * button claim. Other actions retain their claim unless failure is definitely
 * pre-dispatch/rejected. Caller owns ingress custody and subsequent notification. */
export async function handleBusyComponent(work: Pick<InboundInteractionWork, 'authorizedBusyChoice' | 'userId' | 'channelId'>, input: ComponentId,
  database: string, queue: BusyQueueExecutor, server: PortableResidentLifecycle, verifier: ControlTurnVerifier, now: () => number = systemNow): Promise<ConfirmationPlan> {
  const component = snapshotComponentId(input); if (!('Busy' in component)) throw new BusyComponentError('Missing');
  const {choice_id: choiceId, action} = component.Busy, choice = authorizedBusyChoice(work, choiceId);
  const user = gatewayOwnField(work, 'userId') as bigint, channel = gatewayOwnField(work, 'channelId') as bigint;
  validateBusyChoice(choice, action, user, channel);
  const at = await stored(() => readCustodyTimestamp(now)), plan = busyConfirmationPlan(choiceId), marker = busyReadyMarker(choiceId, user, channel);
  if (await stored(() => confirmationReady(database, marker, at))) return plan;
  if (action === 'Queue') {
    try {await BusyQueueExecutor.prototype.enqueueBusyChoice.call(queue, choice);} catch (error) {throw new BusyComponentError('Action', error);}
    return plan;
  }
  const current = await stored(() => state.readBusyChoiceState(database, choiceId, at));
  if (current?.claimed) return confirmationIfReady(database, marker, at, plan);
  if (current === null) throw new BusyComponentError('Missing');
  if (!await stored(() => state.claimBusyChoice(database, choiceId, at))) return confirmationIfReady(database, marker, at, plan);
  try {await executeBusyAction(choice, action, server, database, verifier, now);}
  catch (error) {
    if (await stored(() => retainOrReleaseBusyClaim(database, choiceId, error)) === 'RetainIndeterminate') throw new BusyComponentError('ActionOutcomeIndeterminate', passiveErrorText(error, 'busy control outcome unknown'));
    throw error;
  }
  try {await recordConfirmationReady(database, marker, readCustodyTimestamp(now), 1800);}
  catch (error) {throw new BusyComponentError('Confirmation', new ConfirmationError('Recovery', passiveErrorText(error, 'busy confirmation recovery failed'), error));}
  return plan;
}
