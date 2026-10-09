import {passiveErrorText} from '../core/passive-error-text.ts';
import {types} from 'node:util';
import {CodexThreadStore} from '../codex-state/store.ts';
import {resolveThreadRefPosix, ThreadResolveError} from '../codex-state/thread-reference.ts';
import {StateAccessFacade as state} from '../store/state-access-facade.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {rustTrim} from '../app-server/value.ts';
import {requireDiscordText} from '../discord/text.ts';
import {BridgeState} from './bridge-state.ts';
import type {SlashCommandAction} from './command-plan.ts';
import {ActionIntegerRangeError, InvalidActionRequestError, NoActionTargetError} from './action-executor/errors.ts';
import {snapshotSettingsBinding, validateSettingsSnapshot, validateSelectedSettingsSnapshot,
  type FrozenSettingsBinding} from './action-executor/settings-snapshot.ts';

const mapped = state.mirroredThreadId;
type Settings = Extract<SlashCommandAction, {Settings: unknown}>['Settings'];
function settings(action: SlashCommandAction): Settings | null {
  if (typeof action === 'string' || !Object.hasOwn(action, 'Settings')) return null;
  const value = (action as {Settings: Settings}).Settings;
  for (const key of ['reference', 'model', 'effort', 'speed'] as const) {
    if (value[key] !== null) requireDiscordText(value[key]);
  }
  return value;
}
function channelId(channel: bigint): void {
  if (typeof channel !== 'bigint' || channel < 0n || channel >= 1n << 64n) throw new TypeError('Expected u64 channel');
}
function sqliteChannel(channel: bigint): void {
  channelId(channel);
  if (channel >= 1n << 63n) throw new ActionIntegerRangeError();
}
export function isSlashSettingsMutation(action: SlashCommandAction): boolean {
  const value = settings(cloneOwnedSerdeValue(action) as SlashCommandAction);
  return value !== null && (value.model !== null || value.effort !== null || value.speed !== null);
}

/** Concrete original-thread settings binding for this Linux/POSIX migration.
 * Uses real read-only Codex state, central mirror lookup and original BridgeState.
 * No canonical fork, fallback replacement or execution. Non-slash AutoReserve and
 * lifecycle action binding are separate; removed auto-reserve cannot enter here. */
export class SlashSettingsTargetResolver {
  readonly #statePath: string;
  readonly #mirrorPath: string;
  readonly #bridge: Pick<BridgeState, 'selectedThreadId'>;
  constructor(statePath: string, mirrorPath: string, bridge: BridgeState) {
    requireDiscordText(statePath); requireDiscordText(mirrorPath);
    this.#statePath = statePath; this.#mirrorPath = mirrorPath;
    this.#bridge = Object.freeze({selectedThreadId: BridgeState.prototype.selectedThreadId.bind(bridge)});
    Object.freeze(this);
  }
  async bind(action: SlashCommandAction, channel: bigint): Promise<FrozenSettingsBinding | null> {
    const command = cloneOwnedSerdeValue(action) as SlashCommandAction, value = settings(command);
    if (value === null || (value.model === null && value.effort === null && value.speed === null)) return null;
    channelId(channel);
    if (process.platform === 'win32') throw new Error('Windows original-thread reference binding is not yet qualified');
    const store = CodexThreadStore.open(this.#statePath), selected = this.#bridge.selectedThreadId();
    let target: string, route: FrozenSettingsBinding['route'];
    if (value.reference !== null) {
      const reference = rustTrim(value.reference);
      const exact = store.loadThread(reference, false);
      target = (exact ?? resolveThreadRefPosix(store.loadRecentThreads(0n), reference, selected, false)).id;
      route = 'Explicit';
    } else {
      sqliteChannel(channel);
      const mirror = await mapped(this.#mirrorPath, channel);
      if (mirror !== null) {target = mirror; route = 'Mapped';}
      else {
        if (selected === null) throw new NoActionTargetError();
        target = selected; route = 'Selected';
      }
    }
    if (store.loadThread(target, false) === null) throw new InvalidActionRequestError('settings admission target is not an active original thread');
    const binding = Object.freeze({target, route, command});
    await this.validate(binding, channel);
    return binding;
  }
  async validate(input: FrozenSettingsBinding, channel: bigint): Promise<void> {
    const binding = snapshotSettingsBinding(input); channelId(channel);
    if (binding.route !== 'Explicit') sqliteChannel(channel);
    await validateSettingsSnapshot(this.#mirrorPath, binding, channel, this.#bridge, {mirroredThreadId: mapped});
  }
  validateSelectedSnapshot(input: FrozenSettingsBinding): void {
    validateSelectedSettingsSnapshot(snapshotSettingsBinding(input), this.#bridge);
  }
}
Object.freeze(SlashSettingsTargetResolver.prototype);

/** Exact supported ActionError request-rejection families; no custom coercion. */
export function isSettingsRequestRejection(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || types.isProxy(error)) return false;
  const prototype = Object.getPrototypeOf(error);
  return prototype === NoActionTargetError.prototype || prototype === InvalidActionRequestError.prototype
    || prototype === ThreadResolveError.prototype;
}
export function settingsErrorText(error: unknown): string {
  return passiveErrorText(error, 'settings admission failed');
}
