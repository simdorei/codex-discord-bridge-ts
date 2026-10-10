import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {getDrainFenceKeyRecord,type DrainFenceKey} from '../../admission/owned-key.ts';
import {nativeGatewayShutdownClock} from '../../discord/gateway/shutdown.ts';
import {completeBeforeRuntimeShutdownDeadline,RUNTIME_SHUTDOWN_TIMEOUT_MS,type RuntimeHardDeadlineOptions} from './shutdown-deadline.ts';
import type {GatewayDrainOutcome} from './gateway-drain.ts';
import type {RuntimeShutdownCause} from './shutdown-policy.ts';
export interface RuntimeShutdownWatchPorts {readonly control:(signal:AbortSignal)=>Promise<GatewayDrainOutcome>;readonly workerExit:(signal:AbortSignal)=>Promise<string|null>;readonly gatewayExit:(signal:AbortSignal)=>Promise<number|null>}
export interface RuntimeShutdownSelection {readonly cause:RuntimeShutdownCause;readonly drainKey:DrainFenceKey|null;readonly startedAt:number;readonly secondaryWatchErrors:readonly unknown[]}
const used=new WeakSet<object>();
/** Select one cause, revoke and JOIN every losing read/control operation. The
 * selected monotonic time is passed to cleanup so reaping does not reset its
 * total 30-second budget. Signal is an explicit normal shutdown request. */
export async function waitRuntimeShutdownCause(input:RuntimeShutdownWatchPorts,signal:AbortSignal,options:RuntimeHardDeadlineOptions={}):Promise<RuntimeShutdownSelection>{
 const funcs:Record<string,Function>=Object.create(null);for(const name of ['control','workerExit','gatewayExit']){const fn=own(input,name);if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned runtime watcher');funcs[name]=fn;}
 const clock=options.clock??nativeGatewayShutdownClock,fatal=options.fatal;if(fatal!==undefined&&(typeof fatal!=='function'||types.isProxy(fatal)||types.isAsyncFunction(fatal)||types.isGeneratorFunction(fatal)))throw new TypeError('Expected synchronous fatal watcher policy');
 const now=()=>{const n=clock.now();if(!Number.isFinite(n)||n<0)throw new TypeError('Invalid watcher clock');return n;};now();if(used.has(input))throw new Error('Runtime watcher ports already consumed');used.add(input);
 const success=():RuntimeShutdownCause=>Object.freeze({kind:'Control',result:Object.freeze({ok:true})});
 if(signal.aborted)return Object.freeze({cause:success(),drainKey:null,startedAt:now(),secondaryWatchErrors:Object.freeze([])});
 const cancel=new AbortController(),cancelReason=Object.freeze(new Error('Other shutdown cause selected'));
 const tasks=Object.keys(funcs).map(name=>Promise.resolve().then(()=>{const p=Reflect.apply(funcs[name]!,input,[cancel.signal]);if(!types.isPromise(p))throw new TypeError('Expected native watcher Promise');return p;}).then(value=>({name,ok:true as const,value}),error=>({name,ok:false as const,error})));
 let stop!:()=>void;const stopped=new Promise<{name:'stop';ok:true;value:null}>(resolve=>{stop=()=>resolve({name:'stop',ok:true,value:null});});signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
 try{
  const selected=await Promise.race([...tasks,stopped]),startedAt=now();cancel.abort(cancelReason);
  const all=await completeBeforeRuntimeShutdownDeadline(startedAt+RUNTIME_SHUTDOWN_TIMEOUT_MS,'runtime-watchers',Promise.all(tasks),{clock,...(fatal===undefined?{}:{fatal})});
  const secondary=all.filter(r=>r!==selected&&!r.ok&&r.error!==cancelReason).map(r=>(r as {error:unknown}).error);
  let cause:RuntimeShutdownCause,drainKey:DrainFenceKey|null=null;
  if(selected.name==='stop')cause=success();
  else if(!selected.ok)cause=Object.freeze({kind:'Control',result:Object.freeze({ok:false,error:selected.error})});
  else{try{if(selected.name==='workerExit'){if(selected.value===null)cause=Object.freeze({kind:'WorkerMonitorClosed'});else{if(typeof selected.value!=='string')throw new TypeError('Invalid worker exit identity');cause=Object.freeze({kind:'Worker',worker:selected.value});}}
   else if(selected.name==='gatewayExit'){if(selected.value===null)cause=Object.freeze({kind:'GatewayMonitorClosed'});else{if(typeof selected.value!=='number'||!Number.isInteger(selected.value)||selected.value<0||selected.value>0xffffffff)throw new TypeError('Invalid shard exit identity');cause=Object.freeze({kind:'GatewayShard',shard:selected.value});}}
   else{const kind=own(selected.value,'kind');if(kind==='Drained'){const key=own(selected.value,'key');if(getDrainFenceKeyRecord(key)===null)throw new TypeError('Invalid drained control fence');drainKey=key as DrainFenceKey;}else if(kind!=='Shutdown')throw new TypeError('Invalid gateway control outcome');cause=success();}
  }catch(error){cause=Object.freeze({kind:'Control',result:Object.freeze({ok:false,error})});}}
  return Object.freeze({cause,drainKey,startedAt,secondaryWatchErrors:Object.freeze(secondary)});
 }finally{signal.removeEventListener('abort',stop);}
}
