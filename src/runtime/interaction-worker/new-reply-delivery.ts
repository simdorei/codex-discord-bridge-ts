import {createHash} from 'node:crypto';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {newReplyAcknowledgementKey} from '../../store/new-reply-claims.ts';
import {StoreIntegrityError} from '../../store/schema-assembly.ts';
import {rustDebugString} from '../../core/rust-debug.ts';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {DeliveryFailure} from '../../discord/delivery.ts';
import type {InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
const get = state.getNewReplyByIngress, begin = state.beginDeliveryReceipt, confirm = state.confirmDeliveryReceipt;
/** /new normal initial-response acknowledgement is a durable single logical
 * attempt. No generic delivery-policy retry or fallback POST is permitted.
 * true means handled/already delivered; false means no /new record exists. */
export async function deliverNewReply(client: DiscordChannelClient, work: InboundInteractionWork,
  result: {readonly text: string; readonly ui: unknown | null}, database: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const ingress = gatewayOwnField(work, 'custodyIngressId'); requireDiscordText(ingress);
  const application = gatewayOwnField(work, 'applicationId'), interaction = gatewayOwnField(work, 'interactionId');
  for (const id of [application, interaction]) if (typeof id !== 'bigint' || id <= 0n || id >= 1n << 64n) throw new TypeError('Expected interaction identity');
  const token = gatewayOwnField(work, 'interactionToken'); requireDiscordText(token);
  const text = gatewayOwnField(result, 'text'), ui = gatewayOwnField(result, 'ui'); requireDiscordText(text);
  const record = await get(database, ingress); if (record === null) return false;
  if (text !== record.identity.acknowledgement || ui !== null) throw new StoreIntegrityError('new slash acknowledgement changed; PATCH refused');
  const key = newReplyAcknowledgementKey(record), hash = createHash('sha256').update(text, 'utf8').digest('hex');
  signal?.throwIfAborted(); const receipt = await begin(database, key, hash);
  if (receipt.kind === 'Delivered') return true;
  if (receipt.kind !== 'New') {
    const debug = receipt.kind === 'Held' || receipt.kind === 'RejectedBlocked' ? `${receipt.kind}(${rustDebugString(receipt.reason)})` : receipt.kind;
    throw new StoreIntegrityError(`new slash acknowledgement retained without retry: ${debug}`);
  }
  try {await DiscordChannelClient.prototype.updateInitialResponse.call(client, application as bigint, token, text, signal);}
  catch (source) {throw new DeliveryFailure(1, 1, 1, source);}
  // Acknowledged HTTP remains joined through its durable confirmation, even if
  // cancellation arrives after the response. Unknown receipts never auto-resend.
  if (!await confirm(database, key, `initial-response/${interaction}`)) throw new StoreIntegrityError('new slash acknowledgement accepted but confirmation commit failed');
  return true;
}
