import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {DeliveryFailure} from '../../discord/delivery.ts';
import type {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import type {InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
import {snapshotActionResult, type ActionResult} from '../action-result.ts';
import {renderActionUi} from '../action-ui.ts';
import {deliverServerPrompts} from '../server-prompt-delivery.ts';
import {deliverNewReply} from './new-reply-delivery.ts';
import {deliverInteractionTextIdempotent, INTERACTION_FOLLOWUP_DOMAIN} from './text-delivery.ts';
type DeliveryWork = Pick<InboundInteractionWork, 'applicationId' | 'interactionId' | 'channelId' | 'userId' | 'interactionToken' | 'custodyIngressId'>;
function capture(input: DeliveryWork): DeliveryWork {
  const applicationId = gatewayOwnField(input, 'applicationId'), interactionId = gatewayOwnField(input, 'interactionId');
  const channelId = gatewayOwnField(input, 'channelId'), userId = gatewayOwnField(input, 'userId');
  for (const id of [applicationId, interactionId, channelId, userId]) if (typeof id !== 'bigint' || id <= 0n || id >= 1n << 64n) throw new TypeError('Expected interaction delivery identity');
  const interactionToken = gatewayOwnField(input, 'interactionToken'), custodyIngressId = gatewayOwnField(input, 'custodyIngressId');
  requireDiscordText(interactionToken); requireDiscordText(custodyIngressId);
  return Object.freeze({applicationId: applicationId as bigint, interactionId: interactionId as bigint, channelId: channelId as bigint, userId: userId as bigint, interactionToken, custodyIngressId});
}
/** Source action-result delivery order: /new special receipt first; prepared
 * server prompts before text; otherwise components or ordinary text. Caller has
 * already recorded the action result and retains its execution/admission owners. */
export async function deliverActionResult(input: DeliveryWork, value: ActionResult, database: string,
  server: PortableResidentLifecycle, http: DiscordChannelClient): Promise<void> {
  const work = capture(input), result = snapshotActionResult(value);
  if (await deliverNewReply(http, work, result, database)) return;
  if (result.ui?.kind === 'ServerPrompts') {
    await deliverServerPrompts({database, server, http, channelId: work.channelId, userId: work.userId, commandKey: work.custodyIngressId}, result.ui.prompts);
    await deliverInteractionTextIdempotent(http, work, result.text, INTERACTION_FOLLOWUP_DOMAIN); return;
  }
  const components = renderActionUi(result.ui);
  if (components.length === 0) {await deliverInteractionTextIdempotent(http, work, result.text, INTERACTION_FOLLOWUP_DOMAIN); return;}
  try {await DiscordChannelClient.prototype.updateInitialResponseWithComponents.call(http, work.applicationId, work.interactionToken, result.text, components);}
  catch (source) {throw new DeliveryFailure(1, 1, 1, source);}
}
