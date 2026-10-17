import {types} from 'node:util';
import {PortableResidentLifecycle} from '../app-server/portable-resident-lifecycle.ts';
import {ResidentStateError} from '../app-server/resident-state.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
export interface QueueRecoveryServer {
 readonly recoverySnapshot:()=>Promise<Readonly<{generation:bigint;quarantined:boolean}>>;
 readonly forceRecoveryRestart:()=>Promise<boolean>;
}
/** One observation and at most one forced quiescent restart. A false restart is
 * a held generation, never permission to publish recovered queue intake. */
export async function stabilizeAfterQueueRecovery(server:QueueRecoveryServer):Promise<boolean>{
 const snapshot=own(server,'recoverySnapshot'),restart=own(server,'forceRecoveryRestart');
 for(const fn of [snapshot,restart])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned recovery operation');
 const call=async(fn:Function)=>{const p=Reflect.apply(fn,server,[]);if(!types.isPromise(p))throw new TypeError('Expected native recovery Promise');return await p;};
 const value=await call(snapshot as Function),generation=own(value,'generation'),quarantined=own(value,'quarantined');
 if(typeof generation!=='bigint'||generation<0n||generation>=(1n<<64n)||typeof quarantined!=='boolean')throw new TypeError('Invalid recovery snapshot');
 if(!quarantined)return false;
 const restarted=await call(restart as Function);
 if(typeof restarted!=='boolean')throw new TypeError('Invalid recovery restart result');
 if(restarted)return true;
 throw new ResidentStateError({kind:'GenerationQuarantined',generation});
}
/** Binding uses actual native-owner methods, not caller-supplied proof fields. */
export function runtimeQueueRecoveryServer(server:PortableResidentLifecycle,signal?:AbortSignal):QueueRecoveryServer{
 PortableResidentLifecycle.prototype.lifecycleSnapshot.call(server);
 return Object.freeze({
  recoverySnapshot:async()=>{signal?.throwIfAborted();return PortableResidentLifecycle.prototype.lifecycleSnapshot.call(server);},
  forceRecoveryRestart:()=>PortableResidentLifecycle.prototype.forceRestartIfQuiescent.call(server,signal),
 });
}
