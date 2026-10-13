import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {TargetLocks} from '../../core/keyed-locks.ts';
import {MirrorSynchronizer} from './sync.ts';
export interface LimitedMirrorResult {
  readonly projects: number; readonly threads: number; readonly unavailable: number;
  readonly archived: 0; readonly orphanDeleted: 0; readonly projectsDeleted: 0; readonly limited: true;
}
/** Compatibility facade: explicit limits can never enter full cleanup. */
export class LimitedMirrorSynchronizer {
  readonly sync: (origin: bigint, limit: bigint, external?: AbortSignal) => Promise<LimitedMirrorResult>;
  private constructor(prepared: MirrorSynchronizer) {
    this.sync = async (origin, limit, external) => {
      if (typeof limit !== 'bigint') throw new TypeError('Explicit i64 sync limit required');
      const result = await prepared.sync(origin, limit, external);
      if (!result.limited || result.archived !== 0 || result.orphanDeleted !== 0 || result.projectsDeleted !== 0) throw new Error('Limited mirror result invariant violated');
      return Object.freeze({...result, archived: 0, orphanDeleted: 0, projectsDeleted: 0, limited: true});
    };
    Object.freeze(this);
  }
  static async create(codex: string, mirror: string, client: DiscordChannelClient, locks: TargetLocks, guild: bigint | null, signal: AbortSignal): Promise<LimitedMirrorSynchronizer> {
    return new LimitedMirrorSynchronizer(await MirrorSynchronizer.create(codex, mirror, client, locks, guild, signal));
  }
}
Object.freeze(LimitedMirrorSynchronizer.prototype);
