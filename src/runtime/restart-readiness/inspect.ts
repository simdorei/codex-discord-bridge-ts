import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {captureRestartSnapshot} from '../../store/restart-snapshot-owned.ts';
import {snapshotEquals,type RestartReadinessSnapshot} from '../../store/restart-snapshot-pure.ts';
import {StateAccessFacade} from '../../store/state-access-facade.ts';
import {joinRestartSnapshotReader} from '../../store/restart-readiness.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {readThreadWithTimeout} from '../../app-server/requests.ts';
import {classifyThreadState,type RestartReadinessState} from '../../restart/thread-state.ts';
export interface RestartInspectionPorts {
 readonly snapshot:()=>Promise<RestartReadinessSnapshot>;
 readonly readThread:(thread:string,requestTimeoutMs:number,signal?:AbortSignal)=>Promise<unknown>;
 readonly nowSeconds:()=>bigint;
}
function u64(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<0n||value>18446744073709551615n)throw new RangeError('Expected u64 readiness seconds');}
/** Normal (no approved-absence exemption) source inspection. First durable
 * blocker wins; wall time is sampled once; sorted thread/read metadata uses
 * includeTurns=false in the concrete adapter; a second durable snapshot must
 * match. Ready is an observation, never a seal or restart authorization.
 * Metadata has an explicit 64KiB TS profile; over-budget data fails closed. */
export async function inspectRestartReadiness(input:RestartInspectionPorts,quietSeconds:bigint,requestTimeoutMs:number,signal?:AbortSignal):Promise<RestartReadinessState>{
 signal?.throwIfAborted();u64(quietSeconds);readThreadWithTimeout('',false,requestTimeoutMs);
 const snapshot=own(input,'snapshot'),read=own(input,'readThread'),now=own(input,'nowSeconds');
 for(const fn of [snapshot,read,now])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected passive restart inspection callback');
 if(types.isAsyncFunction(now))throw new TypeError('Expected synchronous readiness clock');
 const call=async(fn:Function,args:unknown[])=>{signal?.throwIfAborted();const work=Reflect.apply(fn,input,args);if(!types.isPromise(work))throw new TypeError('Expected native inspection Promise');const value=await work;signal?.throwIfAborted();return value;};
 const before=captureRestartSnapshot(await call(snapshot as Function,[]));
 if(before.blockers.length)return Object.freeze({status:'Blocked',reason:before.blockers[0]!});
 const at=Reflect.apply(now as Function,input,[]);u64(at);
 for(const thread of before.targetThreadIds){
  const reply=await call(read as Function,[thread,requestTimeoutMs,signal]);
  if(boundedSerdeByteCount(reply,65536)===null)throw new RangeError('Restart thread metadata exceeds byte budget or is not passive JSON');
  const state=classifyThreadState(reply,thread,quietSeconds,at);if(state.status==='Blocked')return Object.freeze(state);
 }
 const after=captureRestartSnapshot(await call(snapshot as Function,[]));
 if(!snapshotEquals(before,after))return Object.freeze({status:'Blocked',reason:'Rust durable restart state changed during app-server inspection'});
 return Object.freeze({status:'Ready'});
}
/** Concrete read-only central store and exact borrowed native resident. Does not
 * launch, restart or close the resident, and cannot release an admission seal. */
export async function inspectRuntimeRestartReadiness(path:string,server:PortableResidentLifecycle,quietSeconds:bigint,requestTimeoutMs:number,signal?:AbortSignal):Promise<RestartReadinessState>{
 requireDiscordText(path);signal?.throwIfAborted();const generation=PortableResidentLifecycle.prototype.generation.call(server);
 const result=await inspectRestartReadiness({snapshot:async()=>{try{return await StateAccessFacade.restartReadinessSnapshot(path,signal);}finally{await joinRestartSnapshotReader();}},readThread:(thread,timeout,s)=>PortableResidentLifecycle.prototype.execute.call(server,readThreadWithTimeout(thread,false,timeout),generation,s),nowSeconds:()=>{const now=Date.now();if(!Number.isSafeInteger(now)||now<0)throw new RangeError('Restart readiness wall clock is before the Unix epoch or invalid');return BigInt(now)/1000n;}},quietSeconds,requestTimeoutMs,signal);
 if(result.status==='Blocked')return result;
 const final=PortableResidentLifecycle.prototype.lifecycleSnapshot.call(server);
 if(final.generation!==generation||!final.healthy||final.quarantined||final.restartPending||final.processId===null)return Object.freeze({status:'Blocked',reason:'App-server ownership changed or is unhealthy during restart inspection'});
 return result;
}
