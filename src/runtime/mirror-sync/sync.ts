import {dirname, join} from 'node:path';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {TargetLocks} from '../../core/keyed-locks.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {prepareRuntimeStorageOffThread} from '../discord-runtime/storage-preparation.ts';
import {now} from '../../store/queue-attach-goal.ts';
import {NativeMirrorStore} from './store-native.ts';
import {NativeMirrorSourceScope} from './source-scope.ts';
import {NativeMirrorMetadata} from './source-metadata.ts';
import {mirrorProjectIdentity} from './source-metadata-local.ts';
import {newMirrorThreadName} from './new-mirror-link.ts';
import {DiscordNewMirrorTransport} from './new-mirror-http.ts';
import {DiscordMirrorContainerTransport} from './container-http.ts';
import {DiscordMirrorInventoryTransport} from './inventory-http.ts';
import {DiscordMirrorDeletionTransport} from './delete-http.ts';
import {MirrorDeletionGuard} from './delete-guard.ts';
import {MirrorCategoryCustody} from './category-custody.ts';
import {MirrorProjectChannelCoordinator} from './project-channel.ts';
import {MirrorThreadChannelCoordinator} from './thread-channel.ts';
import {MirrorObsoleteCleanup} from './obsolete-cleanup.ts';
import {MirrorOrphanCleanup} from './orphan-cleanup.ts';
const token = Symbol('prepared mirror sync');
export interface MirrorSyncResult {
  readonly projects: number; readonly threads: number; readonly unavailable: number;
  readonly archived: number; readonly orphanDeleted: number; readonly projectsDeleted: number; readonly limited: boolean;
}
function id(value: bigint): void {
  if (typeof value !== 'bigint' || value <= 0n || value >= 1n << 63n) throw new TypeError('Expected positive database-compatible Discord id');
}
/** Shared limited/full source synchronization. Full cleanup follows successful
 * source synchronization under the same lock and total deadline. Callers retain
 * process-level single-instance ownership; action dispatch wiring is separate. */
export class MirrorSynchronizer {
  readonly sync: (origin: bigint, limit: bigint | null, external?: AbortSignal) => Promise<MirrorSyncResult>;
  private constructor(owned: symbol, codex: string, mirror: string, client: DiscordChannelClient, locks: TargetLocks, guild: bigint | null) {
    if (owned !== token) throw new TypeError('Prepared mirror sync required');
    const store = new NativeMirrorStore(mirror), scope = new NativeMirrorSourceScope(codex, mirror), metadata = new NativeMirrorMetadata();
    const rooms = new DiscordMirrorContainerTransport(client), inventory = new DiscordMirrorInventoryTransport(client);
    const deletion = new MirrorDeletionGuard(store, new DiscordMirrorDeletionTransport(client));
    const categories = new MirrorCategoryCustody(store, rooms), projects = new MirrorProjectChannelCoordinator(store, rooms);
    const threads = new MirrorThreadChannelCoordinator(store, new DiscordNewMirrorTransport(client));
    const obsolete = new MirrorObsoleteCleanup(codex, mirror, store, client), orphans = new MirrorOrphanCleanup(store, client);
    this.sync = async (origin, limit, external) => {
      id(origin); if (limit !== null && (typeof limit !== 'bigint' || limit < -(1n << 63n) || limit >= 1n << 63n)) throw new TypeError('Nullable i64 sync limit required');
      external?.throwIfAborted();
      const budget = new AbortController(), waiting = new AbortController();
      const operationError = new Error('mirror sync phase=operation; deadline=120s total including lock wait; earlier changes may have completed; outcome unconfirmed; no automatic retry');
      const lockError = new Error('mirror sync phase=lock_wait; deadline=10s; not started; current owner not cancelled');
      const timer = setTimeout(() => budget.abort(operationError), 120000), lockTimer = setTimeout(() => waiting.abort(lockError), 10000);
      const signal = external === undefined ? budget.signal : AbortSignal.any([budget.signal, external]); let lease;
      try {
        lease = await locks.acquire('mirror-sync-operation', AbortSignal.any([signal, waiting.signal])); clearTimeout(lockTimer); signal.throwIfAborted();
        await deletion.ensureReconciled(signal); const started = now();
        const candidates = await scope.load(limit, signal);
        let actualGuild = guild;
        if (actualGuild === null) {
          const originChannel = await rooms.channel(origin, signal);
          if (originChannel === null || originChannel.id !== origin || originChannel.guildId === null) throw new Error('cannot resolve exact Discord guild for sync');
          actualGuild = originChannel.guildId;
        }
        let channels = await inventory.channels(actualGuild, signal);
        const category = await categories.category(actualGuild, channels, signal);
        const titles = await metadata.titles(join(dirname(codex), 'session_index.jsonl'), signal);
        const parents = new Map<string, bigint>(); let count = 0, unavailable = 0;
        for (const thread of candidates) {
          signal.throwIfAborted();
          if (!await metadata.rollout(thread.rolloutPath, signal)) { unavailable++; continue; }
          const [key, name] = mirrorProjectIdentity(thread.cwd); let parent = parents.get(key);
          if (parent === undefined) {
            const result = await projects.resolve(actualGuild, category, key, name, channels, signal);
            parent = result.channel.id; channels = result.channels; parents.set(key, parent);
          }
          await threads.sync(actualGuild, parent, thread.id, key, newMirrorThreadName(titles.get(thread.id) ?? thread.title, thread.id), signal);
          count++;
        }
        signal.throwIfAborted();
        let archived = 0, orphanDeleted = 0, projectsDeleted = 0;
        if (limit === null) {
          archived = await obsolete.retireObsolete(actualGuild, started, signal);
          [orphanDeleted, projectsDeleted] = await orphans.run(actualGuild, started, signal);
        }
        signal.throwIfAborted();
        return Object.freeze({projects: parents.size, threads: count, unavailable, archived, orphanDeleted, projectsDeleted, limited: limit !== null});
      } finally { clearTimeout(timer); clearTimeout(lockTimer); lease?.release(); }
    };
    Object.freeze(this);
  }
  static async create(codexPath: string, mirrorPath: string, client: DiscordChannelClient, locks: TargetLocks, guild: bigint | null, signal: AbortSignal): Promise<MirrorSynchronizer> {
    signal.throwIfAborted(); if (guild !== null) id(guild);
    const codex = pinNativeRuntimePath(codexPath), mirror = pinNativeRuntimePath(mirrorPath);
    const lease = await locks.acquire('mirror-sync-operation', signal);
    try { await prepareRuntimeStorageOffThread({stateDb: codex, mirrorDb: mirror}, 10000, signal); return new MirrorSynchronizer(token, codex, mirror, client, locks, guild); }
    finally { lease.release(); }
  }
}
Object.freeze(MirrorSynchronizer.prototype);
