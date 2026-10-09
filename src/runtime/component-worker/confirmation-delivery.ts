import {types} from 'node:util';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {sendReceiptChunk} from '../completion/receipt-sender.ts';
import {isConfirmationPlan, ConfirmationError, type ConfirmationPlan} from './confirmation.ts';
/** Rust futures are lazy. JS callers must supply lazy functions, not already
 * started Promises, so clearing cannot begin before successful durable delivery. */
export async function sendThenClear(send: () => Promise<void>, clear: () => Promise<void>): Promise<void> {
  for (const fn of [send, clear]) if (typeof fn !== 'function' || types.isProxy(fn) || types.isGeneratorFunction(fn)) throw new TypeError('Expected lazy async confirmation operations');
  const sent = send(); if (!types.isPromise(sent)) throw new TypeError('Expected send Promise'); await sent;
  const cleared = clear(); if (!types.isPromise(cleared)) throw new TypeError('Expected clear Promise'); await cleared;
}
/** Caller owns completed action/custody. A confirmed receipt skips repeat POST,
 * then retries only clearing. Neither this function nor its plan reexecutes an
 * action or releases its persistent action claim. */
export async function deliverConfirmationAndClear(http: DiscordChannelClient, database: string, channelId: bigint,
  sourceMessageId: bigint | null, plan: ConfirmationPlan): Promise<void> {
  if (!isConfirmationPlan(plan)) throw new TypeError('Expected factory-created confirmation plan');
  for (const id of [channelId, ...(sourceMessageId === null ? [] : [sourceMessageId])]) if (typeof id !== 'bigint' || id <= 0n || id >= 1n << 64n) throw new TypeError('Expected Discord confirmation identity');
  const transport = Object.freeze({sendValidated: DiscordChannelClient.prototype.sendValidated.bind(http)});
  await sendThenClear(async () => {
    try {await sendReceiptChunk(database, transport, channelId, {domain: plan.domain, logicalKey: plan.logicalKey, chunkIndex: 0, content: plan.content});}
    catch (error) {throw new ConfirmationError('Delivery', passiveErrorText(error, 'confirmation delivery failed'), error);}
  }, async () => {
    if (sourceMessageId === null) return;
    try {await DiscordChannelClient.prototype.clearMessageComponents.call(http, channelId, sourceMessageId);}
    catch (error) {throw new ConfirmationError('Clear', passiveErrorText(error, 'button clearing failed'), error);}
  });
}
