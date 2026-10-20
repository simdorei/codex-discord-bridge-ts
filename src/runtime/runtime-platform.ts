import {join} from 'node:path';
import {PosixRuntimeInstance} from './runtime-instance.ts';
import {WindowsRuntimeInstance} from './windows/windows-runtime-instance.ts';
import {WindowsDrainMarkerStore, windowsDrainMarkerPort} from './windows/windows-drain-marker.ts';
import {PosixDrainMarkerStore, type DrainMarkerStore} from './restart-readiness/drain-marker.ts';
import {posixDrainMarkerPort} from './restart-readiness/drain-controller.ts';
import {posixRuntimeHeartbeatPort, RUNTIME_HEARTBEAT_NAME, type RuntimeHeartbeatPort} from './runtime-heartbeat.ts';

export type RuntimeInstance = PosixRuntimeInstance | WindowsRuntimeInstance;
export interface RuntimePlatform {
  readonly instance: RuntimeInstance;
  readonly markers: DrainMarkerStore;
  readonly heartbeat: RuntimeHeartbeatPort;
}

export async function acquireRuntimePlatform(root: string): Promise<RuntimePlatform> {
  const instance = process.platform === 'win32'
    ? await WindowsRuntimeInstance.acquire(root) : await PosixRuntimeInstance.acquire(root);
  try {
    if (instance instanceof WindowsRuntimeInstance) return Object.freeze({instance,
      markers: windowsDrainMarkerPort(new WindowsDrainMarkerStore(root, instance)), heartbeat: instance.heartbeatPort()});
    return Object.freeze({instance, markers: posixDrainMarkerPort(new PosixDrainMarkerStore(root)),
      heartbeat: posixRuntimeHeartbeatPort(join(root, RUNTIME_HEARTBEAT_NAME))});
  } catch (primary) {
    try { await instance.release(); }
    catch (cleanup) { throw new AggregateError([primary, cleanup], 'Runtime platform acquisition ownership retained'); }
    throw primary;
  }
}
