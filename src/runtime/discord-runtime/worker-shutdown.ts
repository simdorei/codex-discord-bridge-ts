import {types} from 'node:util';
import {writeSync} from 'node:fs';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {nativeGatewayShutdownClock,type GatewayShutdownClock} from '../../discord/gateway/shutdown.ts';
import {RuntimeMonitoredWorker,isRuntimeMonitoredWorker,type RuntimeWorkerJoin,type RuntimeWorkerResult} from './monitored-worker.ts';
export class RuntimeWorkerTaskError extends Error{readonly worker:string;readonly taskError:unknown;constructor(worker:string,error:unknown){super(`runtime worker ${worker} task failed`,{cause:error});this.name='RuntimeWorkerTaskError';this.worker=worker;this.taskError=error;}}
export class RuntimeWorkerTimeoutError extends Error{readonly workers:string;constructor(workers:string){super(`runtime worker shutdown exceeded its common deadline: ${workers}`);this.name='RuntimeWorkerTimeoutError';this.workers=workers;}}
export interface RuntimeWorkerShutdownReport{readonly trigger:RuntimeWorkerResult|null;readonly cleanup:RuntimeWorkerResult}
export interface RuntimeWorkerShutdownOptions{readonly clock?:GatewayShutdownClock;readonly fatal?:(worker:string)=>never;readonly report:(kind:'primary'|'secondary'|'timeout'|'fatal',worker:string,error:unknown)=>void}
export class RuntimeWorkerReportingError extends Error{readonly report:RuntimeWorkerShutdownReport;readonly reportingError:unknown;constructor(report:RuntimeWorkerShutdownReport,error:unknown){super('Runtime worker diagnostic failed after cleanup');this.name='RuntimeWorkerReportingError';this.report=report;this.reportingError=error;}}
function abortProcess(worker:string):never{try{writeSync(2,`fatal_runtime_worker_abort_join_timeout worker=${worker}\nfatal_runtime_shutdown_timeout component=runtime-worker\n`);}finally{process.abort();}}
const okay=():RuntimeWorkerResult=>Object.freeze({ok:true});
const failure=(error:unknown):RuntimeWorkerResult=>Object.freeze({ok:false,error});
function normalize(worker:RuntimeMonitoredWorker,result:RuntimeWorkerJoin,forced:boolean):RuntimeWorkerResult{if(result.kind==='Returned')return result.result;if(forced&&result.cancelled)return okay();return failure(new RuntimeWorkerTaskError(worker.name,result.error));}
function now(clock:GatewayShutdownClock):number{const n=clock.now();if(!Number.isFinite(n)||n<0)throw new TypeError('Expected monotonic runtime clock');return n;}
function die(fatal:(worker:string)=>never,worker:string):never{const value:unknown=fatal(worker);if(types.isPromise(value))void Promise.prototype.then.call(value,undefined,()=>undefined);throw new Error('Fatal runtime worker policy returned');}
async function wait(worker:RuntimeMonitoredWorker,deadline:number,clock:GatewayShutdownClock,fatal:(name:string)=>never):Promise<RuntimeWorkerJoin|null>{
 const result=worker.peek();if(result!==undefined)return result;const abort=new AbortController();
 const task=worker.join().then(result=>({kind:'task' as const,result}));const timer=Promise.resolve().then(()=>clock.sleepUntil(deadline,abort.signal)).then(()=>({kind:'timer' as const}),error=>({kind:'clock' as const,error}));
 const selected=await Promise.race([task,timer]);abort.abort(new Error('Worker timer no longer needed'));await timer;if(selected.kind==='clock')return die(fatal,worker.name);return selected.kind==='task'?selected.result:null;
}
/** Consumes exact task owners after validation. Source ordered grace/abort/join
 * semantics with its outer runtime deadline included for the trigger as well.
 * All remaining tasks receive abort before any forced join. A timed-out real
 * Promise is never reported disposed. Responsive/cooperative Node callbacks are
 * required; the default last-resort policy aborts the process. Explicit invocation
 * replaces WorkerSet Drop. No network/OS worker is created by this module. */
export async function joinRuntimeWorkersForCause(input:RuntimeMonitoredWorker[],deadline:number,trigger:string|null,options:RuntimeWorkerShutdownOptions):Promise<RuntimeWorkerShutdownReport>{
 if(!Number.isFinite(deadline)||deadline<0||trigger!==null&&typeof trigger!=='string')throw new TypeError('Invalid worker shutdown scope');if(!Array.isArray(input)||types.isProxy(input))throw new TypeError('Expected worker vector');const seen=new Set<object>();for(let i=0;i<input.length;i++){const d=Object.getOwnPropertyDescriptor(input,String(i));if(d===undefined||!Object.hasOwn(d,'value')||!isRuntimeMonitoredWorker(d.value)||seen.has(d.value))throw new TypeError('Expected unique exact worker owners');seen.add(d.value);}
 const clock=options.clock??nativeGatewayShutdownClock,fatal=options.fatal??abortProcess,report=options.report;for(const f of [fatal,report])if(typeof f!=='function'||types.isProxy(f)||types.isAsyncFunction(f)||types.isGeneratorFunction(f))throw new TypeError('Expected synchronous worker policy');now(clock);
 const pending=Array.prototype.splice.call(input,0,input.length) as RuntimeMonitoredWorker[];let primary:RuntimeWorkerResult|null=null,reportFailed=false,reportError:unknown;
 const diagnostic=(kind:'primary'|'secondary'|'timeout'|'fatal',name:string,error:unknown)=>{try{invokeSynchronousVoid(report,options,[kind,name,error]);}catch(e){if(!reportFailed){reportFailed=true;reportError=e;}}};
 if(trigger!==null){const index=pending.findIndex(worker=>worker.name===trigger);if(index>=0){const worker=pending.splice(index,1)[0]!,joined=await wait(worker,deadline,clock,fatal);if(joined===null){diagnostic('fatal',worker.name,undefined);return die(fatal,worker.name);}primary=normalize(worker,joined,false);if(!primary.ok)diagnostic('primary',worker.name,primary.error);}}
 let current:number;try{current=now(clock);}catch{return die(fatal,'runtime-clock');}const drainDeadline=Math.max(current,deadline-1000);let first:RuntimeWorkerResult=okay();
 const record=(worker:RuntimeMonitoredWorker,joined:RuntimeWorkerJoin,forced:boolean)=>{const result=normalize(worker,joined,forced);if(!result.ok){if(first.ok)first=result;else diagnostic('secondary',worker.name,result.error);}};
 while(pending.length){const worker=pending.shift()!,joined=await wait(worker,drainDeadline,clock,fatal);if(joined===null){pending.unshift(worker);break;}record(worker,joined,false);}
 if(pending.length){const names=pending.map(worker=>worker.name).join(',');for(const worker of pending)worker.abort();while(pending.length){const worker=pending.shift()!,joined=await wait(worker,deadline,clock,fatal);if(joined===null){diagnostic('fatal',worker.name,undefined);return die(fatal,worker.name);}record(worker,joined,true);}if(first.ok)first=failure(new RuntimeWorkerTimeoutError(names));else diagnostic('timeout',names,undefined);}
 const result=Object.freeze({trigger:primary,cleanup:first});if(reportFailed)throw new RuntimeWorkerReportingError(result,reportError);return result;
}
