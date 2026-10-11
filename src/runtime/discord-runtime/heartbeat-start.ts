import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {runRuntimeHeartbeat,encodeRuntimeHeartbeat,unixHeartbeatSeconds,type RuntimeHeartbeatPort,type RuntimeHeartbeatOptions} from '../runtime-heartbeat.ts';
import {RuntimeMonitoredWorker,RuntimeWorkerExitChannel} from './monitored-worker.ts';
import type {RuntimeHeartbeatOwner} from './finalize-shutdown.ts';
/** Registers actual serial marker IO with the common exit/join owner. Caller must
 * already hold exclusive runtime-instance ownership for this port. This neither
 * acquires that guard nor provides a Windows adapter. No IO starts until the
 * monitored callback enters; stop/abort still joins publication and removal. */
export function captureRuntimeHeartbeatInput(input:RuntimeHeartbeatPort,options:RuntimeHeartbeatOptions):Readonly<{port:RuntimeHeartbeatPort;options:RuntimeHeartbeatOptions}>{
 const publish=own(input,'publish'),remove=own(input,'removeIfOwned'),report=own(options,'report');
 for(const f of [publish,remove,report])if(typeof f!=='function'||types.isProxy(f)||types.isGeneratorFunction(f))throw new TypeError('Expected owned heartbeat operation');
 if(types.isAsyncFunction(report))throw new TypeError('Expected synchronous heartbeat diagnostic');
 const optional=(key:string)=>Object.hasOwn(options,key)?own(options,key):undefined;
 const pid=optional('pid')??process.pid,seconds=optional('seconds')??unixHeartbeatSeconds,periodMs=optional('periodMs')??10000;
 encodeRuntimeHeartbeat(pid as number,0n);
 if(typeof periodMs!=='number'||!Number.isInteger(periodMs)||periodMs<=0||periodMs>2147483647||typeof seconds!=='function'||types.isProxy(seconds)||types.isAsyncFunction(seconds)||types.isGeneratorFunction(seconds))throw new TypeError('Invalid heartbeat timing');
 const port:RuntimeHeartbeatPort=Object.freeze({publish:(text:string)=>Reflect.apply(publish as Function,input,[text]),removeIfOwned:(text:string)=>Reflect.apply(remove as Function,input,[text])});
 const captured:RuntimeHeartbeatOptions=Object.freeze({pid:pid as number,seconds:()=>Reflect.apply(seconds as Function,undefined,[]),periodMs,report:(event:string,error:unknown)=>invokeSynchronousVoid(report as Function,options,[event,error])});
 return Object.freeze({port,options:captured});
}
export function startRuntimeHeartbeatWorker(input:RuntimeHeartbeatPort,notifier:RuntimeWorkerExitChannel,options:RuntimeHeartbeatOptions):RuntimeHeartbeatOwner{
 const {port,options:captured}=captureRuntimeHeartbeatInput(input,options);
 const stop=new AbortController();
 const worker=new RuntimeMonitoredWorker('heartbeat',notifier,async force=>{try{await runRuntimeHeartbeat(port,AbortSignal.any([stop.signal,force]),captured);return {ok:true};}catch(error){return {ok:false,error};}});
 return Object.freeze({worker,requestStop:()=>stop.abort()});
}
