import {setTimeout as delay} from 'node:timers/promises';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {idempotentMessageRequest} from '../../discord/idempotent-message.ts';
import {DEFAULT_DELIVERY_POLICY, DeliveryFailure, deliverTextIndexed, type DeliverySleep} from '../../discord/delivery.ts';
import type {InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
export const INTERACTION_FOLLOWUP_DOMAIN = 'interaction/followup/v1';
export const INTERACTION_ERROR_DOMAIN = 'interaction/error/v1';
/** Ordinary text delivery only. Part zero updates the existing deferred response;
 * later parts are channel POSTs with stable per-interaction nonce identities.
 * This is not the separate /new single-attempt durable acknowledgement path. */
export async function deliverInteractionTextIdempotent(client: DiscordChannelClient, work: Pick<InboundInteractionWork, 'applicationId' | 'interactionId' | 'channelId' | 'interactionToken'>,
  content: string, domain: string, options: {signal?: AbortSignal; sleep?: DeliverySleep} = {}): Promise<number> {
  const signal = options.signal; signal?.throwIfAborted();
  const application = gatewayOwnField(work, 'applicationId'), interaction = gatewayOwnField(work, 'interactionId'), channel = gatewayOwnField(work, 'channelId');
  for (const id of [application, interaction, channel]) if (typeof id !== 'bigint' || id <= 0n || id >= 1n << 64n) throw new TypeError('Expected Discord delivery identity');
  const token = gatewayOwnField(work, 'interactionToken'); requireDiscordText(token); requireDiscordText(content); requireDiscordText(domain);
  const key = `interaction:${interaction}`;
  const update = DiscordChannelClient.prototype.updateInitialResponse.bind(client), post = DiscordChannelClient.prototype.sendWithoutReceipt.bind(client);
  const sleeper = options.sleep ?? ((ms: number) => delay(ms, undefined, {signal}));
  const sleep: DeliverySleep = async ms => {
    signal?.throwIfAborted();
    try {await sleeper(ms);} catch (error) {if (signal?.aborted) throw signal.reason; throw error;}
    signal?.throwIfAborted();
  };
  try {
    return await deliverTextIndexed(content, DEFAULT_DELIVERY_POLICY, async (part, chunk) => {
      signal?.throwIfAborted();
      if (part === 0) await update(application as bigint, token, chunk, signal);
      else await post(idempotentMessageRequest(channel as bigint, chunk, domain, key, part), signal);
    }, sleep);
  } catch (error) {
    if (signal?.aborted && error instanceof DeliveryFailure && error.source === signal.reason) throw signal.reason;
    throw error;
  }
}
