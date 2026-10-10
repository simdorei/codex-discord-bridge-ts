import {types} from 'node:util';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import type {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import type {ComponentId} from '../../discord/components.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {isRoutedInteractionWork} from '../../discord/interaction-routing.ts';
import {planSlash, type SlashCommandAction} from '../command-plan.ts';
import {snapshotActionResult, type ActionResult} from '../action-result.ts';
import {cleanupNotificationFailureInfo} from '../cleanup-notification-failure.ts';
import {cleanupRefusalFromActionError} from '../cleanup-refusal.ts';
import {ComponentWorkerError, componentWorkerErrorInfo, actionCompletedBeforeFailure} from '../component-worker/errors.ts';
import {confirmationErrorInfo} from '../component-worker/confirmation.ts';
import {busyComponentErrorInfo} from '../component-worker/busy-errors.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {InteractionWorkerError} from './errors.ts';
import {deliverActionResult} from './action-delivery.ts';
import {deliverCleanupRefusal} from './cleanup-refusal-delivery.ts';
import {ExecutionCustody} from './execution-custody.ts';
import type {InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
export interface InteractionActionContext {readonly channelId: bigint; readonly userId: bigint; readonly discordMessageId: bigint; readonly autoQueueWhenBusy: false}
export interface InteractionBusinessServices {
  executeWithIngressContext(action: SlashCommandAction, context: InteractionActionContext, ingressId: string): Promise<ActionResult>;
  /** Source PreparedComponentConfirmation adapter: prepare action first, delivery
   * is lazy and must not begin until the caller records completed action. */
  prepareComponent(work: InboundInteractionWork, component: ComponentId): Promise<{deliver(): Promise<void>}>;
}
function functionField(input: unknown, name: string): Function {
  const value = gatewayOwnField(input, name); if (typeof value !== 'function' || types.isProxy(value) || types.isGeneratorFunction(value)) throw new TypeError('Expected business function'); return value;
}
async function native<T>(fn: Function, receiver: object, args: unknown[]): Promise<T> {
  const value = Reflect.apply(fn, receiver, args); if (!types.isPromise(value)) throw new TypeError('Expected native business Promise'); return await value as T;
}
async function record(custody: ExecutionCustody, outcome: unknown): Promise<void> {
  try {await custody.recordResult(outcome);} catch (error) {throw new InteractionWorkerError('Custody', error);}
}
/** Source process_interaction_work sequencing. Required business services remain
 * explicit; no generic stub silently claims all commands are implemented. */
export function createInteractionProcessor(database: string, server: PortableResidentLifecycle, http: DiscordChannelClient, services: InteractionBusinessServices) {
  const execute = functionField(services, 'executeWithIngressContext'), prepare = functionField(services, 'prepareComponent');
  return async (work: InboundInteractionWork, custody: ExecutionCustody): Promise<boolean> => {
    let rejection: string | null;
    try {rejection = await custody.requestRejection(work);} catch (error) {throw new InteractionWorkerError('Custody', error);}
    if (rejection !== null) {
      await record(custody, {kind: 'request_rejected', action_completed: false, control_dispatched: false, error: rejection});
      await deliverActionResult(work, {text: `ERROR: ${rejection}`, waitsForFinal: false, ui: null}, database, server, http); return false;
    }
    const routed = work.work; if (!isRoutedInteractionWork(routed)) throw new TypeError('Expected owned interaction work');
    if (Object.hasOwn(routed, 'Autocomplete')) throw new InteractionWorkerError('Unsupported', 'autocomplete');
    if (Object.hasOwn(routed, 'Component')) {
      const component = (routed as Extract<typeof routed, {Component: unknown}>).Component; let confirmation: {deliver(): Promise<void>};
      try {confirmation = await native(prepare, services, [work, component]);}
      catch (error) {
        const info = componentWorkerErrorInfo(error), busy = info?.kind === 'Busy' ? busyComponentErrorInfo(info.source) : null;
        if (busy?.kind === 'ControlNotDispatched') await record(custody, {kind: 'busy_control_preflight_rejected', control_dispatched: false, error: passiveErrorText(error, 'control not dispatched')});
        else if (actionCompletedBeforeFailure(error)) await record(custody, {kind: 'component', action_completed: true, confirmation_error: passiveErrorText(error, 'confirmation recovery failed')});
        if (info !== null) throw new InteractionWorkerError('Component', error); throw error;
      }
      const deliver = functionField(confirmation, 'deliver');
      await record(custody, {kind: 'component', action_completed: true});
      try {await native<void>(deliver, confirmation, []);}
      catch (error) {
        if (componentWorkerErrorInfo(error) !== null) throw new InteractionWorkerError('Component', error);
        if (confirmationErrorInfo(error) !== null) throw new InteractionWorkerError('Component', new ComponentWorkerError('Confirmation', error));
        throw error;
      }
      return false;
    }
    let action: SlashCommandAction;
    try {action = planSlash(routed);} catch (error) {throw new InteractionWorkerError('Plan', error);}
    let result: ActionResult;
    try {result = snapshotActionResult(await native<ActionResult>(execute, services, [action, Object.freeze({channelId: work.channelId, userId: work.userId, discordMessageId: work.interactionId, autoQueueWhenBusy: false}), work.custodyIngressId]));}
    catch (error) {
      const refusal = cleanupRefusalFromActionError(error);
      if (refusal !== undefined) {
        try {return await deliverCleanupRefusal(work, custody, http, refusal);}
        catch (failure) {throw new InteractionWorkerError(cleanupNotificationFailureInfo(failure) !== null ? 'KnownOutcomeNotification' : 'Custody', failure);}
      }
      throw new InteractionWorkerError('Action', error);
    }
    await record(custody, {kind: 'slash', action_completed: true, waits_for_final: result.waitsForFinal, response: result.text});
    await deliverActionResult(work, result, database, server, http); return result.waitsForFinal;
  };
}
