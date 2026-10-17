import {TargetLocks,requireThreadTargetKey,MIRROR_SYNC_OPERATION_LOCK,type TargetLease} from '../../core/keyed-locks.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {QueueStartCoordinator} from '../queue-runner/start-coordinator.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';

/** Capture the real queue's original registry, separate from passive poll config.
 * Private-field checks reject lookalikes and replaced public registry fields.
 * Path equality binds the queue's store spelling; it is not filesystem identity. */
export function captureMirrorMappingLocks(queue:QueueStartCoordinator,databasePath:string):TargetLocks{
 const locks=own(queue,'locks') as TargetLocks;
 QueueStartCoordinator.prototype.requireTargetLocks.call(queue,locks);
 Object.getOwnPropertyDescriptor(TargetLocks.prototype,'activeTargetCount')!.get!.call(locks);
 const database=Object.getOwnPropertyDescriptor(QueueStartCoordinator.prototype,'dbPath')!.get!.call(queue) as string;
 if(pinNativeRuntimePath(database)!==databasePath)throw new TypeError('Mirror database differs from runtime queue binding');
 return locks;
}
/** Always target BEFORE global mapping ownership. Fork finalization acquires only
 * ordered target pairs; new/sync/inspection hold only the global key and never
 * request a target while holding it. Do not replace this order with runPair.
 * The global key conservatively serializes mirror targets, including HTTP/native
 * cleanup. Cancellation stops waiting but never releases still-running work.
 * The global operation key is reserved and rejected as a thread identity. */
export async function withMirrorMappingLocks<T>(locks:TargetLocks,thread:string,signal:AbortSignal,work:()=>Promise<T>):Promise<T>{
 requireThreadTargetKey(thread);
 const target=await TargetLocks.prototype.acquire.call(locks,thread,signal);let mapping:TargetLease|undefined;
 try{
  signal.throwIfAborted();
  mapping=await TargetLocks.prototype.acquire.call(locks,MIRROR_SYNC_OPERATION_LOCK,signal);
  signal.throwIfAborted();return await work();
 }finally{mapping?.release();target.release();}
}
