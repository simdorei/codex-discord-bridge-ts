import {NativeMirrorStore} from './store-native.ts';
import type {MirrorTarget} from '../../store/mirror-policy-read.ts';
import {MirrorCleanupProtectedError} from '../cleanup-refusal.ts';
/** Read-only pre-delete protection checks. These do not replace the atomic
 * BeginCleanup fence immediately before a DELETE or missing-room retirement. */
export class MirrorCleanupAdmission {
  readonly #store: NativeMirrorStore;
  constructor(store: NativeMirrorStore) { this.#store = store; Object.freeze(this); }
  async ensureNoRequests(channel: bigint, signal: AbortSignal): Promise<void> {
    if (typeof channel !== 'bigint' || channel <= 0n || channel >= 1n << 63n) throw new TypeError('Expected positive database-compatible Discord id');
    signal.throwIfAborted();
    const mappings = await NativeMirrorStore.prototype.execute.call(this.#store, {kind: 'MirrorTargets', args: []}, signal) as readonly MirrorTarget[];
    const targets: (string | null)[] = [null, ...mappings.filter(row => row.discordThreadId === channel).map(row => row.codexThreadId)];
    for (const target of targets) {
      const reason = await NativeMirrorStore.prototype.execute.call(this.#store, {kind: 'CleanupPending', args: [channel, target]}, signal);
      if (reason !== null) { if (typeof reason !== 'string') throw new TypeError('Expected protection reason'); throw new MirrorCleanupProtectedError(channel, reason); }
    }
  }
}
Object.freeze(MirrorCleanupAdmission.prototype);
