import {FileDrainMarkerStore, type DrainMarkerStore} from '../restart-readiness/drain-marker.ts';
import {WindowsRuntimeInstance} from './windows-runtime-instance.ts';

export class WindowsDrainMarkerStore extends FileDrainMarkerStore {
  readonly #instance: WindowsRuntimeInstance;
  constructor(root: string, instance: WindowsRuntimeInstance) {
    WindowsRuntimeInstance.prototype.requireHeldRoot.call(instance, root);
    super(root); this.#instance = instance;
  }
  protected async writeMarker(kind: 'identity' | 'ack', _path: string, text: string): Promise<void> {
    await WindowsRuntimeInstance.prototype.publishMarker.call(this.#instance, kind, text);
  }
}

export function windowsDrainMarkerPort(store: WindowsDrainMarkerStore): DrainMarkerStore {
  const result: Record<string, unknown> = Object.create(null);
  const methods = ['prepareExists', 'ackExists', 'readIdentity', 'readPrepare', 'readAck', 'readRestart',
    'publishIdentity', 'publishAck', 'removeIdentityIfOwned', 'removeAckIfOwned', 'stopRequested'] as const;
  for (const name of methods) {
    const fn = WindowsDrainMarkerStore.prototype[name];
    Object.defineProperty(result, name, {value: (...args: unknown[]) => Reflect.apply(fn, store, args), enumerable: true});
  }
  return Object.freeze(result) as unknown as DrainMarkerStore;
}
