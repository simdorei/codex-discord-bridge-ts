import {types} from 'node:util';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {AdmissionPermit} from '../../admission/drain-gate.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {type InteractionWorkQueue, type InboundInteractionWork, isInteractionWorkQueue, snapshotInboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
import {cleanupNotificationFailureInfo} from '../cleanup-notification-failure.ts';
import {componentWorkerErrorInfo} from '../component-worker/errors.ts';
import {ExecutionCustody} from './execution-custody.ts';
import {InteractionWorkerError, interactionWorkerErrorInfo} from './errors.ts';
import {reportInteractionError, type InteractionErrorReporter} from './error-report.ts';
export type InteractionWorkerReportCode = Parameters<InteractionErrorReporter>[0] | 'interaction_processing_hold_failed' | 'interaction_processing_cancel_hold_clock_failed' | 'interaction_processing_cancel_hold_failed';
export interface InteractionProcessor {
  /** Trusted business processor: record action result before notification. This
   * required port is not a substitute implementation of every CommandAction. */
  process(work: InboundInteractionWork, custody: ExecutionCustody): Promise<boolean>;
  notifyDeliveryReady(): void;
  report(code: InteractionWorkerReportCode, detail: string): void;
}

function failure(error: unknown, fallback: 'Action' | 'Custody'): InteractionWorkerError {
  if (interactionWorkerErrorInfo(error) !== null) return error as InteractionWorkerError;
  if (cleanupNotificationFailureInfo(error) !== null) return new InteractionWorkerError('KnownOutcomeNotification', error);
  if (componentWorkerErrorInfo(error) !== null) return new InteractionWorkerError('Component', error);
  return new InteractionWorkerError(fallback, error);
}
/** One owning receive loop. Close the source senders/receiver for graceful drain.
 * Every received item's processing, error report and custody disposal joins before
 * its admission permit is released. Forced uncooperative shutdown still needs the
 * outer worker deadline; this function never detaches an active operation. */
export async function runInteractionWorker(queue: InteractionWorkQueue, database: string, http: DiscordChannelClient, processor: InteractionProcessor): Promise<void> {
  if (!isInteractionWorkQueue(queue)) throw new TypeError('Expected owned interaction queue'); requireDiscordText(database);
  const process = gatewayOwnField(processor, 'process'), notify = gatewayOwnField(processor, 'notifyDeliveryReady'), reporter = gatewayOwnField(processor, 'report');
  for (const fn of [process, notify, reporter]) if (typeof fn !== 'function' || types.isProxy(fn) || types.isGeneratorFunction(fn)) throw new TypeError('Expected trusted worker function');
  if (types.isAsyncFunction(notify) || types.isAsyncFunction(reporter)) throw new TypeError('Expected synchronous worker notifications');
  const invokeReport = (code: InteractionWorkerReportCode, detail: string) => invokeSynchronousVoid(reporter as Function, processor, [code, detail]);
  try {
    for (;;) {
      const next = await queue.receiver.receive(); if (next.kind === 'Closed') return;
      // Keep the original permit reference even if later envelope validation fails.
      const permit = gatewayOwnField(next.value, 'admissionPermit') as AdmissionPermit | null;
      let custody: ExecutionCustody | null = null;
      try {
        const work = snapshotInboundInteractionWork(next.value), safe = (text: string) => work.interactionToken === '' ? text : text.split(work.interactionToken).join('[redacted]');
        const report = (code: InteractionWorkerReportCode, text: string) => invokeReport(code, safe(text));
        try {custody = await ExecutionCustody.begin(database, work.custodyDatabase, work.custodyIngressId, work.processingMode,
          {report: value => report(value.code, passiveErrorText(value.error, 'custody cleanup failed'))});}
        catch (error) {await reportInteractionError(work, failure(error, 'Custody'), http, report); continue;}
        let waitsForFinal: boolean;
        try {
          const pending = Reflect.apply(process as Function, processor, [work, custody]);
          if (!types.isPromise(pending)) throw new TypeError('Interaction processor must return a native Promise');
          const result = await pending; if (typeof result !== 'boolean') throw new TypeError('Interaction processor must return waitsForFinal boolean'); waitsForFinal = result;
        } catch (error) {
          try {await custody.holdFailed();} catch (holdError) {report('interaction_processing_hold_failed', passiveErrorText(holdError, 'hold persistence failed'));}
          await reportInteractionError(work, failure(error, 'Action'), http, report); continue;
        }
        try {await custody.finishNotification({kind: 'interaction', action_completed: true, waits_for_final: waitsForFinal});}
        catch (error) {await reportInteractionError(work, failure(error, 'Custody'), http, report); continue;}
        invokeSynchronousVoid(notify as Function, processor);
      } finally {
        try {if (custody !== null) await custody.dispose();}
        finally {if (permit !== null) AdmissionPermit.prototype.release.call(permit);}
      }
    }
  } finally {queue.receiver.dispose();}
}
