import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import type {RuntimeWorkerResult} from './monitored-worker.ts';
import type {RuntimeWorkerShutdownReport} from './worker-shutdown.ts';
import type {GatewayShutdownReport} from '../../discord/gateway/shutdown.ts';
export type RuntimeShutdownCause={readonly kind:'Control';readonly result:RuntimeWorkerResult}|{readonly kind:'Worker';readonly worker:string}|{readonly kind:'WorkerMonitorClosed'}|{readonly kind:'GatewayShard';readonly shard:number}|{readonly kind:'GatewayMonitorClosed'};
export interface RuntimeCleanupResults{readonly gateway:GatewayShutdownReport;readonly workers:RuntimeWorkerShutdownReport;readonly heartbeat:RuntimeWorkerResult;readonly serverClose:RuntimeWorkerResult}
export interface RuntimeShutdownDecision{readonly result:RuntimeWorkerResult;readonly secondary:readonly {readonly component:'workers'|'gateway'|'heartbeat'|'app-server';readonly error:unknown}[]}
export class RuntimeEarlyExitError extends Error{
 readonly kind:'Worker'|'WorkerMonitorClosed'|'GatewayShard'|'GatewayMonitorClosed';readonly identity:string|number|null;
 constructor(kind:RuntimeEarlyExitError['kind'],identity:string|number|null){super(kind==='Worker'?`runtime worker ${identity} exited before shutdown`:kind==='WorkerMonitorClosed'?'runtime worker exit monitor closed before shutdown':kind==='GatewayShard'?`Discord gateway shard ${identity} exited before shutdown`:'Discord gateway shard exit monitor closed before shutdown');this.name='RuntimeEarlyExitError';this.kind=kind;this.identity=identity;Object.freeze(this);}
}
const success=Object.freeze({ok:true} as const);
const failure=(error:unknown):RuntimeWorkerResult=>Object.freeze({ok:false,error});
function result(value:unknown):RuntimeWorkerResult{const ok=own(value,'ok');if(ok===true)return success;if(ok===false)return failure(own(value,'error'));throw new TypeError('Expected settled cleanup result');}
function report(value:unknown):{trigger:RuntimeWorkerResult|null;cleanup:RuntimeWorkerResult}{const trigger=own(value,'trigger');return {trigger:trigger===null?null:result(trigger),cleanup:result(own(value,'cleanup'))};}
/** Pure central precedence over ALREADY joined operations. Never treats timeout
 * as termination, starts cleanup or grants a restart. Exact raw errors survive;
 * diagnostic rendering happens after this decision and cannot replace primary. */
export function resolveRuntimeShutdown(cause:RuntimeShutdownCause,input:RuntimeCleanupResults):RuntimeShutdownDecision{
 const workers=report(own(input,'workers')),gateway=report(own(input,'gateway')),heartbeat=result(own(input,'heartbeat')),server=result(own(input,'serverClose')),kind=own(cause,'kind');
 let primary:RuntimeWorkerResult,skipHeartbeat=false;
 if(kind==='Control'){primary=result(own(cause,'result'));if(primary.ok){const first=[workers.cleanup,gateway.cleanup,heartbeat,server].find(r=>!r.ok)??success;return Object.freeze({result:first,secondary:Object.freeze([])});}}
 else if(kind==='Worker'){const worker=own(cause,'worker');if(typeof worker!=='string')throw new TypeError('Expected worker identity');skipHeartbeat=worker==='heartbeat';const trigger=skipHeartbeat?heartbeat:workers.trigger;primary=trigger!==null&&!trigger.ok?trigger:failure(new RuntimeEarlyExitError('Worker',worker));}
 else if(kind==='GatewayShard'){const shard=own(cause,'shard');if(typeof shard!=='number'||!Number.isInteger(shard)||shard<0||shard>4294967295)throw new TypeError('Expected u32 shard');primary=gateway.trigger!==null&&!gateway.trigger.ok?gateway.trigger:failure(new RuntimeEarlyExitError('GatewayShard',shard));}
 else if(kind==='WorkerMonitorClosed'||kind==='GatewayMonitorClosed')primary=failure(new RuntimeEarlyExitError(kind,null));
 else throw new TypeError('Expected runtime shutdown cause');
 const secondary:RuntimeShutdownDecision['secondary'][number][]=[];
 for(const [component,item] of [['workers',workers.cleanup],['gateway',gateway.cleanup],['heartbeat',skipHeartbeat?success:heartbeat],['app-server',server]] as const)if(!item.ok)secondary.push(Object.freeze({component,error:item.error}));
 return Object.freeze({result:primary,secondary:Object.freeze(secondary)});
}
/** Drain handshake may proceed only after these three cleanup results succeed.
 * Trigger errors are intentionally not cleanup evidence, matching source order. */
export function validateRuntimeDrainCleanup(gateway:GatewayShutdownReport,workers:RuntimeWorkerShutdownReport,serverClose:RuntimeWorkerResult):RuntimeWorkerResult{
 const values=[report(workers).cleanup,report(gateway).cleanup,result(serverClose)];return values.find(r=>!r.ok)??success;
}
