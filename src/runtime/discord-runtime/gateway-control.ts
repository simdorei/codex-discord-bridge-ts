import {types} from 'node:util';
import {DelayedTicks} from '../delayed-ticks.ts';
import {RuntimeDrainController} from '../restart-readiness/drain-controller.ts';
import {drainUntilQuiescent,GATEWAY_DRAIN_TIMING,type GatewayDrainPorts,type GatewayDrainTiming,type GatewayDrainOutcome} from './gateway-drain.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import type {AdmissionGate} from '../../admission/drain-gate.ts';
const active=new WeakSet<RuntimeDrainController>();
const gateGetter=Object.getOwnPropertyDescriptor(RuntimeDrainController.prototype,'admissionGate')!.get!;
/** Polls immediately then uses one bounded Delay tick. Malformed/foreign prepare
 * seals ordinary ingress without shutting down the gateway. Explicit stopSignal
 * represents caller-owned signal handling; native Ctrl-C wiring remains separate. */
export async function runGatewayControlLoop(controller:RuntimeDrainController,input:GatewayDrainPorts,stopSignal:AbortSignal,time:GatewayDrainTiming=GATEWAY_DRAIN_TIMING):Promise<GatewayDrainOutcome>{
 const stop=own(input,'stopRequested'),inspect=own(input,'inspect'),report=own(input,'report');
 for(const fn of [stop,inspect,report])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned gateway control port');
 if(types.isAsyncFunction(report))throw new TypeError('Expected synchronous gateway control reporter');
 const call=async(fn:Function,args:unknown[]=[])=>{const task=Reflect.apply(fn,input,args);if(!types.isPromise(task))throw new TypeError('Expected native gateway control Promise');return task;};
 const log=(event:string,detail:unknown)=>invokeSynchronousVoid(report as Function,input,[event,detail]);
 const gate=Reflect.apply(gateGetter,controller,[]) as AdmissionGate;
 if(active.has(controller))throw new Error('Gateway control loop already active for this owner');
 const readTime=(key:string)=>{const v=own(time,key);if(typeof v!=='number'||!Number.isSafeInteger(v)||v<=0||v>2147483647)throw new TypeError('Expected bounded control timing');return v;};const fixed=Object.freeze({pollMs:readTime('pollMs'),admissionTimeoutMs:readTime('admissionTimeoutMs'),errorRetryMs:readTime('errorRetryMs')}),poll=fixed.pollMs;
 active.add(controller);const ticks=new DelayedTicks(poll);const wake=()=>ticks.close();stopSignal.addEventListener('abort',wake,{once:true});let failure:string|null=null;
 try{for(;;){
  if(stopSignal.aborted)return Object.freeze({kind:'Shutdown'});const stopped=await call(stop as Function);if(typeof stopped!=='boolean')throw new TypeError('Expected stop marker flag');if(stopped||stopSignal.aborted)return Object.freeze({kind:'Shutdown'});
  let key;try{key=await RuntimeDrainController.prototype.claimPrepare.call(controller);}catch(error){let quarantineError:unknown;try{RuntimeDrainController.prototype.quarantineUntrustedPrepare.call(controller);}catch(e){quarantineError=e;}
   const fingerprint=passiveErrorText(error,'prepare claim failed')+';'+(quarantineError===undefined?'sealed':passiveErrorText(quarantineError,'existing seal retained'));
   if(failure!==fingerprint){log('restart_drain_prepare_claim_failed',Object.freeze({error,quarantineError}));failure=fingerprint;}
   await ticks.wait();continue;
  }
  if(stopSignal.aborted)return Object.freeze({kind:'Shutdown'});
  if(key!==null){log('restart_drain_sealed',key);return await drainUntilQuiescent(gate,key,{stopRequested:async()=>{const value=await call(stop as Function);if(typeof value!=='boolean')throw new TypeError('Expected stop marker flag');return value;},inspect:async signal=>{const state=await call(inspect as Function,[signal]),kind=own(state,'kind');if(kind==='Ready')return {kind:'Ready'};if(kind==='Blocked'){const reason=own(state,'reason');if(typeof reason==='string')return {kind:'Blocked',reason};}throw new TypeError('Malformed live inspection result');},report:log},stopSignal,fixed);}
  await ticks.wait();
 }}finally{ticks.close();stopSignal.removeEventListener('abort',wake);active.delete(controller);}
}
