import {requestPreparedRuntimeRemoteHandoff,assertPreparedRuntimeRemoteReleased} from './remote-start.ts';
import {AttachmentHttpClient} from '../attachment-client.ts';
import {RecommendedGateway} from '../../discord/gateway/recommended.ts';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {GatewayRuntime} from '../../discord/gateway/runtime.ts';
import {nativeGatewayShutdownClock} from '../../discord/gateway/shutdown.ts';
import {RuntimeDrainController} from '../restart-readiness/drain-controller.ts';
import {checkRuntimeQuiescence} from '../restart-readiness/live-drain.ts';
import {preparedRuntimeWorkerBinding,type PreparedRuntimeWorkerOwner} from './prepared-workers.ts';
import {runGatewayControlLoop} from './gateway-control.ts';
import {waitRuntimeShutdownCause} from './shutdown-watch.ts';
import {shutdownRuntimeOwners} from './owner-shutdown.ts';
import {finalizeRuntimeShutdown} from './finalize-shutdown.ts';
import {RUNTIME_SHUTDOWN_TIMEOUT_MS,completeBeforeRuntimeShutdownDeadline,type RuntimeHardDeadlineOptions} from './shutdown-deadline.ts';
import type {RuntimeWorkerShutdownOptions} from './worker-shutdown.ts';
export interface PreparedRuntimeLifetimeOptions{
 readonly stopRequested:()=>Promise<boolean>;
 readonly reportControl:(event:string,detail:unknown)=>void;
 readonly reportTransition:(event:string,error:unknown)=>void;
 readonly shutdown:RuntimeWorkerShutdownOptions&RuntimeHardDeadlineOptions;
}
const consumed=new WeakSet<object>();
const completed=new WeakMap<object,{gateway:GatewayRuntime<import('../../discord/gateway/decoded-interaction.ts').DecodedGatewayInteraction>;controller:RuntimeDrainController;attachment:AttachmentHttpClient|null;closing?:Promise<void>}>();
/** Runs actual stop selection, live SQLite/resident drain inspection, joined
 * gateway/workers/resident cleanup and heartbeat finalization for an authentic
 * prepared worker owner. All losing waits join under the original selected
 * deadline. A bound synthetic remote samples its owned restart marker before
 * stop; its actual resource cleanup joins before resident/outer release.
 * HTTP, drain and singleton remain caller-owned.
 * A fail-stop exception never authorizes releasing still-live native ownership. */
export async function runPreparedRuntimeLifetime(workers:PreparedRuntimeWorkerOwner,controller:RuntimeDrainController,userStop:AbortSignal,options:PreparedRuntimeLifetimeOptions){
 const binding=preparedRuntimeWorkerBinding(workers);
 if(types.isProxy(userStop)||!(userStop instanceof AbortSignal))throw new TypeError('Expected runtime user stop signal');
 const gate=Object.getOwnPropertyDescriptor(RuntimeDrainController.prototype,'admissionGate')!.get!.call(controller);if(gate!==binding.gate)throw new TypeError('Prepared runtime drain admission gate differs');
 const stop=own(options,'stopRequested'),controlReport=own(options,'reportControl'),transitionReport=own(options,'reportTransition'),raw=own(options,'shutdown'),report=own(raw,'report');
 if(raw===null||typeof raw!=='object'||types.isProxy(raw))throw new TypeError('Expected passive shutdown options');
 for(const fn of [stop,controlReport,transitionReport,report])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected runtime lifetime callback');
 for(const fn of [controlReport,transitionReport,report])if(types.isAsyncFunction(fn))throw new TypeError('Expected synchronous runtime diagnostic');
 const fatal=Object.hasOwn(raw,'fatal')?own(raw,'fatal'):undefined,sourceClock=(Object.hasOwn(raw,'clock')?own(raw,'clock'):undefined)??nativeGatewayShutdownClock;
 if(fatal!==undefined&&(typeof fatal!=='function'||types.isProxy(fatal)||types.isAsyncFunction(fatal)||types.isGeneratorFunction(fatal)))throw new TypeError('Expected nonreturning runtime fatal policy');
 const now=own(sourceClock,'now'),sleep=own(sourceClock,'sleepUntil');for(const fn of [now,sleep])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned runtime clock');if(types.isAsyncFunction(now))throw new TypeError('Expected synchronous monotonic clock');
 const clock=Object.freeze({now:()=>{const value=Reflect.apply(now as Function,sourceClock,[]);if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new TypeError('Invalid runtime clock');return value;},sleepUntil:(deadline:number,signal:AbortSignal)=>{const work=Reflect.apply(sleep as Function,sourceClock,[deadline,signal]);if(!types.isPromise(work))throw new TypeError('Runtime clock must return native Promise');return work as Promise<void>;}});
 clock.now();const policy={clock,report:(...args:Parameters<RuntimeWorkerShutdownOptions['report']>)=>invokeSynchronousVoid(report as Function,{},args),...(fatal===undefined?{}:{fatal:fatal as (component:string)=>never})};
 const ports=Object.freeze({stopRequested:()=>{const work=Reflect.apply(stop as Function,undefined,[]);if(!types.isPromise(work))throw new TypeError('Stop marker port must return native Promise');return work as Promise<boolean>;},inspect:(signal:AbortSignal)=>checkRuntimeQuiescence(binding.database,binding.resident,signal),report:(event:string,detail:unknown)=>invokeSynchronousVoid(controlReport as Function,{},[event,detail])});
 if(consumed.has(workers))throw new TypeError('Prepared runtime lifetime already consumed');consumed.add(workers);
 const selection=await waitRuntimeShutdownCause({control:signal=>runGatewayControlLoop(controller,ports,AbortSignal.any([userStop,signal])),workerExit:signal=>workers.exits.receive(signal),gatewayExit:signal=>GatewayRuntime.prototype.waitForShardExit.call(binding.gateway,signal)},userStop,policy);
 const deadline=selection.startedAt+RUNTIME_SHUTDOWN_TIMEOUT_MS;
 if(binding.remote!==null)await completeBeforeRuntimeShutdownDeadline(deadline,'remote-restart-marker',requestPreparedRuntimeRemoteHandoff(binding.remote),policy);
 const cleanup=await shutdownRuntimeOwners(binding.gateway,workers,binding.resident,selection.cause,deadline,policy);
 const finalized=await finalizeRuntimeShutdown(selection.cause,cleanup,selection.drainKey,controller,workers.heartbeat,userStop,deadline,()=>binding.remote===null?undefined:requestPreparedRuntimeRemoteHandoff(binding.remote),policy,(event,error)=>invokeSynchronousVoid(transitionReport as Function,{},[event,error]));
 if(binding.remote!==null)assertPreparedRuntimeRemoteReleased(binding.remote);
 workers.disposeMonitor();const result=Object.freeze({selection,cleanup,finalized,deadline});
 if(cleanup.serverClose.ok)completed.set(result,{gateway:binding.gateway,controller,attachment:binding.attachment});return result;
}

/** Outer cleanup is authorized only by this module's completed, joined lifetime.
 * Shared HTTP/identify and the bound native attachment client close before
 * removing drain identity. Custom attachment transports remain caller-owned. An error
 * or fail-stop before the lifetime receipt is produced grants no cleanup authority.
 * A rejected resident disposal also withholds authority even if all tasks joined.
 * Singleton ownership remains caller-held until this Promise has succeeded. */
export function closePreparedRuntimeOuter(result:unknown,gateway:RecommendedGateway,controller:RuntimeDrainController):Promise<void>{
 const proof=result!==null&&typeof result==='object'?completed.get(result):undefined;
 if(proof===undefined)throw new TypeError('Expected completed runtime lifetime receipt');
 RecommendedGateway.prototype.snapshot.call(gateway);
 if(own(gateway,'runtime')!==proof.gateway||controller!==proof.controller)throw new TypeError('Outer runtime ownership differs');
 return proof.closing??= (async()=>{
  await RecommendedGateway.prototype.close.call(gateway);
  if(proof.attachment!==null)await AttachmentHttpClient.prototype.close.call(proof.attachment);
  await RuntimeDrainController.prototype.dispose.call(controller);
 })();
}
