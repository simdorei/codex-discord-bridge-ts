import {types} from 'node:util';
import {StateAccessFacade} from '../../store/state-access-facade.ts';
import {joinRestartSnapshotReader} from '../../store/restart-readiness.ts';
import {snapshotEquals,compareUtf8Bytes,validateTarget,type RestartReadinessSnapshot} from '../../store/restart-snapshot-pure.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
export interface DrainLifecycle {readonly generation:bigint;readonly healthy:boolean;readonly quarantined:boolean;readonly restartPending:boolean;readonly processId:number|null}
export interface LiveDrainPorts {readonly snapshot:()=>Promise<RestartReadinessSnapshot>;readonly lifecycle:()=>Promise<DrainLifecycle>;readonly unsettled:()=>Promise<boolean>;readonly activeTurn:(thread:string)=>Promise<string|null>}
export type LiveDrainState=Readonly<{kind:'Ready'}|{kind:'Blocked';reason:string}>;
function capture(input:LiveDrainPorts){const result:Record<string,Function>=Object.create(null);for(const key of ['snapshot','lifecycle','unsettled','activeTurn']){const fn=own(input,key);if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned live-drain port');result[key]=(...args:unknown[])=>{const p=Reflect.apply(fn,input,args);if(!types.isPromise(p))throw new TypeError('Expected native live-drain Promise');return p;};}return result as unknown as LiveDrainPorts;}
function snapshot(value:unknown):RestartReadinessSnapshot{
 const v=cloneOwnedSerdeValue(value);const strings=(key:string,targets=false)=>{const a=own(v,key);if(!Array.isArray(a))throw new TypeError('Expected restart snapshot array');const out=a.map(x=>{requireDiscordText(x);if(targets)validateTarget(x);return x;});for(let i=1;i<out.length;i++)if(compareUtf8Bytes(out[i-1]!,out[i]!)>(targets?-1:0))throw new TypeError('Restart snapshot is not canonical');return Object.freeze(out);};
 return Object.freeze({targetThreadIds:strings('targetThreadIds',true),blockers:strings('blockers'),observations:strings('observations')});
}
function lifecycle(value:unknown):DrainLifecycle{
 const v=cloneOwnedSerdeValue(value),generation=own(v,'generation'),healthy=own(v,'healthy'),quarantined=own(v,'quarantined'),restartPending=own(v,'restartPending'),processId=own(v,'processId');
 if(typeof generation!=='bigint'||generation<0n||generation>=(1n<<64n)||typeof healthy!=='boolean'||typeof quarantined!=='boolean'||typeof restartPending!=='boolean'||(processId!==null&&(typeof processId!=='number'||!Number.isInteger(processId)||processId<0||processId>0xffffffff)))throw new TypeError('Malformed resident lifecycle');return Object.freeze({generation,healthy,quarantined,restartPending,processId});
}
interface Observation {readonly lifecycle:DrainLifecycle;readonly unsettled:boolean;readonly active:readonly (readonly [string,string])[]}
function equal(a:Observation,b:Observation):boolean{return a.lifecycle.generation===b.lifecycle.generation&&a.lifecycle.healthy===b.lifecycle.healthy&&a.lifecycle.quarantined===b.lifecycle.quarantined&&a.lifecycle.restartPending===b.lifecycle.restartPending&&a.lifecycle.processId===b.lifecycle.processId&&a.unsettled===b.unsettled&&a.active.length===b.active.length&&a.active.every((x,i)=>x[0]===b.active[i]![0]&&x[1]===b.active[i]![1]);}
function blocker(o:Observation):string|null{const l=o.lifecycle;if(!l.healthy||l.quarantined||l.restartPending||l.processId===null)return `resident app-server is not stably healthy: generation=${l.generation},healthy=${l.healthy},quarantined=${l.quarantined},restartPending=${l.restartPending},processId=${l.processId}`;if(o.unsettled)return 'resident app-server has an unsettled approval or input request';const a=o.active[0];return a?`resident app-server thread ${a[0]} still has active turn ${a[1]}`:null;}
/** Two durable/live observations, preserving source short-circuit and query order.
 * Ready is an observation only: callers must retain the admission seal and prove
 * consumer quiescence/exclusive runtime ownership before process shutdown. */
export async function checkLiveDrain(input:LiveDrainPorts,signal?:AbortSignal):Promise<LiveDrainState>{
 const p=capture(input);const check=()=>signal?.throwIfAborted();check();
 const read=async()=>{check();const v=snapshot(await p.snapshot());check();return v;};
 const observe=async(d:RestartReadinessSnapshot):Promise<Observation>=>{check();const l=lifecycle(await p.lifecycle());check();const unsettled=await p.unsettled();check();if(typeof unsettled!=='boolean')throw new TypeError('Expected unsettled request flag');const active:[string,string][]=[];for(const thread of d.targetThreadIds){check();const turn=await p.activeTurn(thread);check();if(turn!==null){requireDiscordText(turn);active.push([thread,turn]);}}return {lifecycle:l,unsettled,active};};
 const before=await read();if(before.blockers.length)return Object.freeze({kind:'Blocked',reason:before.blockers[0]!});
 const liveBefore=await observe(before),reason=blocker(liveBefore);if(reason!==null)return Object.freeze({kind:'Blocked',reason});
 const after=await read();if(!snapshotEquals(before,after))return Object.freeze({kind:'Blocked',reason:'Rust durable restart state changed during live drain inspection'});
 if(!equal(liveBefore,await observe(after)))return Object.freeze({kind:'Blocked',reason:'resident app-server state changed during live drain inspection'});
 check();return Object.freeze({kind:'Ready'});
}
/** Actual central store reader plus owned resident; never substitutes pending-only
 * requests for claimed/indeterminate/deferred requests. Join reader after abort. */
export async function checkRuntimeQuiescence(path:string,server:PortableResidentLifecycle,signal?:AbortSignal):Promise<LiveDrainState>{
 requireDiscordText(path);return checkLiveDrain({snapshot:async()=>{try{return await StateAccessFacade.restartReadinessSnapshot(path,signal);}finally{await joinRestartSnapshotReader();}},lifecycle:async()=>PortableResidentLifecycle.prototype.lifecycleSnapshot.call(server),unsettled:async()=>PortableResidentLifecycle.prototype.hasUnsettledServerRequests.call(server),activeTurn:async thread=>PortableResidentLifecycle.prototype.activeTurnId.call(server,thread)},signal);
}
