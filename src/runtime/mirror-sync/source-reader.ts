import {randomUUID} from 'node:crypto';
import {OwnedWorkerSlot, OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {ThreadInfo} from '../../codex-state/thread.ts';
import {validateMirrorThreadInfo} from './source-record.ts';
/** Read-only Codex queries for cleanup decisions. Each native owner is joined
 * before returning; failures are never converted to source absence. Transfer
 * budget is not a bound on worker SQLite/V8 materialization. */
export class NativeMirrorSourceReader {
  readonly #path: string;
  readonly #slot = new OwnedWorkerSlot('Control');
  constructor(path: string) { this.#path = pinNativeRuntimePath(path); Object.freeze(this); }
  async activeIds(signal: AbortSignal): Promise<readonly string[]> {
    const value = await this.#read('ActiveIds', null, false, signal);
    if (!Array.isArray(value)) throw new TypeError('Expected complete active identity inventory');
    for (const id of value) requireDiscordText(id);
    if (new Set(value).size !== value.length) throw new TypeError('Duplicate source identity');
    return value as readonly string[];
  }
  async thread(thread: string, archived: boolean, signal: AbortSignal): Promise<ThreadInfo | null> {
    requireDiscordText(thread); if (Buffer.byteLength(thread) > 16384 || typeof archived !== 'boolean') throw new TypeError('Invalid exact source query');
    const value = await this.#read('Thread', thread, archived, signal);
    if (value === null) return null;
    validateMirrorThreadInfo(value);
    if (value.id !== thread) throw new TypeError('Source row identity changed');
    return value;
  }
  async #read(kind: 'ActiveIds' | 'Thread', thread: string | null, archived: boolean, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (this.#slot.busy) throw new OwnedWorkerBusyError();
    const id = randomUUID(); let raw: unknown;
    try { raw = await this.#slot.run(new URL('./source-reader-worker.ts', import.meta.url), {id, path: this.#path, kind, thread, archived}, 10000, signal); }
    finally { await this.#slot.join(); }
    signal.throwIfAborted();
    if (boundedSerdeByteCount(raw, 4 * 1024 * 1024 + 32768) === null) throw new RangeError('Source acknowledgement exceeds budget');
    const result = cloneOwnedSerdeValue(raw);
    for (const [key, expected] of Object.entries({id, path: this.#path, kind, thread, archived, ok: true})) if (own(result, key) !== expected) throw new Error('Unconfirmed source query; absence not established');
    return own(result, 'value');
  }
}
Object.freeze(NativeMirrorSourceReader.prototype);
