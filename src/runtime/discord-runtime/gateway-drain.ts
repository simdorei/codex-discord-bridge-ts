import {types} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import {AdmissionGate,AdmissionDrainTimeoutError,DrainFenceKey} from '../../admission/drain-gate.ts';
import {getDrainFenceKeyRecord} from '../../admission/owned-key.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {checkRuntimeQuiescence,type LiveDrainState} from '../restart-readiness/live-drain.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {PosixDrainMarkerStore} from '../restart-readiness/drain-marker.ts';
export interface GatewayDrainPorts {readonly stopRequested:()=>Promise<boolean>;readonly inspect:(signal:AbortSignal)=>Promise<LiveDrainState>;readonly report:(event:string,detail:unknown)=>void}
export interface GatewayDrainTiming {readonly admissionTimeoutMs:number;readonly pollMs:number;readonly errorRetryMs:number}
export type GatewayDrainOutcome=Readonly<{kind:'Shutdown'}|{kind:'Drained';key:DrainFenceKey}>;
export const GATEWAY_DRAIN_TIMING:GatewayDrainTiming=Object.freeze({admissionTimeoutMs:900000,pollMs:250,errorRetryMs:5000});
const shutdown=Object.freeze({kind:'Shutdown'} as const);
function capture(input:GatewayDrainPorts):GatewayDrainPorts{
 const out:Record<string,Function>=Object.create(null);
 for(const name of ['stopRequested','inspect','report']){const fn=own(input,name);if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn)||name==='report'&&types.isAsyncFunction(fn))throw new TypeError('Expected owned drain operation');out[name]=name==='report'?(...a:unknown[])=>invokeSynchronousVoid(fn,input,a):(...a:unknown[])=>{const p=Reflect.apply(fn,input,a);if(!types.isPromise(p))throw new TypeError('Expected native drain operation Promise');return p;};}return out as unknown as GatewayDrainPorts;
}
function timing(input:GatewayDrainTiming):GatewayDrainTiming{const read=(k:string)=>{const v=own(input,k);if(typeof v!=='number'||!Number.isSafeInteger(v)||v<=0||v>2147483647)throw new TypeError('Expected bounded positive drain timing');return v;};return Object.freeze({admissionTimeoutMs:read('admissionTimeoutMs'),pollMs:read('pollMs'),errorRetryMs:read('errorRetryMs')});}
/** Timeout is continued waiting, never shutdown or readiness. Normal ingress is
 * sealed throughout; controls are closed and checked again before Drained.
 * stopSignal is explicit user/runtime stop, not a native Ctrl-C listener.
 * In-flight inspections are cancelled AND joined before returning Shutdown. */
export async function drainUntilQuiescent(gate:AdmissionGate,key:DrainFenceKey,input:GatewayDrainPorts,stopSignal:AbortSignal,time:GatewayDrainTiming=GATEWAY_DRAIN_TIMING):Promise<GatewayDrainOutcome>{
 if(getDrainFenceKeyRecord(key)===null)throw new TypeError('Expected owned drain key');const p=capture(input),t=timing(time);let lastReason='resident app-server has not been inspected';
 const stopped=async()=>{if(stopSignal.aborted)return true;const v=await p.stopRequested();if(typeof v!=='boolean')throw new TypeError('Expected stop marker flag');return v||stopSignal.aborted;};
 const pause=async(ms:number)=>{const deadline=performance.now()+ms;for(;;){if(await stopped())return true;const remaining=deadline-performance.now();if(remaining<=0)return false;try{await sleep(Math.min(remaining,t.pollMs),undefined,{signal:stopSignal});}catch(error){if(stopSignal.aborted)return true;throw error;}}};
 const admission=async():Promise<'Drained'|'TimedOut'|'Shutdown'|{error:unknown}>=>{const deadline=performance.now()+t.admissionTimeoutMs;for(;;){if(await stopped())return 'Shutdown';const remaining=deadline-performance.now();if(remaining<=0)return 'TimedOut';try{await AdmissionGate.prototype.waitDrained.call(gate,key,Math.max(0,Math.ceil(Math.min(remaining,t.pollMs))),stopSignal);if(await stopped())return 'Shutdown';return 'Drained';}catch(error){if(stopSignal.aborted)return 'Shutdown';if(error instanceof AdmissionDrainTimeoutError)continue;return {error};}}};
 const reopen=(reason:string)=>{try{AdmissionGate.prototype.openControls.call(gate,key);p.report('restart_drain_controls_reopened',reason);}catch(error){p.report('restart_drain_reopen_controls_failed',error);}};
 const inspect=async():Promise<{kind:'Finished';state:LiveDrainState}|{kind:'Error';error:unknown}|{kind:'Shutdown'}>=>{
  if(await stopped())return shutdown;
  const cancelInspection=new AbortController(),cancelMonitor=new AbortController();
  const operation=Promise.resolve().then(()=>p.inspect(cancelInspection.signal)).then(state=>({kind:'Finished' as const,state}),error=>({kind:'Error' as const,error}));
  const stop=()=>cancelInspection.abort(stopSignal.reason);stopSignal.addEventListener('abort',stop,{once:true});if(stopSignal.aborted)stop();
  const monitor=(async()=>{try{for(;;){await sleep(t.pollMs,undefined,{signal:cancelMonitor.signal});if(await stopped()){cancelInspection.abort(new Error('Runtime stop requested'));return shutdown;}}}catch(error){if(cancelMonitor.signal.aborted)return {kind:'MonitorClosed' as const};cancelInspection.abort(error);return {kind:'MonitorError' as const,error};}})();
  try{
   const result=await Promise.race([operation,monitor]);cancelMonitor.abort();await monitor;
   if(result.kind==='Shutdown'||stopSignal.aborted){cancelInspection.abort(new Error('Runtime stop requested'));await operation;return shutdown;}
   if(result.kind==='MonitorError'){await operation;throw result.error;}
   if(result.kind==='MonitorClosed')throw new Error('Drain monitor closed unexpectedly');
   if(result.kind==='Finished'){const kind=own(result.state,'kind');if(kind!=='Ready'&&kind!=='Blocked')throw new TypeError('Malformed live inspection result');if(kind==='Blocked'&&typeof own(result.state,'reason')!=='string')throw new TypeError('Malformed live inspection reason');}
   return result;
  }finally{cancelMonitor.abort();await monitor;stopSignal.removeEventListener('abort',stop);}
 };
 for(;;){
  const a=await admission();if(a==='Shutdown')return shutdown;if(a==='TimedOut'){p.report('restart_drain_still_waiting',lastReason);continue;}if(typeof a==='object'){p.report('restart_drain_admission_check_failed',a.error);if(await pause(t.errorRetryMs))return shutdown;continue;}
  const first=await inspect();if(first.kind==='Shutdown')return shutdown;if(first.kind==='Error'){p.report('restart_drain_live_check_failed',first.error);if(await pause(t.errorRetryMs))return shutdown;continue;}
  if(first.state.kind==='Blocked')lastReason=first.state.reason;
  else{
   try{AdmissionGate.prototype.closeControls.call(gate,key);}catch(error){p.report('restart_drain_close_controls_failed',error);if(await pause(t.errorRetryMs))return shutdown;continue;}
   const finalAdmission=await admission();if(finalAdmission==='Shutdown')return shutdown;if(finalAdmission==='TimedOut'){reopen('final admission timeout');continue;}if(typeof finalAdmission==='object'){p.report('restart_drain_final_admission_check_failed',finalAdmission.error);reopen('final admission check failure');if(await pause(t.errorRetryMs))return shutdown;continue;}
   const final=await inspect();if(final.kind==='Shutdown')return shutdown;if(final.kind==='Error'){p.report('restart_drain_final_live_check_failed',final.error);reopen('final live check failure');if(await pause(t.errorRetryMs))return shutdown;continue;}
   if(final.state.kind==='Ready'){if(await stopped())return shutdown;if(!AdmissionGate.prototype.isDrainedFor.call(gate,key))throw new Error('Drain fence changed after final inspection');return Object.freeze({kind:'Drained',key});}
   lastReason=final.state.reason;reopen(lastReason);
  }
  if(await pause(t.pollMs))return shutdown;
 }
}
export function runtimeGatewayDrainPorts(path:string,server:PortableResidentLifecycle,markers:PosixDrainMarkerStore,report:GatewayDrainPorts['report']):GatewayDrainPorts{return Object.freeze({stopRequested:()=>PosixDrainMarkerStore.prototype.stopRequested.call(markers),inspect:(signal:AbortSignal)=>checkRuntimeQuiescence(path,server,signal),report});}
