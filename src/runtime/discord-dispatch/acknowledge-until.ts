import {types} from 'node:util';
import {nativeGatewayShutdownClock,type GatewayShutdownClock} from '../../discord/gateway/shutdown.ts';
import {InteractionDispatchError} from './errors.ts';
export const INTERACTION_ACK_BUDGET_MS=2500;
export function interactionAcknowledgementDeadline(receivedAtMs:number):number{if(!Number.isFinite(receivedAtMs)||receivedAtMs<0||!Number.isFinite(receivedAtMs+INTERACTION_ACK_BUDGET_MS))throw new TypeError('Expected monotonic interaction receipt time');return receivedAtMs+INTERACTION_ACK_BUDGET_MS;}
type Result={ok:true}|{ok:false;error:unknown};
/** Deadline-first acknowledgement acceptance. Node explicitly cancels and joins
 * the actual operation/timer; a noncooperative operation remains pending for its
 * outer runtime deadline owner. This is not a2.5s hard wall-time return guarantee.
 * A distinct async cleanup failure is surfaced, unlike dropping a Rust future. */
export async function acknowledgeUntil(start:(signal:AbortSignal)=>Promise<void>,deadlineMs:number,force:AbortSignal,sourceClock:GatewayShutdownClock=nativeGatewayShutdownClock):Promise<boolean>{
 if(typeof start!=='function'||types.isProxy(start)||types.isGeneratorFunction(start))throw new TypeError('Expected owned acknowledgement operation');if(!Number.isFinite(deadlineMs)||deadlineMs<0)throw new TypeError('Expected acknowledgement deadline');const clock={now:sourceClock.now.bind(sourceClock),sleepUntil:sourceClock.sleepUntil.bind(sourceClock)},now=()=>{const time=clock.now();if(!Number.isFinite(time)||time<0)throw new TypeError('Expected monotonic acknowledgement clock');return time;};force.throwIfAborted();if(now()>=deadlineMs)return false;
 const operationAbort=new AbortController(),timerAbort=new AbortController(),timeoutReason=new Error('Interaction acknowledgement deadline exceeded');let wakeForce!:()=>void;const forced=new Promise<void>(r=>{wakeForce=r;});force.addEventListener('abort',wakeForce,{once:true});
 let operationResult:Result|undefined,started=false,timerDone=false,timerFailed=false,timerError:unknown;
 const task=Promise.resolve().then(async()=>{force.throwIfAborted();if(now()>=deadlineMs)return;started=true;const pending=start(operationAbort.signal);if(!types.isPromise(pending))throw new TypeError('Acknowledgement must return Promise');const result:unknown=await pending;if(result!==undefined)throw new TypeError('Acknowledgement completion must be void');}).then(()=>{operationResult={ok:true};},error=>{operationResult={ok:false,error};});
 const timer=Promise.resolve().then(()=>clock.sleepUntil(deadlineMs,timerAbort.signal)).then(()=>{timerDone=true;},error=>{timerFailed=true;timerError=error;});
 let accepted=false,failed=false,primary:unknown,cancelledPending=false;
 try{await Promise.race([task,timer,forced]);force.throwIfAborted();if(timerDone||now()>=deadlineMs)accepted=false;else if(timerFailed)throw timerError;else if(operationResult===undefined)throw new Error('Acknowledgement ownership invariant');else if(!operationResult.ok)throw new InteractionDispatchError('Acknowledge',operationResult.error);else accepted=true;}
 catch(error){failed=true;primary=error;}
 finally{force.removeEventListener('abort',wakeForce);cancelledPending=operationResult===undefined;if(cancelledPending)operationAbort.abort(force.aborted?force.reason:timeoutReason);timerAbort.abort(new Error('Acknowledgement timer no longer needed'));await Promise.all([task,timer]);}
 const final=operationResult as Result|undefined;
 if(cancelledPending&&started&&final!==undefined&&!final.ok&&final.error!==operationAbort.signal.reason){const cleanup=new InteractionDispatchError('Acknowledge',final.error);if(failed)throw new AggregateError([primary,cleanup],'Acknowledgement failed and cleanup also failed');throw cleanup;}
 if(failed)throw primary;return accepted;
}
