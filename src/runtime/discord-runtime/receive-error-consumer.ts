import {setImmediate as yieldToRuntime} from 'node:timers/promises';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {nativeGatewayShutdownClock,type GatewayShutdownClock} from '../../discord/gateway/shutdown.ts';
import type {GatewayReceiveError} from '../../discord/gateway/ingress.ts';
import type {IngressLaneReceiver} from '../../discord/gateway/lane.ts';
import type {RuntimeWorkerResult} from './monitored-worker.ts';
export const RECEIVE_ERROR_DRAIN_TIMEOUT_MS=13000;
export class RuntimeTypedIngressError extends Error{readonly kind:'Closed'|'DrainTimeout';readonly lane:string;constructor(kind:'Closed'|'DrainTimeout',lane:string){super(kind==='Closed'?`Discord typed ingress ${lane} channel closed before shutdown`:`Discord typed ingress ${lane} shutdown drain exceeded its deadline`);this.name='RuntimeTypedIngressError';this.kind=kind;this.lane=lane;}}
/** Owns this single receiver. The shutdown signal is one-way true (including
 * source watch-sender closure); force is actual cooperative worker cancellation.
 * Pending reads are retained across shutdown selection and joined on every exit.
 * Deadline/shutdown take priority over an already-ready item. This consumer only
 * reports diagnostic payloads; it never executes commands from those strings. */
export async function runReceiveErrorConsumer(receiver:IngressLaneReceiver<GatewayReceiveError>,shutdown:AbortSignal,force:AbortSignal,report:(item:GatewayReceiveError)=>void,clock:GatewayShutdownClock=nativeGatewayShutdownClock):Promise<RuntimeWorkerResult>{
 const read=receiver.receive.bind(receiver),dispose=receiver.dispose.bind(receiver),readAbort=new AbortController();
 let deadline:number|undefined,pending:Promise<void>|undefined,slot:{ok:true;item:GatewayReceiveError|null}|{ok:false;error:unknown}|undefined,iterations=0;
 let wakeShutdown!:()=>void,wakeForce!:()=>void;const stopped=new Promise<void>(r=>{wakeShutdown=r;}),forced=new Promise<void>(r=>{wakeForce=r;});shutdown.addEventListener('abort',wakeShutdown,{once:true});force.addEventListener('abort',wakeForce,{once:true});
 const now=()=>{const value=clock.now();if(!Number.isFinite(value)||value<0)throw new TypeError('Expected monotonic consumer clock');return value;};
 try{for(;;){force.throwIfAborted();if(deadline===undefined&&shutdown.aborted)deadline=now()+RECEIVE_ERROR_DRAIN_TIMEOUT_MS;if(deadline!==undefined&&now()>=deadline)return Object.freeze({ok:false,error:new RuntimeTypedIngressError('DrainTimeout','receive-error')});
  if(slot!==undefined){const item=slot;slot=undefined;pending=undefined;if(!item.ok)throw item.error;if(item.item===null)return deadline===undefined?Object.freeze({ok:false,error:new RuntimeTypedIngressError('Closed','receive-error')}):Object.freeze({ok:true});invokeSynchronousVoid(report,{},[item.item]);if(++iterations%64===0)await yieldToRuntime();continue;}
  if(pending===undefined)pending=read(readAbort.signal).then(item=>{slot={ok:true,item};},error=>{slot={ok:false,error};});
  const timerAbort=new AbortController(),timer=deadline===undefined?undefined:Promise.resolve().then(()=>clock.sleepUntil(deadline!,timerAbort.signal));
  try{await Promise.race([pending,forced,...(deadline===undefined?[stopped]:[]),...(timer===undefined?[]:[timer])]);}finally{timerAbort.abort(new Error('Consumer timer no longer needed'));if(timer!==undefined)await timer.catch(()=>{});}
 }}finally{shutdown.removeEventListener('abort',wakeShutdown);force.removeEventListener('abort',wakeForce);readAbort.abort(new Error('Consumer read no longer needed'));try{await pending;}finally{dispose();}}
}
