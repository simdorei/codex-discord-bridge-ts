import {performance} from 'node:perf_hooks';
import {Worker,isMainThread} from 'node:worker_threads';
import {registerStoreWorker,constructStoreWorker,releaseStoreWorker,type StoreWorkerRegistration} from './store-worker-authority.ts';
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
export type OwnedWorkerClass='Background'|'Control'|'Observation'|'Discovery'|'Maintenance';
/** Initial finite adapter budget, not a measured throughput recommendation.
 * A reserved control lane prevents stalled display/context readers from consuming
 * restart-readiness capacity. Observation has two separate reserved slots so its
 * continuous intake/reconciler cannot starve mirror discovery. Total native budget
 * is eight, not an unbounded pool. Maintenance has one shared periodic-read
 * slot and a bounded two-entry FIFO; it cannot consume ordinary mirror/UI readers. One separate Discovery slot prevents
 * coherent snapshots from consuming the three general runtime readers.
 * Ordinary reads refuse saturation; owned
 * completion writes have separate finite Control and Observation FIFOs.
 * All current production Worker construction is centralized through this module. */
export const OWNED_WORKER_LIMITS=Object.freeze({Background:3,Control:1,Observation:2,Discovery:1,Maintenance:1});
const occupied={Background:0,Control:0,Observation:0,Discovery:0,Maintenance:0};
export function ownedWorkerUsage():Readonly<{Background:number;Control:number;Observation:number;Discovery:number;Maintenance:number}>{return Object.freeze({...occupied});}
export class OwnedWorkerBudgetError extends OwnedWorkerBusyError{constructor(){super();this.name='OwnedWorkerBudgetError';this.message='Native worker class capacity is occupied; no additional worker submitted';}}
// Proof belongs to one actual rejected submission, not an error class. Consume
// once and bind to its owner/Promise so replayed or unrelated errors cannot claim
// that this operation was refused before a worker existed.
const admissionRefusals=new WeakMap<Promise<unknown>,{slot:OwnedWorkerSlot;error:unknown}>();
export function takeOwnedWorkerAdmissionRefusal(slot:OwnedWorkerSlot,pending:Promise<unknown>|undefined,error:unknown):boolean{
 if(pending===undefined)return false;const proof=admissionRefusals.get(pending);
 if(proof===undefined||proof.slot!==slot||proof.error!==error)return false;
 admissionRefusals.delete(pending);return true;
}
/** Only already-owned durable completions use this128 FIFO. Ordinary reads/begins keep zero queue; periodic Maintenance uses its separate2 FIFO. */
export const OWNED_COMPLETION_QUEUE_LIMIT=128;
/** Periodic read owners only: one active plus at most two queued globally. */
export const OWNED_MAINTENANCE_QUEUE_LIMIT=2;
type CompletionWaiter={grant(release:()=>void):void};
type CompletionClass='Control'|'Observation'|'Maintenance';
const completions:Record<CompletionClass,CompletionWaiter[]>={Control:[],Observation:[],Maintenance:[]};
function take(kind:OwnedWorkerClass):()=>void{occupied[kind]++;let released=false;return()=>{if(released)return;released=true;occupied[kind]--;if(kind==='Control'||kind==='Observation'||kind==='Maintenance')pump(kind);};}
function pump(kind:CompletionClass):void{const queue=completions[kind];while(occupied[kind]<OWNED_WORKER_LIMITS[kind]&&queue.length>0)queue.shift()!.grant(take(kind));}
function acquire(kind:OwnedWorkerClass):(()=>void)|null{if(!isMainThread)throw new TypeError('Native workers must be submitted by the main runtime owner');if(occupied[kind]>=OWNED_WORKER_LIMITS[kind]||((kind==='Control'||kind==='Observation'||kind==='Maintenance')&&completions[kind].length>0))return null;return take(kind);}
function waitCompletion(kind:CompletionClass,timeoutMs:number,signal?:AbortSignal):Promise<()=>void>{
 if(!isMainThread)throw new TypeError('Native workers must be submitted by the main runtime owner');signal?.throwIfAborted();const queue=completions[kind];
 if(queue.length>=(kind==='Maintenance'?OWNED_MAINTENANCE_QUEUE_LIMIT:OWNED_COMPLETION_QUEUE_LIMIT))return Promise.reject(new OwnedWorkerBudgetError());
 return new Promise((resolve,reject)=>{
  let settled=false;const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
  const entry:CompletionWaiter={grant:release=>{if(settled){release();return;}settled=true;cleanup();resolve(release);}};
  const refuse=(error:unknown)=>{if(settled)return;settled=true;const at=queue.indexOf(entry);if(at>=0)queue.splice(at,1);cleanup();reject(error);};
  const abort=()=>refuse(signal!.reason),timer=setTimeout(()=>refuse(new OwnedWorkerTimeoutError()),timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});queue.push(entry);if(signal?.aborted)abort();else pump(kind);
 });
}

/** One native worker owner. Timeout/abort settles the caller but does not release
 * the slot until native exit; late messages are never delivered to that caller. */
export class OwnedWorkerSlot {
 #worker:Worker|null=null;#idle:Promise<void>=Promise.resolve();#completion:Promise<unknown>|null=null;readonly #class:OwnedWorkerClass;
 constructor(kind:OwnedWorkerClass='Background'){if(kind!=='Background'&&kind!=='Control'&&kind!=='Observation'&&kind!=='Discovery'&&kind!=='Maintenance')throw new TypeError('Invalid native worker class');this.#class=kind;}
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
  if(this.#class!=='Control')throw new TypeError('Completion requires Control lane');return this.#queuedCompletion('Control',url,workerData,timeoutMs,signal);
 }
 /** Original gap persistence may wait in its own bounded FIFO; reads never queue. */
 runObservationCompletion(url:URL,workerData:unknown,timeoutMs:number,signal?:AbortSignal):Promise<unknown>{
  if(this.#class!=='Observation')throw new TypeError('Gap completion requires Observation lane');return this.#queuedCompletion('Observation',url,workerData,timeoutMs,signal);
 }
 /** Bounded periodic read FIFO, not effect admission. Wait consumes deadline;
  * cancellation removes an unstarted waiter; active native exit remains joined. */
 runMaintenanceRead(url:URL,workerData:unknown,timeoutMs:number,signal?:AbortSignal):Promise<unknown>{
  if(this.#class!=='Maintenance')throw new TypeError('Periodic read requires Maintenance lane');return this.#queuedCompletion('Maintenance',url,workerData,timeoutMs,signal);
 }
 #queuedCompletion(kind:CompletionClass,url:URL,workerData:unknown,timeoutMs:number,signal?:AbortSignal):Promise<unknown>{
  if(this.busy)return Promise.reject(new OwnedWorkerBusyError());
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647)throw new TypeError('Expected bounded completion deadline');signal?.throwIfAborted();
  const executable=ownedWorkerModuleUrl(url,import.meta.url),registration=registerStoreWorker(executable,workerData);
  const began=performance.now();const task=(async()=>{let release:(()=>void)|undefined,transferred=false;try{
   release=await waitCompletion(kind,timeoutMs,signal);signal?.throwIfAborted();const left=Math.ceil(timeoutMs-(performance.now()-began));if(left<=0)throw new OwnedWorkerTimeoutError();
   transferred=true;try{return await this.#run(executable,workerData,left,signal,false,release,registration);}finally{await this.#idle;}
  }finally{if(!transferred)releaseStoreWorker(registration,false);release?.();}})();
  this.#completion=task;const clear=()=>{if(this.#completion===task)this.#completion=null;};void task.then(clear,clear);return task;
 }
 #run(url:URL,workerData:unknown,timeoutMs:number,signal:AbortSignal|undefined,terminateCpu:boolean,completionRelease?:()=>void,prepared?:StoreWorkerRegistration):Promise<unknown>{
  let registration=prepared,releaseBudget:(()=>void)|null|undefined,worker:Worker;
  try{
   signal?.throwIfAborted();if(this.#worker!==null){if(registration!==undefined)releaseStoreWorker(registration,false);return Promise.reject(new OwnedWorkerBusyError());}
   if(!Number.isSafeInteger(timeoutMs)||timeoutMs<0||timeoutMs>2147483647)throw new TypeError('Expected bounded worker deadline');
   const executable=ownedWorkerModuleUrl(url,import.meta.url);registration??=registerStoreWorker(executable,workerData);
   releaseBudget=completionRelease??acquire(this.#class);if(releaseBudget===null){releaseStoreWorker(registration,false);const error=new OwnedWorkerBudgetError(),pending=Promise.reject(error);admissionRefusals.set(pending,{slot:this,error});return pending;}
   worker=constructStoreWorker(registration,()=>new Worker(executable,{workerData}));
  }catch(error){if(registration!==undefined)releaseStoreWorker(registration,false);releaseBudget?.();throw error;}
  const ownedRegistration=registration,ownedBudget=releaseBudget;this.#worker=worker;let release!:()=>void;this.#idle=new Promise<void>(r=>{release=r;});
  return new Promise((resolve,reject)=>{
   let settled=false,count=0,value:unknown,failure:unknown;const settle=(error:unknown,result?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error!==undefined)reject(error);else resolve(result);};
   let terminationRequested=false;
   const cancel=(reason:unknown)=>{if(settled)return;settle(reason);if(terminateCpu&&!terminationRequested){terminationRequested=true;void worker.terminate().catch(error=>{failure??=error;});}};
   const abort=()=>cancel(signal!.reason),timer=setTimeout(()=>cancel(new OwnedWorkerTimeoutError()),timeoutMs);signal?.addEventListener('abort',abort,{once:true});
   worker.on('message',message=>{count++;if(count===1)value=message;else failure=new Error('context worker emitted multiple results');});worker.on('error',error=>{failure=error;});
   worker.once('exit',code=>{this.#worker=null;releaseStoreWorker(ownedRegistration,true);ownedBudget();release();settle(failure??(code!==0?new Error(`context worker exited ${code}`):count!==1?new Error('context worker returned no result'):undefined),value);});
   if(signal?.aborted)abort();
  });
 }
}
