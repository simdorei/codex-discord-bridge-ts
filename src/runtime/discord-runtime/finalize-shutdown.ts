import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {getDrainFenceKeyRecord,type DrainFenceKey} from '../../admission/owned-key.ts';
import {RuntimeDrainController,type DrainedTransition} from '../restart-readiness/drain-controller.ts';
import {RuntimeMonitoredWorker,isRuntimeMonitoredWorker,type RuntimeWorkerResult} from './monitored-worker.ts';
import {joinRuntimeWorkersForCause,RuntimeWorkerReportingError,type RuntimeWorkerShutdownOptions} from './worker-shutdown.ts';
import {resolveRuntimeShutdown,validateRuntimeDrainCleanup,type RuntimeShutdownCause,type RuntimeShutdownDecision} from './shutdown-policy.ts';
import type {RuntimeOwnerShutdownReport} from './owner-shutdown.ts';
import {HEARTBEAT_JOIN_RESERVE_MS} from './shutdown-deadline.ts';
import {nativeGatewayShutdownClock} from '../../discord/gateway/shutdown.ts';
const used=new WeakSet<RuntimeMonitoredWorker>();
export interface RuntimeHeartbeatOwner{readonly worker:RuntimeMonitoredWorker;readonly requestStop:()=>void;}
/** Final source phase after actual gateway/core/native cleanup. These are internal
 * settled reports, not untrusted external proof. Heartbeat stays alive throughout
 * the matching drain ACK/restart-marker handshake, then uses a fresh 1s reserve.
 * Ordinary shutdown uses its original absolute deadline. This does not release
 * the singleton guard, close HTTP, or claim platform/runtime qualification. */
export async function finalizeRuntimeShutdown(cause:RuntimeShutdownCause,cleanup:RuntimeOwnerShutdownReport,drainKey:DrainFenceKey|null,controller:RuntimeDrainController,heartbeat:RuntimeHeartbeatOwner,transitionStop:AbortSignal,deadline:number,requestRestartHandoff:()=>void,options:RuntimeWorkerShutdownOptions,reportTransition:(event:string,error:unknown)=>void){
 if(!Number.isFinite(deadline)||deadline<0||types.isProxy(transitionStop)||!(transitionStop instanceof AbortSignal))throw new TypeError('Invalid final shutdown scope');
 Object.getOwnPropertyDescriptor(RuntimeDrainController.prototype,'admissionGate')!.get!.call(controller);
 const worker=own(heartbeat,'worker'),stop=own(heartbeat,'requestStop');if(!isRuntimeMonitoredWorker(worker)||worker.name!=='heartbeat')throw new TypeError('Expected exact heartbeat task');
 for(const fn of [stop,requestRestartHandoff,reportTransition])if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected synchronous final shutdown callback');
 if(drainKey!==null&&(getDrainFenceKeyRecord(drainKey)===null||own(cause,'kind')!=='Control'||own(own(cause,'result'),'ok')!==true))throw new TypeError('Drain key requires winning successful control');
 const gateway=own(cleanup,'gateway') as RuntimeOwnerShutdownReport['gateway'],workers=own(cleanup,'workers') as RuntimeOwnerShutdownReport['workers'],serverClose=own(cleanup,'serverClose') as RuntimeWorkerResult;
 const validatedCleanup=validateRuntimeDrainCleanup(gateway,workers,serverClose),rawDiagnostics=own(cleanup,'diagnosticFailures');if(!Array.isArray(rawDiagnostics)||types.isProxy(rawDiagnostics)||rawDiagnostics.length>1024)throw new TypeError('Invalid cleanup diagnostic list');const diagnosticFailures:unknown[]=[];for(let i=0;i<rawDiagnostics.length;i++)diagnosticFailures.push(own(rawDiagnostics,String(i)));
 const report=own(options,'report'),fatal=Object.hasOwn(options,'fatal')?own(options,'fatal'):undefined,rawClock=Object.hasOwn(options,'clock')?own(options,'clock'):undefined;
 for(const fn of [report,...(fatal===undefined?[]:[fatal])])if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Invalid final shutdown policy');
 const sourceClock=rawClock??nativeGatewayShutdownClock,now=own(sourceClock,'now'),sleep=own(sourceClock,'sleepUntil');for(const fn of [now,sleep])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Invalid final clock');if(types.isAsyncFunction(now))throw new TypeError('Expected synchronous final clock');
 const clock={now:()=>{const value=Reflect.apply(now as Function,sourceClock,[]);if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new TypeError('Invalid final clock time');return value;},sleepUntil:(d:number,s:AbortSignal)=>Reflect.apply(sleep as Function,sourceClock,[d,s])};clock.now();
 const pinned:RuntimeWorkerShutdownOptions={clock,report:(...args)=>invokeSynchronousVoid(report as Function,options,args),...(fatal===undefined?{}:{fatal:fatal as (name:string)=>never})};
 if(used.has(worker))throw new TypeError('Heartbeat finalization already consumed');used.add(worker);
 let transition:DrainedTransition|null=null,drained:RuntimeWorkerResult={ok:true};
 if(drainKey!==null){
  drained=validatedCleanup;
  if(drained.ok)try{transition=await RuntimeDrainController.prototype.waitForTransition.call(controller,drainKey,true,transitionStop,reportTransition);if(transition==='Restart')invokeSynchronousVoid(requestRestartHandoff,{},[]);}catch(error){drained={ok:false,error};}
 }
 invokeSynchronousVoid(stop as Function,heartbeat,[]);
 const end=drainKey===null?deadline:clock.now()+HEARTBEAT_JOIN_RESERVE_MS;
 let heartbeatResult:RuntimeWorkerResult;
 // Node heartbeat cleanup awaits real asynchronous marker IO. In the fresh 1s
 // drained branch, subtracting the worker-set's 1s abort reserve leaves zero
 // grace and falsely marks normal removal as a timeout. Join this exact worker
 // over that existing 1s total budget; expiration still invokes fail-stop and
 // never means termination. Ordinary shutdown keeps the source worker-set path.
 try{const joined=await joinRuntimeWorkersForCause([worker],end,drainKey===null?null:'heartbeat',pinned);heartbeatResult=joined.trigger??joined.cleanup;}catch(error){if(error instanceof RuntimeWorkerReportingError){heartbeatResult=error.report.trigger??error.report.cleanup;diagnosticFailures.push(error.reportingError);}else throw error;}
 let decision:RuntimeShutdownDecision;
 if(drainKey===null)decision=resolveRuntimeShutdown(cause,{gateway,workers,serverClose,heartbeat:heartbeatResult});
 else decision=Object.freeze({result:drained.ok?heartbeatResult:drained,secondary:Object.freeze(!drained.ok&&!heartbeatResult.ok?[Object.freeze({component:'heartbeat' as const,error:heartbeatResult.error})]:[])});
 return Object.freeze({decision,transition,heartbeat:heartbeatResult,diagnosticFailures:Object.freeze(diagnosticFailures)});
}
