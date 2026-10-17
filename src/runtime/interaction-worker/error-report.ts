import {types} from 'node:util';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {isRoutedInteractionWork} from '../../discord/interaction-routing.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import type {InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
import {componentClaimIdentity, componentDeliveryKey, COMPONENT_ERROR_DOMAIN, INTERACTION_ERROR_DOMAIN} from '../discord-dispatch/delivery-identity.ts';
import {sendReceiptChunk} from '../completion/receipt-sender.ts';
import {deliverInteractionTextIdempotent} from './text-delivery.ts';
import {interactionErrorDisposition, interactionWorkerErrorInfo, type InteractionWorkerError} from './errors.ts';
export type InteractionErrorReporter = (code: 'interaction_notification_recovery_error' | 'interaction_error_report_failed', detail: string) => void;
/** A failed notification never executes or retries the original action. Component
 * errors use their durable receipt identity; ordinary errors update the existing
 * deferred response. All network/storage work is joined before returning. */
export async function reportInteractionError(work: InboundInteractionWork, error: InteractionWorkerError, http: DiscordChannelClient, report: InteractionErrorReporter): Promise<void> {
  const info = interactionWorkerErrorInfo(error); if (info === null) throw new TypeError('Expected owned interaction failure');
  const disposition = interactionErrorDisposition(error); if (disposition === 'IgnoreDuplicate') return;
  if (typeof report !== 'function' || types.isProxy(report) || types.isAsyncFunction(report) || types.isGeneratorFunction(report)) throw new TypeError('Expected synchronous interaction reporter');
  const token = gatewayOwnField(work, 'interactionToken'); requireDiscordText(token);
  const safe = (text: string) => token === '' ? text : text.split(token).join('[redacted]');
  const emit = (code: Parameters<InteractionErrorReporter>[0], detail: string) => invokeSynchronousVoid(report, {}, [code, safe(detail)]);
  if (disposition === 'LogOnly') {emit('interaction_notification_recovery_error', info.text); return;}
  const routed = gatewayOwnField(work, 'work'); if (!isRoutedInteractionWork(routed)) throw new TypeError('Expected owned routed interaction');
  const application = gatewayOwnField(work, 'applicationId'), interaction = gatewayOwnField(work, 'interactionId'), channel = gatewayOwnField(work, 'channelId');
  for (const id of [application, interaction, channel]) if (typeof id !== 'bigint' || id <= 0n || id >= 1n << 64n) throw new TypeError('Expected Discord interaction identity');
  const text = safe('ERROR: ' + info.text);
  if (Object.hasOwn(routed, 'Component')) {
    const component = (routed as Extract<typeof routed, {Component: unknown}>).Component, message = gatewayOwnField(work, 'sourceMessageId');
    if (message !== null && (typeof message !== 'bigint' || message <= 0n || message >= 1n << 64n)) throw new TypeError('Expected source message identity');
    const database = gatewayOwnField(work, 'custodyDatabase'); requireDiscordText(database);
    const logicalKey = componentDeliveryKey(interaction as bigint, message, component, componentClaimIdentity(message, component));
    try {await sendReceiptChunk(database, {sendValidated: DiscordChannelClient.prototype.sendValidated.bind(http)}, channel as bigint,
      {domain: COMPONENT_ERROR_DOMAIN, logicalKey, chunkIndex: 0, content: text});}
    catch (deliveryError) {emit('interaction_error_report_failed', text + '; additionally failed to report to Discord: ' + passiveErrorText(deliveryError, 'delivery failed'));}
    return;
  }
  try {await deliverInteractionTextIdempotent(http, {applicationId: application as bigint, interactionId: interaction as bigint, channelId: channel as bigint, interactionToken: token}, text, INTERACTION_ERROR_DOMAIN);}
  catch (deliveryError) {emit('interaction_error_report_failed', text + '; additionally failed to report to Discord: ' + passiveErrorText(deliveryError, 'delivery failed'));}
}
