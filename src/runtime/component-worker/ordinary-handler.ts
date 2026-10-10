import {types} from 'node:util';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import type {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import type {ComponentId} from '../../discord/components.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {serdeValueEqual} from '../../core/serde-value-equal.ts';
import {snapshotInboundInteractionWork, type InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
import {snapshotComponentId} from '../discord-dispatch/delivery-identity.ts';
import type {BusyQueueExecutor} from '../action-executor/busy-queue.ts';
import type {ControlTurnVerifier} from '../action-executor/control-turn.ts';
import {prepareStandardComponentAction} from './standard.ts';
import {prepareBusyConfirmationOnly} from './busy-preflight.ts';
import {handleBusyComponent} from './busy.ts';
import {handleAsyncChoice} from './async-choice.ts';
import {handleRecoveryAbandonment} from './recovery-abandonment.ts';
import {handleRecoveryPublication} from './recovery-publication.ts';
import {ComponentWorkerError, componentWorkerErrorInfo} from './errors.ts';
import {busyComponentErrorInfo, BusyComponentError} from './busy-errors.ts';
import {isConfirmationPlan, confirmationErrorInfo, type ConfirmationPlan} from './confirmation.ts';
import {deliverConfirmationAndClear} from './confirmation-delivery.ts';
const token = Symbol('PreparedOrdinaryComponentConfirmation'), owned = new WeakSet<object>();
/** Preparation executed the action already. Delivery can only retry its durable
 * confirmation/clear path; it retains no callback capable of executing the action. */
export class PreparedOrdinaryComponentConfirmation {
  readonly #database: string; readonly #channel: bigint; readonly #source: bigint | null; readonly #plan: ConfirmationPlan; readonly #http: DiscordChannelClient;
  constructor(key: symbol, database: string, channel: bigint, source: bigint | null, plan: ConfirmationPlan, http: DiscordChannelClient) {
    if (key !== token || !isConfirmationPlan(plan)) throw new TypeError('Expected prepared ordinary confirmation');
    this.#database = database; this.#channel = channel; this.#source = source; this.#plan = plan; this.#http = http; owned.add(this); Object.freeze(this);
  }
  readonly deliver = async (): Promise<void> => {
    if (!owned.has(this)) throw new TypeError('Expected prepared ordinary confirmation');
    const abandonment=this.#plan.domain==='recovery-abandonment-confirmation-v1',budget=abandonment?new AbortController():null;
    const timer=budget===null?null:setTimeout(()=>budget.abort(new Error('notification timed out; its receipt must be reconciled')),10000);
    try {await deliverConfirmationAndClear(this.#http,this.#database,this.#channel,this.#source,this.#plan,budget?.signal);}
    catch(error){if(abandonment)throw new ComponentWorkerError('AbandonmentNotice',error);if(confirmationErrorInfo(error)!==null)throw new ComponentWorkerError('Confirmation',error);throw error;}
    finally{if(timer!==null)clearTimeout(timer);}

  };
}
/* Recovery variants are dispatched before ordinary approvals and confirmation-
 * only busy handling. Their dedicated sinks never substitute a native action. */
export function createOrdinaryComponentHandler(database: string, server: PortableResidentLifecycle, http: DiscordChannelClient,
  queue: BusyQueueExecutor, verifier: ControlTurnVerifier, notifyDeliveryReady: () => void) {
  requireDiscordText(database);
  if (typeof notifyDeliveryReady !== 'function' || types.isProxy(notifyDeliveryReady) || types.isAsyncFunction(notifyDeliveryReady) || types.isGeneratorFunction(notifyDeliveryReady)) throw new TypeError('Expected synchronous delivery notifier');
  return async (inputWork: InboundInteractionWork, inputComponent: ComponentId): Promise<PreparedOrdinaryComponentConfirmation> => {
    const work = snapshotInboundInteractionWork(inputWork), component = snapshotComponentId(inputComponent);
    if (!Object.hasOwn(work.work, 'Component') || !serdeValueEqual((work.work as {Component: ComponentId}).Component, component)) throw new ComponentWorkerError('InvalidComponent');
    let plan: ConfirmationPlan;
    if ('RecoveryAbandonDecision' in component) plan = await handleRecoveryAbandonment(work, component, database, verifier);
    else if ('RecoveryPublicationDecision' in component) plan = await handleRecoveryPublication(work, component, database, verifier);
    else if ('AsyncChoice' in component) plan = await handleAsyncChoice(work, component.AsyncChoice.question_id, component.AsyncChoice.option, database, server, verifier, notifyDeliveryReady);
    else if (work.processingMode === 'ConfirmationOnly' || 'Busy' in component) {
      try {plan = work.processingMode === 'ConfirmationOnly' ? await prepareBusyConfirmationOnly(work, component, database) : await handleBusyComponent(work, component, database, queue, server, verifier);}
      catch (error) {
        if (busyComponentErrorInfo(error) !== null) throw new ComponentWorkerError('Busy', error);
        if (componentWorkerErrorInfo(error) !== null) throw error;
        throw new ComponentWorkerError('Busy', new BusyComponentError('Store', error));
      }
    } else plan = await prepareStandardComponentAction(work, component, database, server);
    return new PreparedOrdinaryComponentConfirmation(token, database, work.channelId, work.sourceMessageId, plan, http);
  };
}
