import {types} from 'node:util';
import {NativeMirrorStore} from './store-native.ts';
import {captureMirrorStoreRequest} from './store-native-protocol.ts';
import type {DiscordMirrorContainerTransport} from './container-http.ts';
import type {MirrorInventoryChannel} from '../../discord/mirror-inventory-request.ts';
import type {MirrorProjectSnapshot} from '../../store/mirror-project-creation.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {ownContainerReceipt, confirmedContainerChannel, type MirrorContainerReceipt} from '../../store/mirror-container-creation.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';

function id(value: bigint): bigint {
  if (typeof value !== 'bigint' || value <= 0n || value >= 1n << 63n) throw new TypeError('Expected positive database-compatible Discord id');
  return value;
}
function project(input: MirrorInventoryChannel, guild: bigint, parent: bigint): MirrorInventoryChannel {
  const channel = cloneOwnedSerdeValue(input) as MirrorInventoryChannel;
  if (channel === null || typeof channel !== 'object' || Array.isArray(channel) || channel.guildId !== guild || channel.kind !== 0n || channel.parentId !== parent) {
    throw new Error('stored project has wrong guild, kind, or parent');
  }
  id(channel.id);
  return channel;
}
function method<T extends Function>(remote: unknown, key: string): T {
  const fn = own(remote, key);
  if (typeof fn !== 'function' || types.isProxy(fn) || types.isGeneratorFunction(fn)) throw new TypeError('Expected owned container transport');
  return fn as T;
}
async function native<T>(promise: Promise<T>): Promise<T> {
  if (!types.isPromise(promise)) throw new TypeError('Expected native transport promise');
  return promise;
}

/** Project creation custody leaf. The coordinator owns the shared operation lock,
 * deadline, mapping snapshot and eventual atomic UpsertProject. Confirmation is
 * retained until that mapping commit, including across a failed or lost response. */
export class MirrorProjectCustody {
  readonly confirmed: (guild: bigint, parent: bigint, key: string, expected: MirrorProjectSnapshot, signal: AbortSignal) => Promise<MirrorInventoryChannel | null>;
  readonly create: (guild: bigint, parent: bigint, key: string, expected: MirrorProjectSnapshot, name: string, topic: string, signal: AbortSignal) => Promise<MirrorInventoryChannel>;

  constructor(store: NativeMirrorStore, remote: DiscordMirrorContainerTransport) {
    const read = method<DiscordMirrorContainerTransport['channel']>(remote, 'channel');
    const create = method<DiscordMirrorContainerTransport['create']>(remote, 'create');
    this.confirmed = async (guild, parent, key, expected, signal) => {
      id(guild); id(parent); signal.throwIfAborted();
      const request = captureMirrorStoreRequest({kind: 'ProjectReceipt', args: [key, guild, parent, expected]});
      const saved = await NativeMirrorStore.prototype.execute.call(store, request, signal);
      if (saved === null) return null;
      const receipt = ownContainerReceipt(saved as MirrorContainerReceipt);
      const expectedId = id(confirmedContainerChannel(receipt));
      const found = await native<MirrorInventoryChannel | null>(Reflect.apply(read, remote, [expectedId, signal]));
      signal.throwIfAborted();
      if (found === null) throw new Error('confirmed project room is missing; creation not repeated');
      const channel = project(found, guild, parent);
      if (channel.id !== expectedId) throw new Error('project response identity changed');
      return channel;
    };
    this.create = async (guild, parent, key, expected, name, topic, signal) => {
      id(guild); id(parent); requireDiscordText(name); requireDiscordText(topic); signal.throwIfAborted();
      const request = captureMirrorStoreRequest({kind: 'BeginProject', args: [key, guild, parent, expected]});
      const receipt = ownContainerReceipt(await NativeMirrorStore.prototype.execute.call(store, request, signal) as MirrorContainerReceipt);
      const channel = project(await native<MirrorInventoryChannel>(Reflect.apply(create, remote, [guild, parent, 0n, name, topic, signal])), guild, parent);
      await NativeMirrorStore.prototype.execute.call(store, {kind: 'ConfirmContainer', args: [receipt, id(channel.id)]}, signal);
      return channel;
    };
    Object.freeze(this);
  }
}
Object.freeze(MirrorProjectCustody.prototype);
