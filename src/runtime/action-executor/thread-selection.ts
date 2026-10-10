import {CodexThreadStore} from '../../codex-state/store.ts';
import {resolveThreadRefPosix, ThreadResolveError} from '../../codex-state/thread-reference.ts';
import type {ThreadInfo} from '../../codex-state/thread.ts';
import {rustTrim} from '../../app-server/value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {StateAccessFacade} from '../../store/state-access-facade.ts';
import {BridgeState} from '../bridge-state.ts';
import {ActionIntegerRangeError, InvalidActionRequestError, NoActionTargetError} from './errors.ts';
const mapped = StateAccessFacade.mirroredThreadId;
/** Original-target selection only. Never canonicalizes forks or substitutes a
 * selected target for a stale room mapping. Synchronous Codex/bridge reads need
 * the production owned filesystem boundary; Windows reference parity pending. */
export class ActionThreadSelection {
  readonly #statePath: string;
  readonly #mirrorPath: string;
  readonly #selected: () => string | null;
  readonly #select: (id: string | null) => void;
  constructor(statePath: string, mirrorPath: string, bridge: BridgeState) {
    requireDiscordText(statePath); requireDiscordText(mirrorPath);
    this.#statePath = statePath; this.#mirrorPath = mirrorPath;
    this.#selected = BridgeState.prototype.selectedThreadId.bind(bridge);
    this.#select = BridgeState.prototype.setSelectedThreadId.bind(bridge);
    Object.freeze(this);
  }
  async target(channel: bigint): Promise<readonly [string, 'mirror' | 'selected']> {
    if (typeof channel !== 'bigint' || channel < 0n || channel >= 1n << 64n) throw new TypeError('Expected u64 channel');
    if (channel >= 1n << 63n) throw new ActionIntegerRangeError();
    const mirror = await mapped(this.#mirrorPath, channel);
    if (mirror !== null) return Object.freeze([mirror, 'mirror'] as const);
    const selected = this.#selected();
    if (selected === null) throw new NoActionTargetError();
    return Object.freeze([selected, 'selected'] as const);
  }
  async targetThreadId(channel: bigint): Promise<string> {return (await this.target(channel))[0];}
  resolveReference(input: string, archived = false): ThreadInfo {
    requireDiscordText(input);
    if (typeof archived !== 'boolean') throw new TypeError('Expected archived flag');
    if (process.platform === 'win32') throw new Error('Windows action reference resolution is not yet qualified');
    const store = CodexThreadStore.open(this.#statePath), reference = rustTrim(input);
    const exact = store.loadThread(reference, archived);
    if (exact !== null) return exact;
    const threads = archived ? store.loadArchivedThreads(0n) : store.loadRecentThreads(0n);
    return resolveThreadRefPosix(threads, reference, this.#selected(), archived);
  }
  async resolveThread(channel: bigint, reference: string | null): Promise<ThreadInfo> {
    if (reference !== null) return this.resolveReference(reference, false);
    const target = await this.targetThreadId(channel);
    const thread = CodexThreadStore.open(this.#statePath).loadThread(target, false);
    if (thread === null) throw new ThreadResolveError('NotFound', target);
    return thread;
  }
  select(reference: string): string {
    const thread = this.resolveReference(reference, false);
    this.#select(thread.id);
    const workspace = thread.cwd.split(/[\\/]/u).filter(part => part !== '').at(-1) ?? '-';
    return `Selected Codex thread\nthread_id: ${thread.id}\nworkspace: ${workspace}\ntitle: ${thread.title}`;
  }
  async whereMessage(channel: bigint): Promise<string> {
    const [target, source] = await this.target(channel);
    const thread = await this.resolveThread(channel, null);
    if (thread.id !== target) throw new InvalidActionRequestError('where target changed during lookup');
    const mapping = source === 'mirror' ? 'mapped to this Discord room' : 'unmapped; using global selected thread (not a room mapping)';
    return `Codex target\nsource: ${source}\nthread_id: ${target}\ndiscord_mapping: ${mapping}\ntitle: ${thread.title}\ncwd: ${thread.cwd}`;
  }
}
Object.freeze(ActionThreadSelection.prototype);
