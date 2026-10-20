import {randomUUID} from 'node:crypto';
import {OwnedWorkerSlot, OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {ThreadInfo} from '../../codex-state/thread.ts';
function integer(value: unknown): void {
  if (typeof value !== 'bigint' || value < -(1n << 63n) || value >= 1n << 63n) throw new TypeError('Expected i64 source field');
}
export class NativeMirrorSourceScope {
  readonly #codex: string;
  readonly #mirror: string;
  readonly #slot = new OwnedWorkerSlot('Control');
  constructor(codex: string, mirror: string) {
    this.#codex = pinNativeRuntimePath(codex); this.#mirror = pinNativeRuntimePath(mirror);
    if (this.#codex === this.#mirror) throw new TypeError('Codex and bridge databases must be distinct');
    Object.freeze(this);
  }
  async load(limit: bigint | null, signal: AbortSignal): Promise<readonly ThreadInfo[]> {
    signal.throwIfAborted(); if (limit !== null) integer(limit);
    if (process.platform === 'win32') throw new Error('Windows mirror source scope unqualified');
    if (this.#slot.busy) throw new OwnedWorkerBusyError();
    const id = randomUUID(); let raw: unknown;
    try { raw = await this.#slot.run(new URL('./source-scope-worker.ts', import.meta.url), {id, codex: this.#codex, mirror: this.#mirror, limit}, 10000, signal); }
    finally { await this.#slot.join(); }
    signal.throwIfAborted();
    if (boundedSerdeByteCount(raw, 4 * 1024 * 1024 + 32768) === null) throw new Error('Over-budget source scope acknowledgement');
    const result = cloneOwnedSerdeValue(raw);
    if (own(result, 'id') !== id || own(result, 'codex') !== this.#codex || own(result, 'mirror') !== this.#mirror || own(result, 'limit') !== limit || own(result, 'ok') !== true) throw new Error('Unconfirmed mirror source scope; no partial inventory accepted');
    const value = own(result, 'value');
    if (!Array.isArray(value)) throw new TypeError('Expected source thread array');
    const keys = ['id', 'title', 'cwd', 'rolloutPath', 'model', 'reasoningEffort', 'updatedAt', 'tokensUsed', 'archivedAt'];
    for (const row of value) {
      if (row === null || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) throw new TypeError('Expected exact source thread');
      for (const key of keys.slice(0, 6)) requireDiscordText(own(row, key));
      integer(own(row, 'updatedAt')); integer(own(row, 'archivedAt')); if (own(row, 'tokensUsed') !== null) integer(own(row, 'tokensUsed'));
    }
    return value as readonly ThreadInfo[];
  }
}
Object.freeze(NativeMirrorSourceScope.prototype);
