import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {types} from 'node:util';
import {nativeGatewayShutdownClock,type GatewayShutdownClock} from '../../discord/gateway/shutdown.ts';
import {BroadcastClosedError,BroadcastLaggedError} from '../../app-server/broadcast.ts';
import type {GatewayIdentity,GatewayIdentityConflict,GatewayStateReceiver} from '../../discord/gateway/identity.ts';
import type {MessageGapReceiver} from '../../discord/gateway/message-gaps.ts';
import {HistoryPollState} from '../history-poll/state.ts';
import type {HistoryRecoveryDisposition} from './gap-recovery.ts';
import {waitForGatewayIdentity} from './identity-wait.ts';
import {guardGatewayIdentity} from './identity-guard.ts';
import {RuntimeTypedIngressError} from './receive-error-consumer.ts';
export interface HistoryConsumerOperations{
 recover(identity:GatewayIdentity,signal:AbortSignal):Promise<HistoryRecoveryDisposition|void>;
 poll(state:HistoryPollState,identity:GatewayIdentity,signal:AbortSignal):Promise<void>;
}
const retryDelays=Object.freeze([1000,2000,4000,8000,16000,30000]);
export function historyCapacityRetryDelay(index:number):number{if(!Number.isSafeInteger(index)||index<0)throw new TypeError('Expected history retry index');return retryDelays[Math.min(index,5)]!;}
function captureClock(source:GatewayShutdownClock):GatewayShutdownClock{
 const now=own(source,'now'),sleep=own(source,'sleepUntil');
 for(const fn of [now,sleep])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected history clock function');
 if(types.isAsyncFunction(now))throw new TypeError('Expected synchronous history clock');let previous=0;
 return Object.freeze({now:()=>{const value=Reflect.apply(now as Function,source,[]);if(typeof value!=='number'||!Number.isFinite(value)||value<previous)throw new TypeError('Expected monotonic history clock');previous=value;return value;},sleepUntil:(at:number,signal:AbortSignal)=>{const pending=Reflect.apply(sleep as Function,source,[at,signal]);if(!types.isPromise(pending))throw new TypeError('Expected history clock Promise');return pending as Promise<void>;}});
}
function retryRequested(value:HistoryRecoveryDisposition|void):boolean{
 if(value===undefined)return false;const retry=own(value,'retryCapacity');if(!Object.isFrozen(value)||typeof retry!=='boolean')throw new TypeError('Expected frozen history recovery disposition');return retry;
}
type Hint={ok:true}|{ok:false;error:unknown};
type Wake='Gap'|'Poll'|'Retry';
/** A consumed gap hint always outranks a simultaneously ready timer. The losing
 * receive/timer is cancelled AND joined; sticky snapshots remain authoritative. */
async function waitHint(gaps:MessageGapReceiver,at:number|null,kind:'Poll'|'Retry',clock:GatewayShutdownClock,signal:AbortSignal):Promise<Wake>{
 signal.throwIfAborted();const controller=new AbortController(),cancel=new Error('History hint wait completed'),combined=AbortSignal.any([signal,controller.signal]);let gap:Hint|undefined,timed:Hint|undefined;
 const read=Promise.resolve().then(()=>gaps.changed(combined)).then(()=>{gap={ok:true};},error=>{gap={ok:false,error};});
 const timer=at===null?null:Promise.resolve().then(()=>clock.sleepUntil(at,combined)).then(()=>{timed={ok:true};},error=>{timed={ok:false,error};});
 try{await Promise.race(timer===null?[read]:[read,timer]);}
 finally{controller.abort(cancel);await Promise.all([read,...(timer===null?[]:[timer])]);}
 signal.throwIfAborted();
 if(timed!==undefined&&!timed.ok&&timed.error!==cancel)throw timed.error;
 if(gap!==undefined){if(gap.ok||gap.error instanceof BroadcastLaggedError)return 'Gap';if(gap.error instanceof BroadcastClosedError)throw new RuntimeTypedIngressError('Closed','message-gap');if(gap.error!==cancel)throw gap.error;}
 return kind;
}
/** Owns one gap receiver and serializes recovery/periodic work. Proven unsubmitted
 * policy capacity schedules one fresh-snapshot retry, using only a deadline and
 * saturating index: 1/2/4/8/16/30 seconds, with no attempt ceiling. This is an
 * explicit TypeScript liveness policy, not Rust timer parity. No page, command,
 * notice queue, permit or native slot is retained during delay. Identity conflict,
 * shutdown and force cancel and join the actual operation or losing wait. */
export async function runHistoryConsumer(gaps:MessageGapReceiver,identity:GatewayStateReceiver<GatewayIdentity|null>,conflict:GatewayStateReceiver<GatewayIdentityConflict|null>,shutdown:AbortSignal,force:AbortSignal,periodMs:number|null,operations:HistoryConsumerOperations,sourceClock:GatewayShutdownClock=nativeGatewayShutdownClock):Promise<void>{
 if(periodMs!==null&&(!Number.isSafeInteger(periodMs)||periodMs<=0||periodMs>2147483647))throw new TypeError('Expected positive supported history period');
 const recover=own(operations,'recover') as HistoryConsumerOperations['recover'],poll=own(operations,'poll') as HistoryConsumerOperations['poll'];for(const fn of [recover,poll])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned history operations');
 const clock=captureClock(sourceClock),state=new HistoryPollState();let next:number|null=null,retryAt:number|null=null,retryIndex=0,gapDue=true,pollDue=periodMs!==null;
 try{
  const established=await waitForGatewayIdentity(identity,conflict,shutdown,force);if(established===null)return;next=periodMs===null?null:clock.now()+periodMs;
  for(;;){
   force.throwIfAborted();if(shutdown.aborted)return;
   if(gapDue){
    const out=await guardGatewayIdentity(signal=>recover.call(operations,established,signal),conflict,shutdown,force);if(!out.completed)return;
    if(retryRequested(out.value)){const now=clock.now();if(retryAt===null||retryAt<=now){retryAt=now+historyCapacityRetryDelay(retryIndex);retryIndex=Math.min(retryIndex+1,5);}}
    else{retryAt=null;retryIndex=0;}
    gapDue=false;continue;
   }
   if(pollDue){const out=await guardGatewayIdentity(signal=>poll.call(operations,state,established,signal),conflict,shutdown,force);if(!out.completed)return;if(out.value!==undefined)throw new TypeError('History poll must return void');pollDue=false;gapDue=true;continue;}
   const retryFirst=retryAt!==null&&(next===null||retryAt<=next),at=retryFirst?retryAt:next;
   const out=await guardGatewayIdentity(signal=>waitHint(gaps,at,retryFirst?'Retry':'Poll',clock,signal),conflict,shutdown,force);if(!out.completed)return;
   if(out.value==='Gap')gapDue=true;
   else if(out.value==='Retry'){retryAt=null;gapDue=true;}
   else{if(periodMs===null)throw new TypeError('Disabled history poll woke');pollDue=true;gapDue=true;next=clock.now()+periodMs;}
  }
 }finally{gaps.dispose();}
}
