import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {types} from 'node:util';
import {NativeMirrorStore} from './store-native.ts';
import type {NewMirrorTransport, MirrorChannel} from './new-mirror-link.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
function id(value: bigint): bigint {
  if (typeof value !== 'bigint' || value <= 0n || value >= 1n << 63n) throw new TypeError('Expected positive database-compatible Discord id');
  return value;
}
function captured(input: MirrorChannel): MirrorChannel {
  const channel = cloneOwnedSerdeValue(input) as MirrorChannel;
  if (channel === null || typeof channel !== 'object' || Array.isArray(channel)) throw new TypeError('Expected mirror channel');
  id(channel.id); requireDiscordText(channel.name);
  if (typeof channel.archived !== 'boolean') throw new TypeError('Expected archived flag');
  return channel;
}
function validate(channel: MirrorChannel, guild: bigint, parent: bigint): void {
  if (channel.guildId !== guild || channel.kind !== 11n || channel.parentId !== parent) throw new Error('stored thread has wrong guild, kind, or parent');
}
function method<T extends Function>(remote: unknown, key: string): T {
  const fn = own(remote, key);
  if (typeof fn !== 'function' || types.isProxy(fn) || types.isGeneratorFunction(fn)) throw new TypeError('Expected owned thread transport');
  return fn as T;
}
async function native<T>(promise: Promise<T>): Promise<T> {
  if (!types.isPromise(promise)) throw new TypeError('Expected native transport promise');
  return promise;
}
/** Resolves one public thread and commits the exact mapping CAS. The caller must
 * hold the global mirror operation lock and own the operation deadline. */
export class MirrorThreadChannelCoordinator {
  readonly sync: (guild: bigint, parent: bigint, thread: string, projectKey: string, title: string, signal: AbortSignal) => Promise<bigint>;
  constructor(store: NativeMirrorStore, remote: NewMirrorTransport) {
    const read = method<NewMirrorTransport['channel']>(remote, 'channel');
    const create = method<NewMirrorTransport['createThread']>(remote, 'createThread');
    const update = method<NewMirrorTransport['updateThread']>(remote, 'updateThread');
    this.sync = async (guild, parent, thread, projectKey, title, signal) => {
      id(guild); id(parent); requireDiscordText(thread); requireDiscordText(projectKey); requireDiscordText(title); signal.throwIfAborted();
      const expected = await NativeMirrorStore.prototype.execute.call(store, {kind: 'ThreadChannels', args: [thread]}, signal) as readonly [bigint, bigint] | null;
      const scope = Object.freeze({thread, guild, parent, expected});
      const confirmed = await NativeMirrorStore.prototype.execute.call(store, {kind: 'ConfirmedThreadCreation', args: [scope]}, signal) as bigint | null;
      let channel: MirrorChannel | null = null;
      if (confirmed !== null) {
        const result = await native<MirrorChannel | null>(Reflect.apply(read, remote, [id(confirmed), signal]));
        if (result === null) throw new Error('confirmed created room is unavailable; creation will not be repeated');
        channel = captured(result);
        if (channel.id !== confirmed) throw new Error('created room response identity changed');
        validate(channel, guild, parent);
      } else if (expected !== null) {
        const result = await native<MirrorChannel | null>(Reflect.apply(read, remote, [id(expected[1]), signal]));
        if (result !== null) channel = captured(result);
      }
      signal.throwIfAborted();
      if (channel !== null) {
        validate(channel, guild, parent);
        if (channel.name !== title || channel.archived) await native<void>(Reflect.apply(update, remote, [channel, title, signal]));
      } else {
        const token = await NativeMirrorStore.prototype.execute.call(store, {kind: 'BeginThreadCreation', args: [scope]}, signal) as string;
        channel = captured(await native<MirrorChannel>(Reflect.apply(create, remote, [guild, parent, title, signal])));
        validate(channel, guild, parent);
        await NativeMirrorStore.prototype.execute.call(store, {kind: 'ConfirmThreadCreation', args: [scope, token, channel.id]}, signal);
      }
      await NativeMirrorStore.prototype.execute.call(store, {kind: 'CommitThread', args: [{threadId: thread, projectKey, title, parentId: parent, channelId: channel.id, now: systemNow()}, expected]}, signal);
      return channel.id;
    };
    Object.freeze(this);
  }
}
Object.freeze(MirrorThreadChannelCoordinator.prototype);
