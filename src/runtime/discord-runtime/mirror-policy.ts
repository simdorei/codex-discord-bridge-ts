import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {InteractionAccessPolicy} from '../../discord/interaction-access.ts';
const remaining = state.remainingDiscordIds, targets = state.mirrorTargets;
/** Source ordered pair of store reads, not a new atomic multi-query snapshot.
 * Failure leaves the immutable base policy untouched; stale dynamic IDs are
 * replaced, never merged back as fallback after an error. */
export async function refreshMirrorPolicy(
  policy: InteractionAccessPolicy, database: string,
): Promise<InteractionAccessPolicy> {
  const ids = await remaining(database);
  const rows = await targets(database, (1n << 63n) - 1n);
  const values = new Set<bigint>();
  for (const id of [...ids.threadIds, ...ids.projectChannelIds]) if (id >= 0n) values.add(id);
  for (const row of rows) {
    if (row.discordChannelId >= 0n) values.add(row.discordChannelId);
    if (row.discordThreadId >= 0n) values.add(row.discordThreadId);
  }
  return InteractionAccessPolicy.prototype.withMirroredChannelIds.call(policy, [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
}
