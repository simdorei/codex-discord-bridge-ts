import {performance} from 'node:perf_hooks';
import {Worker,isMainThread} from 'node:worker_threads';
export class OwnedWorkerBusyError extends Error {constructor(){super('context reader is still running; no extra reader started');this.name='OwnedWorkerBusyError';}}
export class OwnedWorkerTimeoutError extends Error {constructor(){super('context read timed out; snapshot unavailable, OS read may still be finishing');this.name='OwnedWorkerTimeoutError';}}
/** Resolve tsc's extension-rewritten graph without falling back to source TS.
 * Source execution keeps its original worker URL; emitted JS maps only local
 * .ts worker modules to their corresponding emitted .js file. */
export function ownedWorkerModuleUrl(input:URL,ownerModule:string):URL{
 const executable=new URL(input.href),owner=new URL(ownerModule);
 if(owner.protocol==='file:'&&owner.pathname.endsWith('.js')&&executable.protocol==='file:'&&executable.pathname.endsWith('.ts'))executable.pathname=executable.pathname.slice(0,-3)+'.js';
 return executable;
}
export type OwnedWorkerClass='Background'|'Control';
/** Initial finite adapter budget, not a measured throughput recommendation.
 * A reserved control lane prevents stalled display/context readers from consuming
 * restart-readiness capacity. No waiting queue; saturation is explicit refusal.
 * All current production Worker construction is centralized through this module. */
export const OWNED_WORKER_LIMITS=Object.freeze({Background:3,Control:1});
const occupied={Background:0,Control:0};
export function ownedWorkerUsage():Readonly<{Background:number;Control:number}>{return Object.freeze({...occupied});}
export class OwnedWorkerBudgetError extends OwnedWorkerBusyError{constructor(){super();this.name='OwnedWorkerBudgetError';this.message='Native worker class capacity is occupied; no additional worker submitted';}}
/** Only already-owned durable completions may wait. New reads/begins keep zero queue. */
export const OWNED_COMPLETION_QUEUE_LIMIT=128;
type CompletionWaiter={grant(release:()=>void):void};
const completions:CompletionWaiter[]=[];
function take(kind:OwnedWorkerClass):()=>void{occupied[kind]++;let released=false;return()=>{if(released)return;released=true;occupied[kind]--;if(kind==='Control')pump();};}
function pump():void{while(occupied.Control<OWNED_WORKER_LIMITS.Control&&completions.length>0)completions.shift()!.grant(take('Control'));}
function acquire(kind:OwnedWorkerClass):(()=>void)|null{if(!isMainThread)throw new TypeError('Native workers must be submitted by the main runtime owner');if(occupied[kind]>=OWNED_WORKER_LIMITS[kind]||(kind==='Control'&&completions.length>0))return null;return take(kind);}
function waitCompletion(timeoutMs:number,signal?:AbortSignal):Promise<()=>void>{
 if(!isMainThread)throw new TypeError('Native workers must be submitted by the main runtime owner');signal?.throwIfAborted();
 if(completions.length>=OWNED_COMPLETION_QUEUE_LIMIT)return Promise.reject(new OwnedWorkerBudgetError());
 return new Promise((resolve,reject)=>{
  let settled=false;const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
  const entry:CompletionWaiter={grant:release=>{if(settled){release();return;}settled=true;cleanup();resolve(release);}};
  const refuse=(error:unknown)=>{if(settled)return;settled=true;const at=completions.indexOf(entry);if(at>=0)completions.splice(at,1);cleanup();reject(error);};
  const abort=()=>refuse(signal!.reason),timer=setTimeout(()=>refuse(new OwnedWorkerTimeoutError()),timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});completions.push(entry);if(signal?.aborted)abort();else pump();
 });
}

/** One native worker owner. Timeout/abort settles the caller but does not release
 * the slot until native exit; late messages are never delivered to that caller. */
export class OwnedWorkerSlot {
 #worker:Worker|null=null;#idle:Promise<void>=Promise.resolve();#completion:Promise<unknown>|null=null;readonly #class:OwnedWorkerClass;
 constructor(kind:OwnedWorkerClass='Background'){if(kind!=='Background'&&kind!=='Control')throw new TypeError('Invalid native worker class');this.#class=kind;}
 get busy():boolean{return this.#worker!==null||this.#completion!==null;}
 join():Promise<void>{return this.#completion===null?this.#idle:this.#completion.then(()=>undefined,()=>undefined);}
 run(url:URL,workerData:unknown,timeoutMs:number,signal?:AbortSignal):Promise<unknown>{if(this.#completion!==null)return Promise.reject(new OwnedWorkerBusyError());return this.#run(url,workerData,timeoutMs,signal,false);}
 /** Only for trusted pure CPU modules with no external I/O or mutation. Caller
  * cancellation requests native termination; budget remains owned until exit.
  * Never use this method to make a blocked database/file operation look joined. */
 runCpu(url:URL,workerData:unknown,timeoutMs:number,signal?:AbortSignal):Promise<unknown>{if(this.#completion!==null)return Promise.reject(new OwnedWorkerBusyError());return this.#run(url,workerData,timeoutMs,signal,true);}
 /** Finite FIFO priority over new Control work, never retries a submitted worker.
  * Used only to settle a privately owned original receipt after observed outcome. */
 runControlCompletion(url:URL,workerData:unknown,timeoutMs:number,signal?:AbortSignal):Promise<unknown>{
  if(this.#class!=='Control')throw new TypeError('Completion requires Control lane');if(this.busy)return Promise.reject(new OwnedWorkerBusyError());
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647)throw new TypeError('Expected bounded completion deadline');signal?.throwIfAborted();
  const began=performance.now();const task=(async()=>{let release:(()=>void)|undefined;try{
   release=await waitCompletion(timeoutMs,signal);signal?.throwIfAborted();const left=Math.ceil(timeoutMs-(performance.now()-began));if(left<=0)throw new OwnedWorkerTimeoutError();
   try{return await this.#run(url,workerData,left,signal,false,release);}finally{await this.#idle;}
  }finally{release?.();}})();
  this.#completion=task;const clear=()=>{if(this.#completion===task)this.#completion=null;};void task.then(clear,clear);return task;
 }
 #run(url:URL,workerData:unknown,timeoutMs:number,signal:AbortSignal|undefined,terminateCpu:boolean,completionRelease?:()=>void):Promise<unknown>{
  signal?.throwIfAborted();if(this.#worker!==null)return Promise.reject(new OwnedWorkerBusyError());if(!Number.isSafeInteger(timeoutMs)||timeoutMs<0||timeoutMs>2147483647)throw new TypeError('Expected bounded worker deadline');
  const releaseBudget=completionRelease??acquire(this.#class);if(releaseBudget===null)return Promise.reject(new OwnedWorkerBudgetError());let worker:Worker;try{worker=new Worker(ownedWorkerModuleUrl(url,import.meta.url),{workerData});}catch(error){releaseBudget();throw error;}this.#worker=worker;let release!:()=>void;this.#idle=new Promise<void>(r=>{release=r;});
  return new Promise((resolve,reject)=>{
   let settled=false,count=0,value:unknown,failure:unknown;const settle=(error:unknown,result?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error!==undefined)reject(error);else resolve(result);};
   let terminationRequested=false;
   const cancel=(reason:unknown)=>{if(settled)return;settle(reason);if(terminateCpu&&!terminationRequested){terminationRequested=true;void worker.terminate().catch(error=>{failure??=error;});}};
   const abort=()=>cancel(signal!.reason),timer=setTimeout(()=>cancel(new OwnedWorkerTimeoutError()),timeoutMs);signal?.addEventListener('abort',abort,{once:true});
   worker.on('message',message=>{count++;if(count===1)value=message;else failure=new Error('context worker emitted multiple results');});worker.on('error',error=>{failure=error;});
   worker.once('exit',code=>{this.#worker=null;releaseBudget();release();settle(failure??(code!==0?new Error(`context worker exited ${code}`):count!==1?new Error('context worker returned no result'):undefined),value);});
   if(signal?.aborted)abort();
  });
 }
}
