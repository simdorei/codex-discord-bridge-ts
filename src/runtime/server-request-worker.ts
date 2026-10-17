import {performance} from 'node:perf_hooks';
import {types} from 'node:util';
import {PortableResidentLifecycle} from '../app-server/portable-resident-lifecycle.ts';
import {BroadcastClosedError,BroadcastLaggedError,type BroadcastReceiver} from '../app-server/broadcast.ts';
import type {ResidentServerRequestEvent} from '../app-server/resident-forwarders.ts';
import {clonePendingServerRequest,type PendingServerRequest} from '../app-server/server-request-state.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {invokeSynchronousVoid} from '../core/synchronous-void.ts';
import {ServerRequestDelivery} from './server-request-delivery.ts';
import {requirePromptGeneration} from './server-prompt-identity.ts';
const now=performance.now.bind(performance),DELAYS=[1000,2000,4000,8000,16000,30000] as const;
export class ServerRequestRetrySchedule{
 #failures=0;#deadline:number|null=null;
 deadline():number|null{return this.#deadline;}
 scheduleFailure(at:number):void{if(!Number.isFinite(at)||at<0||at>Number.MAX_SAFE_INTEGER-30000)throw new RangeError('Invalid monotonic retry time');if(this.#deadline!==null)return;this.#deadline=at+DELAYS[Math.min(this.#failures,5)]!;this.#failures=Math.min(this.#failures+1,6);}
 beginRetry():void{this.#deadline=null;}
 clear():void{this.#deadline=null;this.#failures=0;}
}
export type ServerRequestWorkerReport={readonly kind:'Error';readonly error:unknown}|{readonly kind:'Gap';readonly generation:bigint|null;readonly skipped:bigint};
const usedReceivers=new WeakSet<object>();
function retryTimer(deadline:number|null){let timer:ReturnType<typeof setTimeout>|undefined;const promise=deadline===null?new Promise<'Retry'>(()=>{}):deadline<=now()?Promise.resolve('Retry' as const):new Promise<'Retry'>(resolve=>{timer=setTimeout(()=>resolve('Retry'),Math.ceil(deadline-now()));});return {promise,cancel:()=>clearTimeout(timer)};}
type Received={kind:'Event';value:ResidentServerRequestEvent}|{kind:'ReceiveError';error:unknown};
/** Owns the exact pre-recovery receiver; never creates a replacement subscription.
 * One serial action, one pending receive, one retry timer; losing receives remain
 * retained. Stop has priority and joins current native/HTTP/receipt work. This is
 * cooperative ownership, not Tokio future-Drop or a hard deadline guarantee. */
export async function runServerRequestWorker(receiver:BroadcastReceiver<ResidentServerRequestEvent>,server:PortableResidentLifecycle,delivery:ServerRequestDelivery,shutdown:AbortSignal,report:(event:ServerRequestWorkerReport)=>void):Promise<void>{
 if(types.isProxy(shutdown)||!(shutdown instanceof AbortSignal))throw new TypeError('Expected server request shutdown signal');
 if(typeof report!=='function'||types.isProxy(report)||types.isAsyncFunction(report)||types.isGeneratorFunction(report))throw new TypeError('Expected synchronous server request diagnostic');
 const receive=own(receiver,'receive'),dispose=own(receiver,'dispose');for(const fn of [receive,dispose])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned startup receiver');
 if(types.isAsyncFunction(dispose))throw new TypeError('Receiver disposal must be synchronous');
 PortableResidentLifecycle.prototype.lifecycleSnapshot.call(server);if(usedReceivers.has(receiver))throw new TypeError('Startup server request receiver already consumed');const owner=ServerRequestDelivery.prototype.claimWorker.call(delivery,server);usedReceivers.add(receiver);
 const notify=(event:ServerRequestWorkerReport)=>invokeSynchronousVoid(report,Object.freeze({}),[Object.freeze(event)]),cancel=new AbortController(),retries=new ServerRequestRetrySchedule();let wake!:()=>void,pending:Promise<Received>|undefined;
 const stopped=new Promise<'Stop'>(resolve=>{wake=()=>{cancel.abort(shutdown.reason);resolve('Stop');};});shutdown.addEventListener('abort',wake,{once:true});if(shutdown.aborted)wake();
 const gap=(generation:bigint|null,skipped:bigint)=>{PortableResidentLifecycle.prototype.markIdleObservationGap.call(server,error=>notify({kind:'Error',error}));notify({kind:'Gap',generation,skipped});};
 let initial=true;
 try{while(!shutdown.aborted){
  let action:'Recover'|ResidentServerRequestEvent='Recover';
  if(initial)initial=false;
  else{
   if(pending===undefined){const value=Reflect.apply(receive as Function,receiver,[cancel.signal]);if(!types.isPromise(value))throw new TypeError('Receiver must return native Promise');pending=Promise.prototype.then.call(value,(value:ResidentServerRequestEvent)=>({kind:'Event',value} as Received),(error:unknown)=>({kind:'ReceiveError',error} as Received)) as Promise<Received>;}
   const timer=retryTimer(retries.deadline());let selected:'Stop'|'Retry'|Received;try{selected=await Promise.race([stopped,timer.promise,pending!]);}finally{timer.cancel();}
   if(shutdown.aborted||selected==='Stop')break;
   if(selected==='Retry')retries.beginRetry();
   else{
    pending=undefined;
    if(selected.kind==='ReceiveError'){if(selected.error instanceof BroadcastClosedError)break;if(selected.error instanceof BroadcastLaggedError)gap(null,selected.error.missed);else throw selected.error;}
    else{
     const kind=own(selected.value,'kind'),generation=own(selected.value,'generation') as bigint;requirePromptGeneration(generation);
     if(kind==='Gap'){const skipped=own(selected.value,'skipped');if(typeof skipped!=='bigint'||skipped<0n||skipped>=(1n<<64n))throw new TypeError('Invalid server request gap');gap(generation,skipped);}
     else if(kind==='Request')action={kind:'Request',generation,request:clonePendingServerRequest(own(selected.value,'request') as PendingServerRequest)};
     else throw new TypeError('Invalid resident server request event');
    }
   }
  }
  try{if(action==='Recover'){await owner.recover(cancel.signal);retries.clear();}else if(action.kind==='Request')await owner.process(action.generation,action.request,cancel.signal);}
  catch(error){if(shutdown.aborted&&error===cancel.signal.reason)break;notify({kind:'Error',error});retries.scheduleFailure(now());}
 }}finally{
  cancel.abort(new Error('Server request loop stopped'));shutdown.removeEventListener('abort',wake);
  try{invokeSynchronousVoid(dispose as (...args:unknown[])=>void,receiver,[]);}finally{try{if(pending)await pending;}finally{owner.dispose();}}
 }
}
