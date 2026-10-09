import {types} from 'node:util';
import {PortableResidentLifecycle} from '../app-server/portable-resident-lifecycle.ts';
import {pendingServerRequestEqual} from '../app-server/server-request-state.ts';
import {ServerRequestOccurrence} from '../protocol/ids.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {DiscordChannelClient} from '../discord/channel-client.ts';
import {gatewayOwnField} from '../discord/gateway/values.ts';
import {requireDiscordText, splitDeliveryChunks} from '../discord/text.ts';
import {sendReceiptChunk} from './completion/receipt-sender.ts';
import {prepareOneServerPrompt, preparedPromptEqual, isPreparedPrompt, PromptRedisplayChangedError, type PreparedPrompt} from './server-prompt-redisplay.ts';
export interface PromptDeliveryContext {
  readonly database: string; readonly server: PortableResidentLifecycle; readonly http: DiscordChannelClient;
  readonly channelId: bigint; readonly userId: bigint; readonly commandKey: string;
}
/** Deliver existing prompts only, revalidating each chunk. Caller retains all
 * borrowed owners until this promise and any failed HTTP/receipt writes settle.
 * No approval/input response is submitted, and no prompt occurrence is created. */
export async function deliverServerPrompts(context: PromptDeliveryContext, input: readonly PreparedPrompt[]): Promise<void> {
  const database = gatewayOwnField(context, 'database'), commandKey = gatewayOwnField(context, 'commandKey');
  requireDiscordText(database); requireDiscordText(commandKey);
  const server = gatewayOwnField(context, 'server') as PortableResidentLifecycle, http = gatewayOwnField(context, 'http') as DiscordChannelClient;
  const channel = gatewayOwnField(context, 'channelId'), user = gatewayOwnField(context, 'userId');
  if (typeof channel !== 'bigint' || channel <= 0n || channel >= 1n << 64n || typeof user !== 'bigint' || user < 0n || user >= 1n << 64n) throw new TypeError('Expected prompt delivery actor');
  if (!Array.isArray(input) || types.isProxy(input)) throw new TypeError('Expected prepared prompt list');
  const prompts: PreparedPrompt[] = [];
  for (let i = 0; i < input.length; i++) {const value = gatewayOwnField(input, String(i)); if (!isPreparedPrompt(value)) throw new TypeError('Expected prepared prompt snapshot'); prompts.push(value);}
  const transport = Object.freeze({sendValidated: DiscordChannelClient.prototype.sendValidated.bind(http)});
  for (const prepared of prompts) {
    // Serde newtype [u8;16] is a JSON integer array, NOT a UUID string or object.
    const occurrence = Array.from(ServerRequestOccurrence.prototype.asBytes.call(prepared.request.occurrence), byte => BigInt(byte));
    const key = serializeSerdeValue([commandKey, prepared.generation, prepared.request.id, occurrence]);
    const chunks = splitDeliveryChunks(prepared.prompt.text, true);
    for (let index = 0; index < chunks.length; index++) {
      const current = await prepareOneServerPrompt(database, server, prepared.request, prepared.generation, channel, user);
      if (!preparedPromptEqual(current, prepared)
        || !PortableResidentLifecycle.prototype.pendingServerRequests.call(server, null).some(request => pendingServerRequestEqual(request, prepared.request))) throw new PromptRedisplayChangedError();
      const components = index + 1 === chunks.length ? prepared.prompt.components : [];
      await sendReceiptChunk(database, transport, channel, {domain: 'server-request/redisplay/v1', logicalKey: key, chunkIndex: index, content: chunks[index]!}, components);
    }
  }
}
