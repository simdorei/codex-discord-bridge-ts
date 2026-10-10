import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {types} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import {BroadcastClosedError,BroadcastLaggedError} from '../../app-server/broadcast.ts';
import type {GatewayIdentity,GatewayIdentityConflict,GatewayStateReceiver} from '../../discord/gateway/identity.ts';
import type {MessageGapReceiver} from '../../discord/gateway/message-gaps.ts';
import {HistoryPollState} from '../history-poll/state.ts';
import {waitForGatewayIdentity} from './identity-wait.ts';
import {guardGatewayIdentity} from './identity-guard.ts';
import {RuntimeTypedIngressError} from './receive-error-consumer.ts';
export interface HistoryConsumerOperations{
 recover(identity:GatewayIdentity,signal:AbortSignal):Promise<void>;
 poll(state:HistoryPollState,identity:GatewayIdentity,signal:AbortSignal):Promise<void>;
}
type Hint={ok:true}|{ok:false;error:unknown};
/** A consumed gap hint always outranks a simultaneously ready timer. The losing
 * receive/timer is cancelled AND joined; sticky snapshots remain authoritative. */
async function waitHint(gaps:MessageGapReceiver,at:number|null,signal:AbortSignal):Promise<'Gap'|'Poll'>{
 signal.throwIfAborted();const controller=new AbortController(),cancel=new Error('History hint wait completed'),combined=AbortSignal.any([signal,controller.signal]);let gap:Hint|undefined;
 const read=gaps.changed(combined).then(()=>{gap={ok:true};},error=>{gap={ok:false,error};});
 const timer=at===null?null:sleep(Math.max(0,at-performance.now()),undefined,{signal:combined}).then(()=>undefined,error=>{if(!combined.aborted)throw error;});
 try{await Promise.race(timer===null?[read]:[read,timer]);}
 finally{controller.abort(cancel);await Promise.all([read,...(timer===null?[]:[timer])]);}
 signal.throwIfAborted();
 if(gap!==undefined){if(gap.ok||gap.error instanceof BroadcastLaggedError)return 'Gap';if(gap.error instanceof BroadcastClosedError)throw new RuntimeTypedIngressError('Closed','message-gap');if(gap.error!==cancel)throw gap.error;}
 return 'Poll';
}
/** Owns one gap receiver and serializes recovery/periodic work. Periodic IO is an
 * explicit required port, never a fabricated implementation. Millisecond Delay
 * scheduling avoids catch-up bursts; exact Tokio timer jitter is not claimed.
 * Identity conflict/shutdown cancels and joins the active real operation. */
export async function runHistoryConsumer(gaps:MessageGapReceiver,identity:GatewayStateReceiver<GatewayIdentity|null>,conflict:GatewayStateReceiver<GatewayIdentityConflict|null>,shutdown:AbortSignal,force:AbortSignal,periodMs:number|null,operations:HistoryConsumerOperations):Promise<void>{
 if(periodMs!==null&&(!Number.isSafeInteger(periodMs)||periodMs<=0||periodMs>2147483647))throw new TypeError('Expected positive supported history period');
 const recover=own(operations,'recover') as HistoryConsumerOperations['recover'],poll=own(operations,'poll') as HistoryConsumerOperations['poll'];for(const fn of [recover,poll])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned history operations');
 const state=new HistoryPollState();let next:number|null=null,gapDue=true,pollDue=periodMs!==null;
 try{
  const established=await waitForGatewayIdentity(identity,conflict,shutdown,force);if(established===null)return;next=periodMs===null?null:performance.now()+periodMs;
  for(;;){
   force.throwIfAborted();if(shutdown.aborted)return;
   if(gapDue){const out=await guardGatewayIdentity(signal=>recover.call(operations,established,signal),conflict,shutdown,force);if(!out.completed)return;if(out.value!==undefined)throw new TypeError('History recovery must return void');gapDue=false;continue;}
   if(pollDue){const out=await guardGatewayIdentity(signal=>poll.call(operations,state,established,signal),conflict,shutdown,force);if(!out.completed)return;if(out.value!==undefined)throw new TypeError('History poll must return void');pollDue=false;gapDue=true;continue;}
   const out=await guardGatewayIdentity(signal=>waitHint(gaps,next,signal),conflict,shutdown,force);if(!out.completed)return;
   if(out.value==='Gap')gapDue=true;else{pollDue=true;gapDue=true;next=periodMs===null?null:performance.now()+periodMs;}
  }
 }finally{gaps.dispose();}
}
