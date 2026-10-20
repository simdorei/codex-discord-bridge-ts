import {types} from 'node:util';
import {GatewayRuntime} from '../../discord/gateway/runtime.ts';
import type {IngressLaneReceiver} from '../../discord/gateway/lane.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {RuntimeDrainController} from '../restart-readiness/drain-controller.ts';
import type {DrainFenceKey} from '../../admission/owned-key.ts';
import {runGatewayControlLoop} from './gateway-control.ts';
import {GATEWAY_DRAIN_TIMING,type GatewayDrainPorts,type GatewayDrainTiming} from './gateway-drain.ts';
import type {RuntimeShutdownCause} from './shutdown-policy.ts';
export interface RuntimeStopSelection{readonly cause:RuntimeShutdownCause;readonly drainKey:DrainFenceKey|null;readonly additionalCauses:readonly RuntimeShutdownCause[];}
export class RuntimeStopMonitorError extends Error{readonly source:'worker'|'gateway';constructor(source:'worker'|'gateway',cause:unknown){super('Runtime exit monitor failed',{cause});this.name='RuntimeStopMonitorError';this.source=source;}}
const active=new WeakSet<object>();
type Event={cause:RuntimeShutdownCause;drainKey:DrainFenceKey|null};
/** Waits on actual gateway shard exit, shared worker exit and drain/control loop.
 * Losing waits are cancelled AND joined, without disposing borrowed receivers or
 * starting cleanup. Already resolved competing causes remain diagnostic evidence.
 * Only a winning successful drain carries handshake authority. Caller owns the
 * common-deadline cleanup after selection; accepted marker IO must be responsive. */
export async function waitForRuntimeStop<I extends object>(gateway:GatewayRuntime<I>,exits:IngressLaneReceiver<string>,controller:RuntimeDrainController,ports:GatewayDrainPorts,userStop:AbortSignal,timing:GatewayDrainTiming=GATEWAY_DRAIN_TIMING):Promise<RuntimeStopSelection>{
 if(types.isProxy(userStop)||!(userStop instanceof AbortSignal))throw new TypeError('Expected runtime stop signal');
 GatewayRuntime.prototype.publicationSnapshot.call(gateway);Object.getOwnPropertyDescriptor(RuntimeDrainController.prototype,'admissionGate')!.get!.call(controller);
 const receive=own(exits,'receive');if(typeof receive!=='function'||types.isProxy(receive)||types.isGeneratorFunction(receive))throw new TypeError('Expected owned worker exit receiver');
 if(active.has(gateway)||active.has(exits)||active.has(controller))throw new TypeError('Runtime stop monitor already active');active.add(gateway);active.add(exits);active.add(controller);
 const cancel=new AbortController(),cancelled=Object.freeze(new Error('Runtime stop selection finished'));
 const observe=async(source:'worker'|'gateway',operation:()=>Promise<unknown>):Promise<Event|null>=>{
  try{const value=await operation();if(source==='worker'){if(value!==null&&typeof value!=='string')throw new TypeError('Invalid worker exit identity');return {cause:value===null?{kind:'WorkerMonitorClosed'}:{kind:'Worker',worker:value},drainKey:null};}
   if(value!==null&&(typeof value!=='number'||!Number.isInteger(value)||value<0||value>4294967295))throw new TypeError('Invalid gateway exit identity');return {cause:value===null?{kind:'GatewayMonitorClosed'}:{kind:'GatewayShard',shard:value},drainKey:null};
  }catch(error){if(error===cancelled)return null;return {cause:{kind:'Control',result:{ok:false,error:new RuntimeStopMonitorError(source,error)}},drainKey:null};}
 };
 try{
  const control:Promise<Event>=runGatewayControlLoop(controller,ports,AbortSignal.any([userStop,cancel.signal]),timing).then(outcome=>({cause:{kind:'Control',result:{ok:true}},drainKey:outcome.kind==='Drained'?outcome.key:null}),error=>({cause:{kind:'Control',result:{ok:false,error}},drainKey:null}));
  const worker=observe('worker',()=>{const task=Reflect.apply(receive as Function,exits,[cancel.signal]);if(!types.isPromise(task))throw new TypeError('Expected worker exit Promise');return task;}),shard=observe('gateway',()=>GatewayRuntime.prototype.waitForShardExit.call(gateway,cancel.signal));
  const candidates=[control,worker,shard];const selected=await Promise.race(candidates.map((task,index)=>task.then(event=>({event,index}))));
  if(selected.event===null)throw new Error('Runtime monitor cancelled before selection');cancel.abort(cancelled);const joined=await Promise.all(candidates);
  // The control loop's synthetic Shutdown on our cancellation is not a second cause.
  const additional=joined.flatMap((event,index)=>event===null||index===selected.index||index===0&&event.cause.kind==='Control'&&event.cause.result.ok&&event.drainKey===null?[]:[event.cause]);
  return Object.freeze({cause:Object.freeze(selected.event.cause),drainKey:selected.event.drainKey,additionalCauses:Object.freeze(additional)});
 }finally{cancel.abort(cancelled);active.delete(gateway);active.delete(exits);active.delete(controller);}
}
