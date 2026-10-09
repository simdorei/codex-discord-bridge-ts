import {snapshotBusyChoice, type BusyChoice} from '../../store/busy-choice.ts';
import type {BusyAction, ComponentId} from '../../discord/components.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {isProCommand} from '../../pro/prompt.ts';
import {snapshotComponentId} from '../discord-dispatch/delivery-identity.ts';
import type {InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {busyConfirmationPlan, busyReadyMarker, confirmationReady, type ConfirmationPlan} from './confirmation.ts';
import {BusyComponentError} from './busy-errors.ts';
function signedId(value: bigint): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << 64n) throw new TypeError('Expected u64 busy actor');
  if (value >= 1n << 63n) throw new BusyComponentError('IntegerRange'); return value;
}
export function validateBusyChoice(input: BusyChoice, action: BusyAction, userId: bigint, channelId: bigint): void {
  const choice = snapshotBusyChoice(input);
  if (!['Steer', 'Queue', 'Stop', 'Ignore'].includes(action)) throw new TypeError('Expected busy action');
  if (choice.ownerUserId !== signedId(userId)) throw new BusyComponentError('WrongUser');
  if (choice.channelId !== signedId(channelId)) throw new BusyComponentError('WrongChannel');
  if (action === 'Steer' && isProCommand(choice.prompt)) throw new BusyComponentError('ControlNotDispatched', 'Pro requests cannot be steered; choose Queue next to run Pro connection checks');
}
export function authorizedBusyChoice(work: Pick<InboundInteractionWork, 'authorizedBusyChoice'>, choiceId: string): Readonly<BusyChoice> {
  const raw = gatewayOwnField(work, 'authorizedBusyChoice');
  if (raw === null) throw new BusyComponentError('MissingAuthorizationSnapshot');
  const choice = snapshotBusyChoice(raw as BusyChoice);
  if (choice.choiceId !== choiceId) throw new BusyComponentError('MissingAuthorizationSnapshot');
  return Object.freeze(choice);
}
/** ConfirmationOnly uses the original pre-ACK snapshot and exact actor-bound
 * ready marker. It never recreates a choice, claims or executes its action. */
export async function prepareBusyConfirmationOnly(work: Pick<InboundInteractionWork, 'authorizedBusyChoice' | 'userId' | 'channelId'>,
  input: ComponentId, database: string, now: () => number = systemNow): Promise<ConfirmationPlan> {
  const component = snapshotComponentId(input); if (!('Busy' in component)) throw new BusyComponentError('ActionUnconfirmed');
  const choice = authorizedBusyChoice(work, component.Busy.choice_id), user = gatewayOwnField(work, 'userId') as bigint, channel = gatewayOwnField(work, 'channelId') as bigint;
  validateBusyChoice(choice, component.Busy.action, user, channel);
  const plan = busyConfirmationPlan(component.Busy.choice_id), marker = busyReadyMarker(component.Busy.choice_id, user, channel);
  if (!await confirmationReady(database, marker, readCustodyTimestamp(now))) throw new BusyComponentError('ActionUnconfirmed');
  return plan;
}
