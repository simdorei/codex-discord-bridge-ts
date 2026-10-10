import {passiveErrorText} from '../core/passive-error-text.ts';
import {types} from 'node:util';
import {CodexThreadStore} from '../codex-state/store.ts';
import {resolveThreadRefPosix, ThreadResolveError} from '../codex-state/thread-reference.ts';
import {StateAccessFacade as state} from '../store/state-access-facade.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {rustTrim} from '../app-server/value.ts';
import {requireDiscordText} from '../discord/text.ts';
import {BridgeState} from './bridge-state.ts';
import type {CommandAction, SlashCommandAction} from './command-plan.ts';
import {ActionIntegerRangeError, InvalidActionRequestError, NoActionTargetError} from './action-executor/errors.ts';
import {snapshotSettingsBinding, validateSettingsSnapshot, validateLifecycleSettingsSnapshot, validateSelectedSettingsSnapshot,
  type FrozenSettingsBinding} from './action-executor/settings-snapshot.ts';

const mapped = state.mirroredThreadId;
type Settings = Extract<SlashCommandAction, {Settings: unknown}>['Settings'];
function settings(action: CommandAction): Settings | null {
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
 * No canonical fork, fallback replacement or execution. Full message settings
 * and lifecycle descriptions share this same original-target resolver. */
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
  async bind(action: CommandAction, channel: bigint): Promise<FrozenSettingsBinding | null> {
    const command = cloneOwnedSerdeValue(action) as CommandAction;
    if (typeof command !== 'string' && 'AutoReserve' in command) {
      const value = command.AutoReserve;
      if (typeof value.enabled !== 'boolean') throw new TypeError('Expected auto-reserve description flag');
      if (value.reference !== null) requireDiscordText(value.reference);
      return this.#bindReference(command, value.reference, channel, 'settings');
    }
    const value = settings(command);
    if (value === null || (value.model === null && value.effort === null && value.speed === null)) return null;
    return this.#bindReference(command, value.reference, channel, 'settings');
  }
  async bindLifecycle(action: CommandAction, channel: bigint): Promise<FrozenSettingsBinding | null> {
    const command = cloneOwnedSerdeValue(action) as CommandAction;
    if (typeof command === 'string') return null;
    for (const key of ['Archive', 'Resume', 'Recover', 'Repair', 'Stop'] as const) {
      if (key in command) {
        const value = (command as Record<typeof key, {readonly reference: string | null}>)[key];
        if (value.reference !== null) requireDiscordText(value.reference);
        return this.#bindReference(command, value.reference, channel, 'lifecycle');
      }
    }
    return null;
  }
  async #bindReference(command: CommandAction, inputReference: string | null, channel: bigint, label: 'settings' | 'lifecycle'): Promise<FrozenSettingsBinding> {
    channelId(channel);
    if (process.platform === 'win32') throw new Error('Windows original-thread reference binding is not yet qualified');
    const store = CodexThreadStore.open(this.#statePath), selected = this.#bridge.selectedThreadId();
    let target: string, route: FrozenSettingsBinding['route'];
    if (inputReference !== null) {
      const reference = rustTrim(inputReference);
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
    if (store.loadThread(target, false) === null) throw new InvalidActionRequestError(`${label} admission target is not an active original thread`);
    const binding = Object.freeze({target, route, command});
    await this.#validateRoute(binding, channel, label);
    return binding;
  }
  async validate(input: FrozenSettingsBinding, channel: bigint): Promise<void> {return this.#validateRoute(input, channel, 'settings');}
  async validateLifecycle(input: FrozenSettingsBinding, channel: bigint): Promise<void> {return this.#validateRoute(input, channel, 'lifecycle');}
  async #validateRoute(input: FrozenSettingsBinding, channel: bigint, label: 'settings' | 'lifecycle'): Promise<void> {
    const binding = snapshotSettingsBinding(input); channelId(channel);
    if (binding.route !== 'Explicit') sqliteChannel(channel);
    const validate = label === 'settings' ? validateSettingsSnapshot : validateLifecycleSettingsSnapshot;
    await validate(this.#mirrorPath, binding, channel, this.#bridge, {mirroredThreadId: mapped});
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

/** Shared full resolver alias; existing slash callers retain the identical class. */
export {SlashSettingsTargetResolver as SettingsTargetResolver};
export function isSettingsMutation(action: CommandAction): boolean {
  const command = cloneOwnedSerdeValue(action) as CommandAction;
  if (typeof command !== 'string' && 'AutoReserve' in command) return true;
  const value = settings(command);
  return value !== null && (value.model !== null || value.effort !== null || value.speed !== null);
}
