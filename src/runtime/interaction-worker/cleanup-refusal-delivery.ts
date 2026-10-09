import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {cleanupRefusalFromOutcome, type CleanupRefusal} from '../../store/async-resolution-cleanup-refusal.ts';
import type {InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
import {recordCleanupNotificationFailure} from '../cleanup-notification-failure.ts';
import {ExecutionCustody} from './execution-custody.ts';
/** Source refusal notification only. Caller already began the matching custody
 * and holds the queue item's admission permit. This does not perform a deletion,
 * convert arbitrary action errors or authorize a refusal from untrusted input. */
export async function deliverCleanupRefusal(work: InboundInteractionWork, custody: ExecutionCustody,
  client: DiscordChannelClient, refusal: CleanupRefusal, signal?: AbortSignal): Promise<false> {
  signal?.throwIfAborted();
  const applicationId = gatewayOwnField(work, 'applicationId'), token = gatewayOwnField(work, 'interactionToken');
  const database = gatewayOwnField(work, 'custodyDatabase'), ingressId = gatewayOwnField(work, 'custodyIngressId');
  if (typeof applicationId !== 'bigint' || applicationId <= 0n || applicationId >= 1n << 64n) throw new TypeError('Expected interaction application ID');
  requireDiscordText(token); requireDiscordText(database); requireDiscordText(ingressId);
  const room = gatewayOwnField(refusal, 'room'), reason = gatewayOwnField(refusal, 'reason');
  const outcome = Object.freeze({kind: 'mirror_cleanup_refused', version: 1n, sync_completed: false,
    blocked_room_id: room, protection_reason: reason, delete_dispatched: false, earlier_changes_possible: true});
  const captured = cleanupRefusalFromOutcome(outcome);
  if (captured === undefined) throw new TypeError('Expected validated pre-delete cleanup refusal');
  const content = `Mirror sync stopped.\nroom: ${captured.room}\nreason: ${captured.reason}\nNo deletion was dispatched for this room. Earlier sync changes may have completed.\nPending work is preserved; this request will not retry automatically.`;
  // Persist before any HTTP operation, including transport/token validation.
  await ExecutionCustody.prototype.recordResult.call(custody, outcome);
  try {await DiscordChannelClient.prototype.updateInitialResponse.call(client, applicationId, token, content, signal);}
  catch (error) {throw await recordCleanupNotificationFailure(database, ingressId, 'delivery', error);}
  return false;
}
