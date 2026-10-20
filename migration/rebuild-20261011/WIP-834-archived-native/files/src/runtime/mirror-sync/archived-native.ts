import {randomUUID} from 'node:crypto';
import {OwnedWorkerSlot, OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {MirrorCleanupProtectedError} from '../cleanup-refusal.ts';
import {validateMirrorThreadInfo} from './source-record.ts';
import type {ThreadInfo} from '../../codex-state/thread.ts';
function id(value: bigint): void { if (typeof value !== 'bigint' || value <= 0n || value >= 1n << 63n) throw new TypeError('Expected positive database-compatible room'); }
/** Archive-source verification runs synchronously inside the native store
 * transaction. The caller must pin Discord room identity and own the sync lock.
 * Only a successfully joined, bound response yields the fence token. */
export class NativeArchivedCleanup {
  readonly #codex: string; readonly #mirror: string;
  readonly #slot = new OwnedWorkerSlot('Control');
  constructor(codex: string, mirror: string) {
    this.#codex = pinNativeRuntimePath(codex); this.#mirror = pinNativeRuntimePath(mirror);
    if (this.#codex === this.#mirror) throw new TypeError('Codex and bridge paths must differ');
    Object.freeze(this);
  }
  async pending(channel: bigint, target: string, now: number, signal: AbortSignal): Promise<string | null> {
    const value = await this.#run('Pending', channel, target, now, null, null, signal);
    if (value !== null) requireDiscordText(value);
    return value as string | null;
  }
  async begin(channel: bigint, target: string, parent: bigint, now: number, expected: ThreadInfo, signal: AbortSignal): Promise<string> {
    id(parent); const snapshot = cloneOwnedSerdeValue(expected); validateMirrorThreadInfo(snapshot);
    if (snapshot.id !== target) throw new TypeError('Archive target differs from captured source');
    const value = await this.#run('Begin', channel, target, now, parent, snapshot, signal);
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) throw new TypeError('Invalid archived cleanup token');
    return value;
  }
  async #run(kind: 'Pending' | 'Begin', channel: bigint, target: string, now: number, parent: bigint | null, expected: ThreadInfo | null, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted(); id(channel); requireDiscordText(target);
    if (typeof now !== 'number' || !Number.isFinite(now) || Buffer.byteLength(target) > 16384) throw new TypeError('Invalid archive query');
    if (process.platform === 'win32') throw new Error('Windows archived cleanup unqualified');
    if (this.#slot.busy) throw new OwnedWorkerBusyError();
    const idValue = randomUUID(), request = {id: idValue, codex: this.#codex, mirror: this.#mirror, kind, channel, target, now, parent, expected};
    if (boundedSerdeByteCount(request, 262144) === null) throw new RangeError('Archived cleanup request exceeds budget');
    let raw: unknown;
    try { raw = await this.#slot.run(new URL('./archived-native-worker.ts', import.meta.url), request, 10000, signal); }
    finally { await this.#slot.join(); }
    signal.throwIfAborted();
    if (boundedSerdeByteCount(raw, 32768) === null) throw new RangeError('Archived cleanup response exceeds budget');
    const result = cloneOwnedSerdeValue(raw);
    for (const [key, value] of Object.entries({id: idValue, codex: this.#codex, mirror: this.#mirror, kind})) if (own(result, key) !== value) throw new Error('Unbound archived cleanup acknowledgement');
    if (own(result, 'ok') !== true) {
      const protection = Object.hasOwn(result as object, 'protected') ? own(result, 'protected') : undefined;
      if (kind === 'Begin' && protection !== undefined && own(protection, 'channel') === channel && typeof own(protection, 'reason') === 'string') throw new MirrorCleanupProtectedError(channel, own(protection, 'reason') as string);
      throw new Error('Archived cleanup outcome unconfirmed; no deletion authorized');
    }
    return own(result, 'value');
  }
}
Object.freeze(NativeArchivedCleanup.prototype);
