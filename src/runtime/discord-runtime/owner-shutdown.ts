import {assertRuntimeRemoteWorkerReleased} from './remote-start.ts';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {GatewayRuntime} from '../../discord/gateway/runtime.ts';
import {GatewayShutdownReportingError,type GatewayShutdownReport} from '../../discord/gateway/shutdown.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {RuntimeMonitoredWorker,isRuntimeMonitoredWorker,type RuntimeWorkerResult} from './monitored-worker.ts';
import {joinRuntimeWorkersForCause,RuntimeWorkerReportingError,type RuntimeWorkerShutdownOptions,type RuntimeWorkerShutdownReport} from './worker-shutdown.ts';
import {completeBeforeRuntimeShutdownDeadline,NON_HEARTBEAT_RESERVE_MS,HEARTBEAT_JOIN_RESERVE_MS,type RuntimeHardDeadlineOptions} from './shutdown-deadline.ts';
import type {RuntimeShutdownCause} from './shutdown-policy.ts';
export interface RuntimeOwnedCore{readonly workers:readonly RuntimeMonitoredWorker[];readonly requestStop:()=>void;}
export interface RuntimeOwnerShutdownReport{readonly gateway:GatewayShutdownReport;readonly workers:RuntimeWorkerShutdownReport;readonly serverClose:RuntimeWorkerResult;readonly diagnosticFailures:readonly unknown[];}
export class RuntimeOwnerShutdownIncompleteError extends AggregateError{
 constructor(errors:readonly unknown[]){super(errors,'Runtime owner shutdown could not prove joined gateway and workers; resident ownership retained');this.name='RuntimeOwnerShutdownIncompleteError';}
}
const busy=new WeakSet<object>();
/** Non-heartbeat source shutdown order: close gateway ingress, signal core stop,
 * join gateway and exact tasks concurrently against the shared reserved deadline,
 * then close native resident before the heartbeat reserve. Shared HTTP, heartbeat,
 * drain handshake and singleton release remain caller-owned later phases.
 * Unexpected join/fatal errors retain resident ownership rather than assuming stop.
 * Use the same monotonic clock as gateway; default deadline policies are fail-stop. */
export async function shutdownRuntimeOwners<I extends object>(gateway:GatewayRuntime<I>,core:RuntimeOwnedCore,owner:PortableResidentLifecycle,cause:RuntimeShutdownCause,deadline:number,options:RuntimeWorkerShutdownOptions&RuntimeHardDeadlineOptions):Promise<RuntimeOwnerShutdownReport>{
 if(!Number.isFinite(deadline)||deadline<0)throw new TypeError('Expected absolute runtime deadline');
 GatewayRuntime.prototype.publicationSnapshot.call(gateway);PortableResidentLifecycle.prototype.lifecycleSnapshot.call(owner);
 const raw=own(core,'workers'),stop=own(core,'requestStop');if(!Array.isArray(raw)||types.isProxy(raw))throw new TypeError('Expected exact core worker array');if(typeof stop!=='function'||types.isProxy(stop)||types.isAsyncFunction(stop)||types.isGeneratorFunction(stop))throw new TypeError('Expected synchronous core stop');
 const workers:RuntimeMonitoredWorker[]=[],seen=new Set<object>();for(let i=0;i<raw.length;i++){const worker=own(raw,String(i));if(!isRuntimeMonitoredWorker(worker)||seen.has(worker)||worker.name==='heartbeat')throw new TypeError('Expected unique non-heartbeat task owners');seen.add(worker);workers.push(worker);}
 const kind=own(cause,'kind');if(!['Control','Worker','WorkerMonitorClosed','GatewayShard','GatewayMonitorClosed'].includes(kind as string))throw new TypeError('Expected runtime shutdown cause');
 const workerTrigger=kind==='Worker'?own(cause,'worker'):null,shardTrigger=kind==='GatewayShard'?own(cause,'shard'):null;
 if(workerTrigger!==null&&typeof workerTrigger!=='string'||shardTrigger!==null&&(typeof shardTrigger!=='number'||!Number.isInteger(shardTrigger)||shardTrigger<0||shardTrigger>4294967295))throw new TypeError('Invalid shutdown trigger');
 const report=own(options,'report');if(typeof report!=='function'||types.isProxy(report)||types.isAsyncFunction(report)||types.isGeneratorFunction(report))throw new TypeError('Expected synchronous shutdown diagnostic');
 const optional=(key:string)=>Object.hasOwn(options,key)?own(options,key):undefined,fatal=optional('fatal'),clock=optional('clock');
 if(fatal!==undefined&&(typeof fatal!=='function'||types.isProxy(fatal)||types.isAsyncFunction(fatal)||types.isGeneratorFunction(fatal)))throw new TypeError('Expected nonreturning fatal policy');
 let pinnedClock:RuntimeWorkerShutdownOptions['clock'];if(clock!==undefined){const now=own(clock,'now'),sleep=own(clock,'sleepUntil');for(const fn of [now,sleep])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected shutdown clock methods');if(types.isAsyncFunction(now))throw new TypeError('Expected synchronous shutdown clock');pinnedClock={now:()=>Reflect.apply(now as Function,clock,[]),sleepUntil:(d,s)=>Reflect.apply(sleep as Function,clock,[d,s])};}
 const pinned:RuntimeWorkerShutdownOptions&RuntimeHardDeadlineOptions={report:(...args)=>invokeSynchronousVoid(report as Function,options,args),...(fatal===undefined?{}:{fatal:fatal as (name:string)=>never}),...(pinnedClock===undefined?{}:{clock:pinnedClock})};
 if(busy.has(gateway)||busy.has(owner))throw new TypeError('Runtime owner shutdown already active');busy.add(gateway);busy.add(owner);
 try{
  const ownershipChecks=[...workers];
  GatewayRuntime.prototype.beginStopping.call(gateway);invokeSynchronousVoid(stop,core,[]);
  const drainDeadline=Math.max(0,deadline-NON_HEARTBEAT_RESERVE_MS),nativeDeadline=Math.max(0,deadline-HEARTBEAT_JOIN_RESERVE_MS);
  const [g,w]=await Promise.allSettled([GatewayRuntime.prototype.shutdownForCause.call(gateway,drainDeadline,shardTrigger as number|null),joinRuntimeWorkersForCause(workers,drainDeadline,workerTrigger==='heartbeat'?null:workerTrigger as string|null,pinned)]);
  const diagnosticFailures:unknown[]=[],unknown:unknown[]=[];let gatewayResult:GatewayShutdownReport|undefined,workerResult:RuntimeWorkerShutdownReport|undefined;
  if(g.status==='fulfilled')gatewayResult=g.value;else if(g.reason instanceof GatewayShutdownReportingError){gatewayResult=g.reason.report;diagnosticFailures.push(g.reason.reportingError);}else unknown.push(g.reason);
  if(w.status==='fulfilled')workerResult=w.value;else if(w.reason instanceof RuntimeWorkerReportingError){workerResult=w.reason.report;diagnosticFailures.push(w.reason.reportingError);}else unknown.push(w.reason);
  if(unknown.length||gatewayResult===undefined||workerResult===undefined)throw new RuntimeOwnerShutdownIncompleteError(unknown);
  for(const worker of ownershipChecks)assertRuntimeRemoteWorkerReleased(worker);
  let serverClose:RuntimeWorkerResult;
  // Deadline observer must not be caught as an ordinary closed result. Only the
  // actual native dispose rejection is converted to the source close error.
  const closing=PortableResidentLifecycle.prototype.dispose.call(owner).then(()=>({ok:true} as const),error=>({ok:false,error} as const));
  serverClose=await completeBeforeRuntimeShutdownDeadline(nativeDeadline,'app-server',closing,pinned);
  return Object.freeze({gateway:gatewayResult,workers:workerResult,serverClose,diagnosticFailures:Object.freeze(diagnosticFailures)});
 }finally{busy.delete(gateway);busy.delete(owner);}
}
