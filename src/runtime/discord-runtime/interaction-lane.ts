import {types} from 'node:util';
import {setImmediate as yieldToRuntime} from 'node:timers/promises';
import type {InteractionIngress,GatewayInteractionTag} from '../../discord/gateway/ingress.ts';
import {isDecodedGatewayInteraction,type DecodedGatewayInteraction} from '../../discord/gateway/decoded-interaction.ts';
import type {IngressLaneReceiver} from '../../discord/gateway/lane.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {nativeGatewayShutdownClock,type GatewayShutdownClock} from '../../discord/gateway/shutdown.ts';
import {RuntimeTypedIngressError} from './receive-error-consumer.ts';
import {reportInteractionEventResult,type InteractionFailureReport} from './interaction-failure.ts';
import type {RuntimeWorkerResult} from './monitored-worker.ts';
export type InteractionLane='Normal'|'Reserved';
export type OwnedInteractionIngress=InteractionIngress<DecodedGatewayInteraction>;
export type InteractionLaneHandler=(item:OwnedInteractionIngress,signal:AbortSignal)=>Promise<void>;
export class RuntimeInteractionTagError extends Error{readonly lane:string;readonly tag:GatewayInteractionTag;constructor(lane:string,tag:GatewayInteractionTag){super(`Discord typed ingress ${lane} lane received unexpected ${tag} item`);this.name='RuntimeInteractionTagError';this.lane=lane;this.tag=tag;}}
interface Job{item:OwnedInteractionIngress;abort:AbortController;done?:Promise<void>;result?:RuntimeWorkerResult}
type Read={ok:true;value:OwnedInteractionIngress|null}|{ok:false;error:unknown};
function capture(value:OwnedInteractionIngress,lane:InteractionLane,name:string):OwnedInteractionIngress{const tag=gatewayOwnField(value,'tag');if(tag!=='Normal'&&tag!=='Busy'&&tag!=='Stopping')throw new TypeError('Expected typed interaction tag');if(lane==='Normal'?tag!=='Normal':tag==='Normal')throw new RuntimeInteractionTagError(name,tag);const event=gatewayOwnField(value,'event'),sequence=gatewayOwnField(value,'sequence'),receivedAtMs=gatewayOwnField(value,'receivedAtMs');if(!isDecodedGatewayInteraction(event)||typeof sequence!=='bigint'||sequence<0n||sequence>(1n<<64n)-1n||typeof receivedAtMs!=='number'||!Number.isFinite(receivedAtMs)||receivedAtMs<0)throw new TypeError('Expected complete interaction ingress');return Object.freeze({tag,event,sequence,receivedAtMs});}
/** Owns one receiver and actual handler operations. Normal accepts Normal tags
 * with16 slots and stops on shutdown; Reserved accepts Busy/Stopping with4 slots
 * and drains for13s. Available input is validated before starting lazy handlers.
 * Promise scheduling is a Node profile, not exact Tokio FuturesUnordered poll
 * order. All started operations must cooperate with cancellation and are joined;
 * outer runtime deadline escalation remains mandatory for uncooperative work. */
export async function runInteractionLane(lane:InteractionLane,receiver:IngressLaneReceiver<OwnedInteractionIngress>,handler:InteractionLaneHandler,shutdown:AbortSignal,force:AbortSignal,options:{report:(value:InteractionFailureReport)=>void;clock?:GatewayShutdownClock}):Promise<void>{
 if(lane!=='Normal'&&lane!=='Reserved')throw new TypeError('Expected interaction lane');if(typeof handler!=='function'||types.isProxy(handler)||types.isGeneratorFunction(handler))throw new TypeError('Expected interaction handler');if(typeof options.report!=='function'||types.isProxy(options.report)||types.isAsyncFunction(options.report)||types.isGeneratorFunction(options.report))throw new TypeError('Expected synchronous interaction reporter');
 const name=lane==='Normal'?'normal-interaction':'reserved-interaction',limit=lane==='Normal'?16:4,clock=options.clock??nativeGatewayShutdownClock,report=options.report.bind(options),readAbort=new AbortController(),cancel=new Error('Interaction lane stopped'),active=new Set<Job>(),completed:Job[]=[];
 const receive=receiver.receive.bind(receiver),poll=receiver.tryReceive.bind(receiver),close=receiver.close.bind(receiver),dispose=receiver.dispose.bind(receiver),now=()=>{const n=clock.now();if(!Number.isFinite(n)||n<0)throw new TypeError('Expected monotonic interaction clock');return n;};
 let read:Promise<void>|undefined,slot:Read|undefined,inputClosed=false,deadline:number|undefined,turns=0,failed=false,primary:unknown;let wakeStop!:()=>void,wakeForce!:()=>void;const stopped=new Promise<void>(r=>{wakeStop=r;}),forced=new Promise<void>(r=>{wakeForce=r;});shutdown.addEventListener('abort',wakeStop,{once:true});force.addEventListener('abort',wakeForce,{once:true});
 const start=(job:Job)=>{job.done=Promise.resolve().then(async()=>{job.abort.signal.throwIfAborted();const work=handler(job.item,job.abort.signal);if(!types.isPromise(work))throw new TypeError('Interaction handler must return Promise');const value:unknown=await work;if(value!==undefined)throw new TypeError('Interaction handler completion must be void');}).then(()=>{job.result=Object.freeze({ok:true});completed.push(job);},error=>{job.result=Object.freeze({ok:false,error});completed.push(job);});};
 let cleanupPending:Job[]=[];const cleanupCallbackErrors:unknown[]=[];
 try{for(;;){if(++turns%64===0)await yieldToRuntime();force.throwIfAborted();if(deadline===undefined&&shutdown.aborted){if(lane==='Normal')break;deadline=now()+13000;}if(inputClosed&&active.size===0)break;if(deadline!==undefined&&now()>=deadline)throw new RuntimeTypedIngressError('DrainTimeout',name);
  if(!inputClosed&&active.size<limit){let ready:Read|undefined;if(read!==undefined){if(slot!==undefined){ready=slot;slot=undefined;read=undefined;}}else{const value=poll();if(value.kind==='Value')ready={ok:true,value:value.value};else if(value.kind==='Closed')ready={ok:true,value:null};}
   if(ready!==undefined){if(!ready.ok)throw ready.error;if(ready.value===null){if(deadline===undefined)throw new RuntimeTypedIngressError('Closed',name);inputClosed=true;continue;}active.add({item:capture(ready.value,lane,name),abort:new AbortController()});continue;}
   if(read===undefined)read=receive(readAbort.signal).then(value=>{slot={ok:true,value};},error=>{slot={ok:false,error};});
  }
  const finished=completed.shift();if(finished!==undefined){active.delete(finished);const result=reportInteractionEventResult(name,finished.item.event.id,finished.item.event.token,finished.result!,report);if(!result.ok)throw result.error;continue;}
  const lazy=[...active].find(job=>job.done===undefined);if(lazy!==undefined){start(lazy);await Promise.resolve();continue;}
  const timerAbort=new AbortController(),timer=deadline===undefined?undefined:Promise.resolve().then(()=>clock.sleepUntil(deadline!,timerAbort.signal));try{await Promise.race([forced,...(deadline===undefined?[stopped]:[]),...(read===undefined?[]:[read]),...[...active].flatMap(job=>job.done===undefined?[]:[job.done]),...(timer===undefined?[]:[timer])]);}finally{timerAbort.abort(cancel);if(timer!==undefined)await timer.catch(()=>{});}
 }}catch(error){failed=true;primary=error;}
 finally{shutdown.removeEventListener('abort',wakeStop);force.removeEventListener('abort',wakeForce);try{close();}catch(error){cleanupCallbackErrors.push(error);}readAbort.abort(cancel);cleanupPending=[...active].filter(job=>job.done!==undefined&&job.result===undefined);for(const job of cleanupPending)job.abort.abort(force.aborted?force.reason:cancel);try{await Promise.all([...(read===undefined?[]:[read]),...[...active].flatMap(job=>job.done===undefined?[]:[job.done])]);}finally{try{dispose();}catch(error){cleanupCallbackErrors.push(error);}}}
 const cleanupErrors:unknown[]=[...cleanupCallbackErrors];for(const job of cleanupPending){const result=job.result;if(result!==undefined&&!result.ok&&result.error!==job.abort.signal.reason){try{const retained=reportInteractionEventResult(name,job.item.event.id,job.item.event.token,result,report);if(!retained.ok)cleanupErrors.push(retained.error);}catch(error){cleanupErrors.push(error);}}}
 if(cleanupErrors.length){if(failed)cleanupErrors.unshift(primary);if(cleanupErrors.length===1)throw cleanupErrors[0];throw new AggregateError(cleanupErrors,'Interaction lane and cleanup failed');}if(failed)throw primary;
}
