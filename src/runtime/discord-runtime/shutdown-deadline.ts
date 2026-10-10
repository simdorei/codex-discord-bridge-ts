import {types} from 'node:util';
import {writeSync} from 'node:fs';
import {nativeGatewayShutdownClock,type GatewayShutdownClock} from '../../discord/gateway/shutdown.ts';
export const RUNTIME_SHUTDOWN_TIMEOUT_MS=30000;
export const NON_HEARTBEAT_RESERVE_MS=15000;
export const HEARTBEAT_JOIN_RESERVE_MS=1000;
export interface RuntimeHardDeadlineOptions {readonly clock?:GatewayShutdownClock;readonly fatal?:(component:string)=>never}
function abortProcess(component:string):never{try{writeSync(2,`fatal_runtime_shutdown_timeout component=${component}\n`);}finally{process.abort();}}
function failStop(fatal:(component:string)=>never,component:string):never{const value:unknown=fatal(component);if(types.isPromise(value))void Promise.prototype.then.call(value,undefined,()=>undefined);throw new Error('Fatal runtime shutdown policy returned');}
/** Observes an ALREADY running native Promise. Deadline expiry is fail-stop,
 * never a recoverable completed/closed result. Default abort terminates this
 * runtime process; descendant containment requires the separate platform owner.
 * Tests may inject a nonreturning sentinel and must then finish their own task. */
export async function completeBeforeRuntimeShutdownDeadline<T>(deadline:number,component:string,operation:Promise<T>,options:RuntimeHardDeadlineOptions={}):Promise<T>{
 if(!Number.isFinite(deadline)||deadline<0||typeof component!=='string'||component.length===0||/[\r\n\0]/u.test(component))throw new TypeError('Invalid runtime shutdown deadline');
 if(!types.isPromise(operation))throw new TypeError('Expected actual native shutdown Promise');
 const clock=options.clock??nativeGatewayShutdownClock,fatal=options.fatal??abortProcess;
 if(typeof fatal!=='function'||types.isProxy(fatal)||types.isAsyncFunction(fatal)||types.isGeneratorFunction(fatal))throw new TypeError('Expected synchronous nonreturning fatal policy');
 const cancel=new AbortController();
 const work=Promise.prototype.then.call(operation,(value:T)=>({kind:'Done' as const,value}),(error:unknown)=>({kind:'Error' as const,error})) as Promise<{kind:'Done';value:T}|{kind:'Error';error:unknown}>;
 const timer=Promise.resolve().then(()=>clock.sleepUntil(deadline,cancel.signal)).then(()=>({kind:'Timeout' as const}),error=>({kind:'ClockError' as const,error}));
 const selected=await Promise.race([work,timer]);cancel.abort(new Error('Shutdown deadline observer finished'));await timer;
 if(selected.kind==='Done')return selected.value;if(selected.kind==='Error')throw selected.error;return failStop(fatal,component);
}
