import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {rustDurationFromSecondsF64} from '../../core/rust-duration.ts';
import type {MirrorTarget, RemainingDiscordIds} from '../../store/mirror-policy-read.ts';
import type {StaleMirrorProject} from '../../store/mirror-stale.ts';
import type {MirrorInventoryChannel} from '../../discord/mirror-inventory-request.ts';
import {NativeMirrorStore} from './store-native.ts';
import {DiscordMirrorInventoryTransport} from './inventory-http.ts';
import {DiscordMirrorContainerTransport} from './container-http.ts';
import {DiscordMirrorDeletionTransport} from './delete-http.ts';
import {MirrorDeletionGuard} from './delete-guard.ts';
import {MirrorCleanupAdmission} from './cleanup-admission.ts';
function id(value: bigint): bigint {
  if (typeof value !== 'bigint' || value <= 0n || value >= 1n << 63n) throw new TypeError('Expected positive database-compatible Discord id');
  return value;
}
function validate(channel: MirrorInventoryChannel, guild: bigint, kind: bigint, parent: bigint | null): void {
  if (channel.guildId !== guild || channel.kind !== kind || parent !== null && channel.parentId !== parent) throw new Error('Cleanup room has wrong guild, kind, or parent');
}
/** Source orphan_cleanup.rs coordinator. Caller owns the global sync lock and
 * total deadline and must reconcile prior cleanup fences before entering.
 * Existing mappings are checked again after asynchronous inventory/protection
 * reads. Only the persistent deletion guard may dispatch an irreversible call. */
export class MirrorOrphanCleanup {
  readonly run: (guild: bigint, started: number, signal: AbortSignal) => Promise<readonly [number, number]>;
  constructor(store: NativeMirrorStore, client: DiscordChannelClient) {
    const inventory = new DiscordMirrorInventoryTransport(client), rooms = new DiscordMirrorContainerTransport(client);
    const admission = new MirrorCleanupAdmission(store), guard = new MirrorDeletionGuard(store, new DiscordMirrorDeletionTransport(client));
    this.run = async (guild, started, signal) => {
      id(guild); signal.throwIfAborted();
      const ids = await NativeMirrorStore.prototype.execute.call(store, {kind: 'RemainingIds', args: []}, signal) as RemainingDiscordIds;
      const startedMs = rustDurationFromSecondsF64(started) / 1000000n;
      let deleted = 0, projects = 0;
      for (const parentId of ids.projectChannelIds) {
        const parent = id(parentId);
        for (const entry of await inventory.threadInventory(guild, parent, signal)) {
          const channel = entry.channel;
          const createdMs = (channel.id >> 22n) + 1420070400000n;
          if (!entry.ownedByBot || channel.kind !== 11n || createdMs >= startedMs || await NativeMirrorStore.prototype.execute.call(store, {kind: 'IsMapped', args: [id(channel.id)]}, signal)) continue;
          validate(channel, guild, 11n, parent);
          await admission.ensureNoRequests(channel.id, signal);
          if (await NativeMirrorStore.prototype.execute.call(store, {kind: 'IsMapped', args: [channel.id]}, signal)) continue;
          await guard.deleteGuarded(channel.id, null, signal); deleted++;
        }
      }
      const stale = await NativeMirrorStore.prototype.execute.call(store, {kind: 'StaleProjects', args: [[], started]}, signal) as readonly StaleMirrorProject[];
      for (const row of stale) {
        const mappings = await NativeMirrorStore.prototype.execute.call(store, {kind: 'MirrorTargets', args: []}, signal) as readonly MirrorTarget[];
        if (mappings.some(mapping => mapping.discordChannelId === row.discordChannelId)) continue;
        const channelId = id(row.discordChannelId);
        await admission.ensureNoRequests(channelId, signal);
        const channel = await rooms.channel(channelId, signal);
        if (channel !== null) {
          validate(channel, guild, 0n, null);
          if ((await inventory.threadInventory(guild, channelId, signal)).length !== 0) throw new Error(`obsolete project ${channelId} still contains protected threads`);
          await admission.ensureNoRequests(channelId, signal);
          await guard.deleteGuarded(channelId, null, signal);
        } else await guard.fenceMissingRoom(channelId, null, signal);
        if (!await NativeMirrorStore.prototype.execute.call(store, {kind: 'RetireProject', args: [row.projectKey, row.discordChannelId, started]}, signal)) throw new Error('project mapping changed during cleanup');
        projects++;
      }
      return Object.freeze([deleted, projects] as const);
    };
    Object.freeze(this);
  }
}
Object.freeze(MirrorOrphanCleanup.prototype);
