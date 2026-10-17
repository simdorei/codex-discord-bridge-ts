import {types} from 'node:util';
import {writeSync} from 'node:fs';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
export const GATEWAY_SHUTDOWN_TIMEOUT_MS=10000;
const ABORT_JOIN_RESERVE_MS=1000;
export type GatewayTaskResult={readonly ok:true}|{readonly ok:false;readonly error:unknown;readonly cancelled:boolean};
const tasks=new WeakSet<object>();
/** Owns one actual task Promise and its private cancellation identity. A rejected
 * Promise never becomes unhandled while waiting for the runtime's join phase. */
export class GatewayTask{
 readonly shard:number;readonly #controller=new AbortController();readonly #cancelReason=Object.freeze(new Error('Gateway task cancelled'));readonly #promise:Promise<GatewayTaskResult>;#result:GatewayTaskResult|undefined;
 constructor(shard:number,start:(signal:AbortSignal)=>Promise<void>){
  if(new.target!==GatewayTask)throw new TypeError('Expected exact GatewayTask owner');
  if(!Number.isInteger(shard)||shard<0||shard>4294967295)throw new TypeError('Expected u32 gateway shard');if(typeof start!=='function'||types.isProxy(start)||types.isGeneratorFunction(start))throw new TypeError('Expected owned gateway task start');this.shard=shard;
  let pending:Promise<void>;try{pending=start(this.#controller.signal);if(!types.isPromise(pending))throw new TypeError('Gateway task must return a Promise');}catch(error){pending=Promise.reject(error);}
  this.#promise=Promise.prototype.then.call(pending,()=>{const result=Object.freeze({ok:true as const});this.#result=result;return result;},(error:unknown)=>{const result=Object.freeze({ok:false as const,error,cancelled:this.#controller.signal.aborted&&error===this.#cancelReason});this.#result=result;return result;}) as Promise<GatewayTaskResult>;
  Object.freeze(this.#promise);tasks.add(this);Object.freeze(this);
 }
 abort():void{this.#controller.abort(this.#cancelReason);}
 join():Promise<GatewayTaskResult>{return this.#promise;}
 peek():GatewayTaskResult|undefined{return this.#result;}
}
Object.freeze(GatewayTask.prototype);
export class GatewayShutdownError extends Error{readonly kind:'Timeout'|'Join';readonly taskError:unknown;constructor(kind:'Timeout'|'Join',taskError?:unknown){super(kind==='Timeout'?'Discord gateway shard task did not stop before the shutdown deadline':'Discord gateway shard task failed');this.name='GatewayShutdownError';this.kind=kind;this.taskError=taskError;}}
export type GatewayJoinOutcome={readonly ok:true}|{readonly ok:false;readonly error:GatewayShutdownError};
export interface GatewayShutdownReport{readonly trigger:GatewayJoinOutcome|null;readonly cleanup:GatewayJoinOutcome}
export class GatewayShutdownReportingError extends Error{readonly report:GatewayShutdownReport;readonly reportingError:unknown;constructor(report:GatewayShutdownReport,error:unknown){super('Gateway shutdown diagnostic failed after task cleanup');this.name='GatewayShutdownReportingError';this.report=report;this.reportingError=error;}}
/** Trusted monotonic clock. sleepUntil must cancel/join its timer when aborted. */
export interface GatewayShutdownClock{now():number;sleepUntil(deadlineMs:number,signal:AbortSignal):Promise<void>}
export const nativeGatewayShutdownClock:GatewayShutdownClock=Object.freeze({now:()=>performance.now(),sleepUntil:(deadlineMs:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{
 let timer:ReturnType<typeof setTimeout>|undefined;const clean=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};const abort=()=>{clean();reject(signal.reason);};
 const check=()=>{if(signal.aborted){abort();return;}const remaining=deadlineMs-performance.now();if(remaining<=0){clean();resolve();}else timer=setTimeout(check,Math.min(2147483647,Math.ceil(remaining)));};signal.addEventListener('abort',abort,{once:true});check();
})});
/** Production fail-stop, not a recoverable timeout return. Tests inject their own
 * nonreturning sentinel; this default is never executed by the ordinary unit suite. */
function abortProcess():never{try{writeSync(2,'fatal_gateway_abort_join_timeout\n');}finally{process.abort();}}
export interface GatewayShutdownOptions{readonly clock?:GatewayShutdownClock;readonly fatal?:()=>never;readonly reportTriggerFailure:(shard:number,error:GatewayShutdownError)=>void}
const okay=():GatewayJoinOutcome=>Object.freeze({ok:true});
const joinError=(error:unknown):GatewayJoinOutcome=>Object.freeze({ok:false,error:new GatewayShutdownError('Join',error)});
function now(clock:GatewayShutdownClock):number{const value=clock.now();if(!Number.isFinite(value)||value<0)throw new TypeError('Expected monotonic shutdown time');return value;}
function die(fatal:()=>never):never{const result:unknown=Reflect.apply(fatal,undefined,[]);if(types.isPromise(result))void Promise.prototype.then.call(result,undefined,()=>undefined);throw new Error('Fatal Gateway shutdown policy returned');}
async function waitTask(task:GatewayTask,deadline:number,clock:GatewayShutdownClock,fatal:()=>never):Promise<{kind:'Done';result:GatewayTaskResult}|{kind:'Timeout'}>{
 const ready=task.peek();if(ready!==undefined)return {kind:'Done',result:ready};
 const cancel=new AbortController(),finished=task.join().then(result=>({kind:'Done' as const,result}));
 const timer=Promise.resolve().then(()=>clock.sleepUntil(deadline,cancel.signal)).then(()=>({kind:'Timeout' as const}),error=>({kind:'ClockFailure' as const,error}));
 const selected=await Promise.race([finished,timer]);cancel.abort(new Error('Gateway join timer no longer needed'));await timer;
 if(selected.kind==='ClockFailure')return die(fatal);return selected;
}
/** Consumes the caller's task vector. Trigger is joined first against the full
 * deadline; remaining tasks drain in order until deadline-1s, then all remaining
 * tasks are aborted before any forced join. Force-cancel errors alone are ignored,
 * but reaching forced cleanup still returns Timeout unless a real join error wins.
 * Timers require a responsive Node event loop: this is not a wall-time guarantee
 * against synchronous blocking. No Promise.race loser is declared cancelled. */
export async function joinGatewayTasksForCause(input:GatewayTask[],deadlineMs:number,trigger:number|null,options:GatewayShutdownOptions):Promise<GatewayShutdownReport>{
 if(!Number.isFinite(deadlineMs)||deadlineMs<0||trigger!==null&&(!Number.isInteger(trigger)||trigger<0||trigger>4294967295))throw new TypeError('Invalid gateway shutdown scope');
 if(!Array.isArray(input)||types.isProxy(input))throw new TypeError('Expected owned task vector');const unique=new Set<GatewayTask>();for(let i=0;i<input.length;i++){const d=Object.getOwnPropertyDescriptor(input,String(i));if(d===undefined||!Object.hasOwn(d,'value')||!tasks.has(d.value)||unique.has(d.value))throw new TypeError('Expected unique owned gateway tasks');unique.add(d.value);}
 const clock=options.clock??nativeGatewayShutdownClock,fatal=options.fatal??abortProcess;if(typeof fatal!=='function'||types.isProxy(fatal)||types.isAsyncFunction(fatal)||types.isGeneratorFunction(fatal))throw new TypeError('Expected synchronous nonreturning fatal policy');now(clock);const pending=input.splice(0);let primary:GatewayJoinOutcome|null=null,reportFailed=false,reportFailure:unknown;
 if(trigger!==null){const index=pending.findIndex(task=>task.shard===trigger);if(index>=0){const task=pending.splice(index,1)[0]!,joined=await waitTask(task,deadlineMs,clock,fatal);if(joined.kind==='Timeout')return die(fatal);primary=joined.result.ok?okay():joinError(joined.result.error);if(!primary.ok){try{invokeSynchronousVoid(options.reportTriggerFailure,options,[task.shard,primary.error]);}catch(error){reportFailed=true;reportFailure=error;}}}}
 // performance.now has a process-relative origin; a negative intermediate offset
 // must clamp to now, not spend the one-second abort/join reserve as grace.
 const drainDeadline=Math.max(now(clock),deadlineMs-ABORT_JOIN_RESERVE_MS);let firstError:unknown,hasError=false;
 const record=(result:GatewayTaskResult,forced:boolean)=>{if(!result.ok&&!(forced&&result.cancelled)&&!hasError){hasError=true;firstError=result.error;}};
 while(pending.length!==0){const task=pending.shift()!,joined=await waitTask(task,drainDeadline,clock,fatal);if(joined.kind==='Timeout'){pending.unshift(task);break;}record(joined.result,false);}
 let cleanup:GatewayJoinOutcome;
 if(pending.length===0)cleanup=hasError?joinError(firstError):okay();
 else{
  for(const task of pending)task.abort();
  while(pending.length!==0){const joined=await waitTask(pending.shift()!,deadlineMs,clock,fatal);if(joined.kind==='Timeout')return die(fatal);record(joined.result,true);}
  cleanup=hasError?joinError(firstError):Object.freeze({ok:false,error:new GatewayShutdownError('Timeout')});
 }
 const report=Object.freeze({trigger:primary,cleanup});if(reportFailed)throw new GatewayShutdownReportingError(report,reportFailure);return report;
}
