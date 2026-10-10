import {types} from 'node:util';
import {AdmissionPermit, type AdmissionGate} from '../../admission/drain-gate.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import type {OwnedWorkReservation, OwnedWorkSender} from '../../core/owned-work-queue.ts';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import type {DecodedGatewayInteraction} from '../../discord/gateway/decoded-interaction.ts';
import {nativeGatewayShutdownClock, type GatewayShutdownClock} from '../../discord/gateway/shutdown.ts';
import type {InteractionAccessPolicy} from '../../discord/interaction-access.ts';
import {interactionMessage, type InteractionResponse} from '../../discord/interaction-response.ts';
import {routeInteraction} from '../../discord/route-interaction.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {settingsErrorText as safeErrorText, type SlashSettingsTargetResolver} from '../settings-binding.ts';
import {acknowledgeUntil, interactionAcknowledgementDeadline} from './acknowledge-until.ts';
import {admitInteraction} from './admission.ts';
import {AutocompleteCatalog} from './autocomplete.ts';
import {InteractionClaimCache, type InteractionClaim} from './claim-cache.ts';
import {InteractionDispatchError} from './errors.ts';
import {isInteractionWorkQueue, type InteractionWorkQueue, type InboundInteractionWork} from './interaction-work.ts';
import {interactionDispatchResponse} from './response.ts';
import {stageOrdinaryInteraction} from './stage-ordinary.ts';
import {StagedInteractionCustody, type CustodyCleanupReport, type InteractionCustodyReceipt} from './staged-custody.ts';

export type InteractionDispatchOutcome = 'Queued' | 'RespondedWithoutWork' | 'Duplicate'
  | 'DuplicatePending' | 'DeadlineExceeded' | 'QueueFull' | 'Stopping';
export type InteractionDispatchReport = CustodyCleanupReport
  | {readonly code: 'interaction_custody_hold_failed'; readonly phase: string; readonly error: unknown};
export interface OrdinaryDispatcherOptions {
  readonly client: DiscordChannelClient;
  readonly policy: InteractionAccessPolicy;
  readonly qaEnabled: boolean;
  readonly queue: InteractionWorkQueue;
  readonly database: string;
  readonly claims: InteractionClaimCache;
  readonly autocomplete: AutocompleteCatalog;
  readonly admission: AdmissionGate | null;
  readonly settingsResolver: SlashSettingsTargetResolver | null;
  readonly report: (value: InteractionDispatchReport) => void;
  readonly clock?: GatewayShutdownClock;
  readonly custodyNow?: () => number;
}
const releasePermit = AdmissionPermit.prototype.release;

/** Complete front/ACK/queue ordering for the ordinary stage profile only.
 * Recovery staging uses original authenticated delivery identity; actual queue
 * execution remains in the worker. HTTP is borrowed; one sender clone is disposed
 * after all dispatch calls finish. Policy refresh belongs to the ingress owner. */
export class OrdinaryInteractionDispatcher {
  readonly #options: OrdinaryDispatcherOptions;
  readonly #sender: OwnedWorkSender<InboundInteractionWork>;
  readonly #ack: DiscordChannelClient['acknowledgeInteraction'];
  readonly #clock: GatewayShutdownClock;
  readonly #report: (value: InteractionDispatchReport) => void;
  readonly #custodyNow: () => number;
  #active = 0;
  #disposed = false;
  constructor(options: OrdinaryDispatcherOptions) {
    requireDiscordText(options.database);
    if (typeof options.qaEnabled !== 'boolean' || !isInteractionWorkQueue(options.queue)) throw new TypeError('Expected owned dispatcher configuration');
    const report = options.report, now = options.custodyNow ?? systemNow;
    for (const value of [report, now]) if (typeof value !== 'function' || types.isProxy(value)
      || types.isAsyncFunction(value) || types.isGeneratorFunction(value)) throw new TypeError('Expected synchronous dispatcher callbacks');
    const source = options.clock ?? nativeGatewayShutdownClock, clockNow = source.now.bind(source);
    this.#clock = Object.freeze({
      now: () => {
        const value = clockNow();
        if (types.isPromise(value)) void Promise.prototype.then.call(value, undefined, () => undefined);
        if (!Number.isFinite(value) || value < 0) throw new TypeError('Expected monotonic dispatcher clock');
        return value;
      },
      sleepUntil: source.sleepUntil.bind(source),
    });
    this.#report = value => invokeSynchronousVoid(report, {}, [value]);
    this.#custodyNow = now;
    this.#ack = DiscordChannelClient.prototype.acknowledgeInteraction.bind(options.client);
    this.#options = Object.freeze({...options});
    this.#sender = options.queue.sender.clone();
    Object.freeze(this);
  }
  dispose(): void {
    if (this.#disposed) return;
    if (this.#active !== 0) throw new TypeError('Dispatcher is still borrowed by active calls');
    this.#disposed = true; this.#sender.dispose();
  }
  async dispatch(interaction: DecodedGatewayInteraction, receivedAtMs: number,
    tag: 'Normal' | 'Busy' | 'Stopping', force: AbortSignal): Promise<InteractionDispatchOutcome> {
    if (this.#disposed) throw new TypeError('Dispatcher was disposed');
    this.#active++;
    try {return await this.#run(interaction, receivedAtMs, tag, force);}
    finally {this.#active--;}
  }
  async #run(interaction: DecodedGatewayInteraction, receivedAtMs: number,
    tag: 'Normal' | 'Busy' | 'Stopping', force: AbortSignal): Promise<InteractionDispatchOutcome> {
    let claim: InteractionClaim | undefined, permit: AdmissionPermit | null = null;
    let custody: StagedInteractionCustody | undefined, reservation: OwnedWorkReservation<InboundInteractionWork> | undefined;
    let outcome: InteractionDispatchOutcome | undefined, failed = false, primary: unknown;
    const diagnosticFailures: unknown[] = [];
    const flow = async (): Promise<InteractionDispatchOutcome> => {
      force.throwIfAborted();
      const deadline = interactionAcknowledgementDeadline(receivedAtMs);
      if (this.#clock.now() >= deadline) return 'DeadlineExceeded';
      const routed = routeInteraction(interaction, this.#options.policy, this.#options.qaEnabled);
      const admission = admitInteraction(this.#options.admission, routed.work); permit = admission.permit;
      const autocomplete = routed.work !== null && Object.hasOwn(routed.work, 'Autocomplete');
      const response = admission.sealed && !autocomplete
        ? interactionMessage('Codex Discord is restarting. Please retry after restart.', true)
        : interactionDispatchResponse(interaction, tag, routed.initialResponse, routed.work, this.#options.autocomplete);
      if (this.#clock.now() >= deadline) return 'DeadlineExceeded';
      const attempt = InteractionClaimCache.prototype.tryClaim.call(this.#options.claims, routed.interactionId);
      if (attempt.kind !== 'Claimed') {
        if (attempt.kind === 'DuplicatePending') return 'DuplicatePending';
        if (attempt.kind === 'DuplicateCommitted') return 'Duplicate';
        throw new InteractionDispatchError('ClaimCacheSaturated');
      }
      claim = attempt.claim;
      if (this.#clock.now() >= deadline) return 'DeadlineExceeded';
      const ack = (value: InteractionResponse) => acknowledgeUntil(signal =>
        this.#ack(routed.interactionId, routed.token, value, signal), deadline, force, this.#clock);
      const commit = () => {if (!claim!.commit()) throw new InteractionDispatchError('ClaimState');};
      const respond = async (value: InteractionResponse, result: InteractionDispatchOutcome): Promise<InteractionDispatchOutcome> => {
        if (!await ack(value)) return 'DeadlineExceeded';
        commit(); return result;
      };
      if (admission.sealed || tag !== 'Normal' || routed.work === null || autocomplete) {
        return respond(response, admission.sealed ? 'Stopping' : 'RespondedWithoutWork');
      }
      const channelId = routed.channelId, userId = routed.userId, work = routed.work;
      if (channelId === null || userId === null) {
        return respond(interactionMessage('Discord interaction identity is missing.', true), 'RespondedWithoutWork');
      }
      let staged;
      try {
        staged = await stageOrdinaryInteraction(this.#options.database, {
          applicationId: interaction.application_id, interactionId: routed.interactionId,
          channelId, userId, sourceMessageId: routed.sourceMessageId, work,
        }, {settingsResolver: this.#options.settingsResolver, cleanup: {now: this.#custodyNow, report: this.#report}});
      } catch (error) {throw new InteractionDispatchError('Custody', safeErrorText(error));}
      if (staged.kind === 'Created') custody = staged.custody;
      force.throwIfAborted(); // DB stage is joined, never abandoned by cancellation.
      if (staged.kind === 'Duplicate') return 'Duplicate';
      if (staged.kind === 'BusyChoiceUnavailable') {
        return respond(interactionMessage('This busy-choice button is no longer active. Please use the latest prompt.', true), 'RespondedWithoutWork');
      }
      const enqueue = (receipt: InteractionCustodyReceipt, processingMode: InboundInteractionWork['processingMode']): InteractionDispatchOutcome => {
        const value: InboundInteractionWork = Object.freeze({
          applicationId: interaction.application_id, interactionId: routed.interactionId, channelId, userId,
          sourceMessageId: routed.sourceMessageId, interactionToken: routed.token, work, processingMode,
          custodyDatabase: receipt.database, custodyIngressId: receipt.ingressId,
          authorizedBusyChoice: receipt.busyChoice, admissionPermit: permit,
        });
        permit = null; // Reservation.send owns the item even if final destruction throws.
        reservation!.send(value);
        return 'Queued';
      };
      if (staged.kind === 'CanonicalRepeat') {
        if (!staged.confirmationReady) return respond(interactionMessage(
          'This busy request is already saved and requires manual review. No action was started again.', true), 'RespondedWithoutWork');
        const reserved = this.#sender.tryReserve();
        if (reserved.kind !== 'Reserved') return respond(interactionMessage(
          'The busy action is already saved, but its confirmation cannot run now. Please retry shortly.', true),
          reserved.kind === 'Full' ? 'QueueFull' : 'Stopping');
        reservation = reserved.reservation;
        if (!await ack(response)) return 'DeadlineExceeded';
        commit(); return enqueue(staged.receipt, 'ConfirmationOnly');
      }
      const holdOrLog = async (phase: string): Promise<void> => {
        try {await custody!.holdNotExecuted(phase);}
        catch (error) {
          try {this.#report(Object.freeze({code: 'interaction_custody_hold_failed', phase, error}));}
          catch (reportError) {diagnosticFailures.push(reportError);}
        }
      };
      if (this.#clock.now() >= deadline) {await holdOrLog('discord_ack_deadline'); return 'DeadlineExceeded';}
      const reserved = this.#sender.tryReserve();
      if (reserved.kind !== 'Reserved') {
        const full = reserved.kind === 'Full';
        try {await custody!.holdNotExecuted(full ? 'interaction_queue_full' : 'interaction_queue_closed');}
        catch (error) {throw new InteractionDispatchError('Custody', safeErrorText(error));}
        return respond(interactionMessage(full ? 'Codex Discord work queue is full. Please retry shortly.'
          : 'Codex Discord runtime is stopping. Please retry after restart.', true), full ? 'QueueFull' : 'Stopping');
      }
      reservation = reserved.reservation;
      try {
        if (!await ack(response)) {await holdOrLog('discord_ack_deadline'); return 'DeadlineExceeded';}
      } catch (error) {
        if (!force.aborted) await holdOrLog('discord_ack_failed');
        throw error;
      }
      try {await custody!.acknowledge();}
      catch (error) {await holdOrLog('custody_acknowledge_failed'); throw new InteractionDispatchError('Custody', safeErrorText(error));}
      force.throwIfAborted(); // Conservative Node await boundary; retain durable hold.
      try {commit();}
      catch (error) {await holdOrLog('interaction_claim_commit_failed'); throw error;}
      return enqueue(custody!.intoReceipt(), 'Execute');
    };
    try {outcome = await flow();} catch (error) {failed = true; primary = error;}
    const cleanup: unknown[] = [...diagnosticFailures];
    try {reservation?.release();} catch (error) {cleanup.push(error);}
    try {claim?.release();} catch (error) {cleanup.push(error);}
    try {await custody?.dispose();} catch (error) {cleanup.push(error);}
    try {if (permit !== null) releasePermit.call(permit);} catch (error) {cleanup.push(error);}
    if (failed && cleanup.length !== 0) throw new AggregateError([primary, ...cleanup], 'Interaction dispatch and cleanup failed');
    if (failed) throw primary;
    if (cleanup.length === 1) throw cleanup[0];
    if (cleanup.length > 1) throw new AggregateError(cleanup, 'Interaction dispatch cleanup failed');
    return outcome!;
  }
}
Object.freeze(OrdinaryInteractionDispatcher.prototype);
