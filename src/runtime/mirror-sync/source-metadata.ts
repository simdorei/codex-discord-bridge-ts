import {randomUUID} from 'node:crypto';
import {OwnedWorkerSlot, OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
export class NativeMirrorMetadata {
  // Essential command reads share the reserved Control budget with scope/store
  // work. Continuous observations cannot consume this capacity; saturation still
  // rejects with zero queue and never expands the global native worker limit.
  readonly #slot = new OwnedWorkerSlot('Control');
  async #read(kind: 'titles' | 'rollout', input: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted(); requireDiscordText(input);
    if (process.platform === 'win32') throw new Error('Windows mirror metadata unqualified');
    if (this.#slot.busy) throw new OwnedWorkerBusyError();
    const id = randomUUID(), path = pinNativeRuntimePath(input); let raw: unknown;
    try { raw = await this.#slot.run(new URL('./source-metadata-worker.ts', import.meta.url), {id, path, kind}, 10000, signal); }
    finally { await this.#slot.join(); }
    signal.throwIfAborted();
    if (boundedSerdeByteCount(raw, 4 * 1024 * 1024 + 32768) === null) throw new Error('Mirror metadata acknowledgement exceeds budget');
    const response = cloneOwnedSerdeValue(raw);
    if (own(response, 'id') !== id || own(response, 'path') !== path || own(response, 'kind') !== kind || own(response, 'ok') !== true) throw new Error('Mirror metadata read unconfirmed');
    return own(response, 'value');
  }
  async titles(path: string, signal: AbortSignal): Promise<ReadonlyMap<string, string>> {
    const value = await this.#read('titles', path, signal);
    if (!Array.isArray(value)) throw new TypeError('Expected title pairs');
    const result = new Map<string, string>();
    for (const pair of value) {
      if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError('Expected title pair');
      requireDiscordText(pair[0]); requireDiscordText(pair[1]); if (result.has(pair[0])) throw new TypeError('Duplicate title identity'); result.set(pair[0], pair[1]);
    }
    return result;
  }
  async rollout(path: string, signal: AbortSignal): Promise<boolean> {
    const value = await this.#read('rollout', path, signal); if (typeof value !== 'boolean') throw new TypeError('Expected rollout availability'); return value;
  }
}
Object.freeze(NativeMirrorMetadata.prototype);
