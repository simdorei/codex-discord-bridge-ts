import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {NativeMirrorStore} from './store-native.ts';
import {MirrorProjectCustody} from './project-custody.ts';
import type {DiscordMirrorContainerTransport} from './container-http.ts';
import type {MirrorInventoryChannel} from '../../discord/mirror-inventory-request.ts';
import type {MirrorProjectSnapshot, MirrorProjectMatch} from '../../store/mirror-project-creation.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';

export function mirrorProjectChannelName(name: string): string {
  requireDiscordText(name);
  let result = '';
  for (const character of name.toLowerCase()) {
    const selected = /^[a-z0-9가-힣._-]$/u.test(character) ? character : '-';
    if (selected !== '-' || !result.endsWith('-')) result += selected;
  }
  result = result.replace(/^[-._]+|[-._]+$/gu, '');
  if (!result.startsWith('codex-')) result = `codex-${result}`;
  // The admitted output alphabet consists exclusively of one-unit UTF-16 chars.
  return result.slice(0, 80).replace(/^[-._]+|[-._]+$/gu, '');
}
function id(value: bigint): bigint {
  if (typeof value !== 'bigint' || value <= 0n || value >= 1n << 63n) throw new TypeError('Expected positive database-compatible Discord id');
  return value;
}
function method<T extends Function>(remote: unknown, key: string): T {
  const fn = own(remote, key);
  if (typeof fn !== 'function' || types.isProxy(fn) || types.isGeneratorFunction(fn)) throw new TypeError('Expected owned container method');
  return fn as T;
}
async function native<T>(promise: Promise<T>): Promise<T> {
  if (!types.isPromise(promise)) throw new TypeError('Expected native transport promise');
  return promise;
}
export interface MirrorProjectChannelResult {
  readonly channel: MirrorInventoryChannel;
  readonly channels: readonly MirrorInventoryChannel[];
}
/** One project resolution. Caller supplies a captured inventory and adopts the
 * returned inventory only on success. Global sync lock/deadline are caller-owned. */
export class MirrorProjectChannelCoordinator {
  readonly resolve: (guild: bigint, category: bigint, key: string, name: string, input: readonly MirrorInventoryChannel[], signal: AbortSignal) => Promise<MirrorProjectChannelResult>;
  constructor(store: NativeMirrorStore, remote: DiscordMirrorContainerTransport) {
    const read = method<DiscordMirrorContainerTransport['channel']>(remote, 'channel');
    const update = method<DiscordMirrorContainerTransport['update']>(remote, 'update');
    const custody = new MirrorProjectCustody(store, remote);
    this.resolve = async (guild, category, key, name, input, signal) => {
      id(guild); id(category); requireDiscordText(key); requireDiscordText(name); signal.throwIfAborted();
      const captured = cloneOwnedSerdeValue(input) as readonly MirrorInventoryChannel[];
      if (!Array.isArray(captured)) throw new TypeError('Expected channel inventory');
      const channels = [...captured];
      const stored = await NativeMirrorStore.prototype.execute.call(store, {kind: 'FindProject', args: [key]}, signal) as MirrorProjectMatch | null;
      const expected = await NativeMirrorStore.prototype.execute.call(store, {kind: 'ProjectSnapshot', args: [key]}, signal) as MirrorProjectSnapshot;
      if (stored === null ? expected.length !== 0 : !expected.some(([alias, channel]) => alias === stored.storedKey && channel === stored.channelId)) throw new Error('project mapping changed before lookup');
      let channel = await custody.confirmed(guild, category, key, expected, signal);
      if (channel === null && stored !== null) channel = await native<MirrorInventoryChannel | null>(Reflect.apply(read, remote, [id(stored.channelId), signal]));
      signal.throwIfAborted();
      const topic = `Codex project mirror: ${name}`;
      let expectedName = mirrorProjectChannelName(name);
      if (channel === null) {
        for (const candidate of channels.filter(item => item.kind === 0n && item.parentId === category && item.topic === topic)) {
          const mapped = await NativeMirrorStore.prototype.execute.call(store, {kind: 'ProjectForChannel', args: [id(candidate.id)]}, signal);
          if (mapped === null) {
            await NativeMirrorStore.prototype.execute.call(store, {kind: 'ProjectAdoptable', args: [candidate.id, category]}, signal);
            channel = candidate;
            break;
          }
        }
      }
      if (channels.some(item => item.name === expectedName && (channel === null || channel.id !== item.id))) expectedName += `-${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 6)}`;
      if (channel !== null) {
        channel = cloneOwnedSerdeValue(channel) as MirrorInventoryChannel;
        if (channel.guildId !== guild || channel.kind !== 0n) throw new Error('stored project has wrong guild or kind');
        id(channel.id);
        if (channel.name !== expectedName || channel.topic !== topic) {
          await native<void>(Reflect.apply(update, remote, [channel.id, expectedName, topic, signal]));
          channel = {...channel, name: expectedName, topic};
          const index = channels.findIndex(item => item.id === channel!.id);
          if (index >= 0) channels[index] = channel;
        }
      } else {
        channel = await custody.create(guild, category, key, expected, expectedName, topic, signal);
        channels.push(channel);
      }
      await NativeMirrorStore.prototype.execute.call(store, {kind: 'UpsertProject', args: [key, name, id(channel.id), systemNow()]}, signal);
      return Object.freeze({channel: Object.freeze(channel), channels: Object.freeze(channels)});
    };
    Object.freeze(this);
  }
}
Object.freeze(MirrorProjectChannelCoordinator.prototype);
