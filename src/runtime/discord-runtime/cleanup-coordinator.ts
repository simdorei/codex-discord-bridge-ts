import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {getDrainFenceKeyRecord,type DrainFenceKey} from '../../admission/owned-key.ts';
import {GatewayShutdownError,GatewayShutdownReportingError,nativeGatewayShutdownClock,type GatewayShutdownClock,type GatewayShutdownReport} from '../../discord/gateway/shutdown.ts';
import type {RuntimeWorkerResult} from './monitored-worker.ts';
import {RuntimeWorkerReportingError,type RuntimeWorkerShutdownReport} from './worker-shutdown.ts';
import {resolveRuntimeShutdown,validateRuntimeDrainCleanup,type RuntimeShutdownCause,type RuntimeShutdownDecision} from './shutdown-policy.ts';
import {completeBeforeRuntimeShutdownDeadline,RUNTIME_SHUTDOWN_TIMEOUT_MS,NON_HEARTBEAT_RESERVE_MS,HEARTBEAT_JOIN_RESERVE_MS} from './shutdown-deadline.ts';
export interface RuntimeCleanupPorts {
 readonly requestRemoteHandoff:()=>Promise<void>;
 readonly beginGatewayStopping:()=>void;
 readonly closeInteractionInput:()=>void;
 readonly signalWorkers:()=>void;
 readonly joinGateway:(deadline:number,trigger:number|null)=>Promise<GatewayShutdownReport>;
 readonly joinWorkers:(deadline:number,trigger:string|null)=>Promise<RuntimeWorkerShutdownReport>;
 readonly closeServer:()=>Promise<void>;
 readonly completeDrain:(key:DrainFenceKey)=>Promise<'Restart'|'Stop'>;
 readonly signalHeartbeat:()=>void;
 readonly joinHeartbeat:(deadline:number)=>Promise<RuntimeWorkerResult>;
}
export interface RuntimeCleanupOptions {readonly clock?:GatewayShutdownClock;readonly fatal?:(component:string)=>never}
export interface RuntimeCleanupOutcome {readonly decision:RuntimeShutdownDecision;readonly orchestrationErrors:readonly unknown[]}
const okay=Object.freeze({ok:true} as const),fail=(error:unknown):RuntimeWorkerResult=>Object.freeze({ok:false,error});
const active=new WeakSet<object>();
function settled(value:unknown):RuntimeWorkerResult{const ok=own(value,'ok');if(ok===true)return okay;if(ok===false)return fail(own(value,'error'));throw new TypeError('Invalid joined cleanup result');}
function joined(value:unknown):RuntimeWorkerShutdownReport{const trigger=own(value,'trigger');return Object.freeze({trigger:trigger===null?null:settled(trigger),cleanup:settled(own(value,'cleanup'))});}
function capture(input:RuntimeCleanupPorts):RuntimeCleanupPorts {
 const out:Record<string,Function>=Object.create(null),sync=new Set(['beginGatewayStopping','closeInteractionInput','signalWorkers','signalHeartbeat']);
 for(const name of ['requestRemoteHandoff','beginGatewayStopping','closeInteractionInput','signalWorkers','joinGateway','joinWorkers','closeServer','completeDrain','signalHeartbeat','joinHeartbeat']){const fn=own(input,name);if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn)||sync.has(name)&&types.isAsyncFunction(fn))throw new TypeError('Expected owned cleanup operation');out[name]=sync.has(name)?(...args:unknown[])=>invokeSynchronousVoid(fn,input,args):(...args:unknown[])=>{const p=Reflect.apply(fn,input,args);if(!types.isPromise(p))throw new TypeError('Expected native cleanup Promise');return p;};}return out as unknown as RuntimeCleanupPorts;
}
function causeSnapshot(input:RuntimeShutdownCause):RuntimeShutdownCause {
 const kind=own(input,'kind');if(kind==='Control'){const r=own(input,'result'),ok=own(r,'ok');if(ok!==true&&ok!==false)throw new TypeError('Invalid control result');return Object.freeze({kind,result:ok?okay:fail(own(r,'error'))});}
 if(kind==='Worker'){const worker=own(input,'worker');if(typeof worker!=='string')throw new TypeError('Invalid worker identity');return Object.freeze({kind,worker});}
 if(kind==='GatewayShard'){const shard=own(input,'shard');if(typeof shard!=='number'||!Number.isInteger(shard)||shard<0||shard>0xffffffff)throw new TypeError('Invalid shard identity');return Object.freeze({kind,shard});}
 if(kind==='WorkerMonitorClosed'||kind==='GatewayMonitorClosed')return Object.freeze({kind});throw new TypeError('Invalid shutdown cause');
}
/** Source shutdown order over already-owned runtime adapters. No startup, process
 * discovery, PID killing or ownership transfer is inferred here. All adapters must
 * resolve only after their real tasks settle. Hard deadlines are fail-stop.
 * Heartbeat remains alive during drain handshake and stops even on cleanup error. */
export async function coordinateRuntimeCleanup(inputCause:RuntimeShutdownCause,key:DrainFenceKey|null,input:RuntimeCleanupPorts,options:RuntimeCleanupOptions={}):Promise<RuntimeCleanupOutcome>{
 const p=capture(input),cause=causeSnapshot(inputCause);if(key!==null&&(getDrainFenceKeyRecord(key)===null||cause.kind!=='Control'||!cause.result.ok))throw new TypeError('Drain key requires successful control outcome');
 const fatal=options.fatal;if(fatal!==undefined&&(typeof fatal!=='function'||types.isProxy(fatal)||types.isAsyncFunction(fatal)||types.isGeneratorFunction(fatal)))throw new TypeError('Expected synchronous nonreturning fatal policy');
 const clock=options.clock??nativeGatewayShutdownClock,now=clock.now();if(!Number.isFinite(now)||now<0)throw new TypeError('Invalid shutdown clock');if(active.has(input))throw new Error('Cleanup already consumed these owner ports');
 const deadline=now+RUNTIME_SHUTDOWN_TIMEOUT_MS,nonHeartbeat=deadline-NON_HEARTBEAT_RESERVE_MS,serverDeadline=deadline-HEARTBEAT_JOIN_RESERVE_MS,errors:unknown[]=[];active.add(input);
 const hard=<T>(d:number,name:string,operation:Promise<T>)=>completeBeforeRuntimeShutdownDeadline(d,name,operation,{clock,...(fatal===undefined?{}:{fatal})});
 const hook=(f:()=>void)=>{try{f();}catch(error){errors.push(error);}};
 const remote=async()=>{try{const value=await p.requestRemoteHandoff();if(value!==undefined)throw new TypeError('Expected void handoff request');}catch(error){errors.push(error);}};
 try{
  await hard(nonHeartbeat,'remote-handoff',remote());hook(p.beginGatewayStopping);hook(p.closeInteractionInput);hook(p.signalWorkers);
  const gateway=Promise.resolve().then(()=>p.joinGateway(nonHeartbeat,cause.kind==='GatewayShard'?cause.shard:null)).then(value=>joined(value) as GatewayShutdownReport).catch(error=>{if(!types.isProxy(error)&&error instanceof GatewayShutdownReportingError){try{errors.push(own(error,'reportingError'));return joined(own(error,'report')) as GatewayShutdownReport;}catch(invalid){errors.push(invalid);}}return Object.freeze({trigger:null,cleanup:{ok:false as const,error:new GatewayShutdownError('Join',error)}});});
  const workers=Promise.resolve().then(()=>p.joinWorkers(nonHeartbeat,cause.kind==='Worker'&&cause.worker!=='heartbeat'?cause.worker:null)).then(joined).catch(error=>{if(!types.isProxy(error)&&error instanceof RuntimeWorkerReportingError){try{errors.push(own(error,'reportingError'));return joined(own(error,'report'));}catch(invalid){errors.push(invalid);}}return Object.freeze({trigger:null,cleanup:fail(error)});});
  const [gatewayResult,workerResult]=await hard(nonHeartbeat,'gateway-and-workers',Promise.all([gateway,workers]));
  const serverResult=await hard(serverDeadline,'app-server',Promise.resolve().then(()=>p.closeServer()).then(value=>{if(value!==undefined)throw new TypeError('Expected void server close');return okay;}).catch(error=>fail(error)));
  let drainResult:RuntimeWorkerResult=okay;
  if(key!==null){
   try{drainResult=validateRuntimeDrainCleanup(gatewayResult,workerResult,serverResult);if(drainResult.ok&&errors.length)drainResult=fail(errors[0]);if(drainResult.ok){const transition=await p.completeDrain(key);if(transition!=='Restart'&&transition!=='Stop')throw new TypeError('Invalid drained transition');if(transition==='Restart')await hard(clock.now()+HEARTBEAT_JOIN_RESERVE_MS,'restart-handoff',remote());if(errors.length)drainResult=fail(errors[0]);}}catch(error){drainResult=fail(error);}
  }
  hook(p.signalHeartbeat);
  const heartbeatDeadline=key===null?deadline:clock.now()+HEARTBEAT_JOIN_RESERVE_MS;
  const heartbeat=await hard(heartbeatDeadline,'heartbeat',Promise.resolve().then(()=>p.joinHeartbeat(heartbeatDeadline)).then(settled).catch(error=>fail(error)));
  let decision:RuntimeShutdownDecision;
  if(key!==null){decision=drainResult.ok?Object.freeze({result:heartbeat,secondary:Object.freeze([])}):Object.freeze({result:drainResult,secondary:Object.freeze(heartbeat.ok?[]:[{component:'heartbeat' as const,error:heartbeat.error}])});}
  else decision=resolveRuntimeShutdown(cause,{gateway:gatewayResult,workers:workerResult,serverClose:serverResult,heartbeat});
  if(decision.result.ok&&errors.length)decision=Object.freeze({result:fail(errors[0]),secondary:decision.secondary});
  return Object.freeze({decision,orchestrationErrors:Object.freeze(errors)});
 }finally{/* This one-shot owner port remains consumed, including fail-stop exits. */}
}
