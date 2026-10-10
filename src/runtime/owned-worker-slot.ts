import {Worker,isMainThread} from 'node:worker_threads';
export class OwnedWorkerBusyError extends Error {constructor(){super('context reader is still running; no extra reader started');this.name='OwnedWorkerBusyError';}}
export class OwnedWorkerTimeoutError extends Error {constructor(){super('context read timed out; snapshot unavailable, OS read may still be finishing');this.name='OwnedWorkerTimeoutError';}}
export type OwnedWorkerClass='Background'|'Control';
/** Initial finite adapter budget, not a measured throughput recommendation.
 * A reserved control lane prevents stalled display/context readers from consuming
 * restart-readiness capacity. No waiting queue; saturation is explicit refusal.
 * All current production Worker construction is centralized through this module. */
export const OWNED_WORKER_LIMITS=Object.freeze({Background:3,Control:1});
const occupied={Background:0,Control:0};
export function ownedWorkerUsage():Readonly<{Background:number;Control:number}>{return Object.freeze({...occupied});}
export class OwnedWorkerBudgetError extends OwnedWorkerBusyError{constructor(){super();this.name='OwnedWorkerBudgetError';this.message='Native worker class capacity is occupied; no additional worker submitted';}}
function acquire(kind:OwnedWorkerClass):(()=>void)|null{if(!isMainThread)throw new TypeError('Native workers must be submitted by the main runtime owner');if(occupied[kind]>=OWNED_WORKER_LIMITS[kind])return null;occupied[kind]++;let released=false;return()=>{if(!released){released=true;occupied[kind]--;}};}
/** One native worker owner. Timeout/abort settles the caller but does not release
 * the slot until native exit; late messages are never delivered to that caller. */
export class OwnedWorkerSlot {
 #worker:Worker|null=null;#idle:Promise<void>=Promise.resolve();readonly #class:OwnedWorkerClass;
 constructor(kind:OwnedWorkerClass='Background'){if(kind!=='Background'&&kind!=='Control')throw new TypeError('Invalid native worker class');this.#class=kind;}
 get busy():boolean{return this.#worker!==null;}
 join():Promise<void>{return this.#idle;}
 run(url:URL,workerData:unknown,timeoutMs:number,signal?:AbortSignal):Promise<unknown>{
  signal?.throwIfAborted();if(this.#worker!==null)return Promise.reject(new OwnedWorkerBusyError());if(!Number.isSafeInteger(timeoutMs)||timeoutMs<0||timeoutMs>2147483647)throw new TypeError('Expected bounded worker deadline');
  const releaseBudget=acquire(this.#class);if(releaseBudget===null)return Promise.reject(new OwnedWorkerBudgetError());let worker:Worker;try{worker=new Worker(new URL(url.href),{workerData});}catch(error){releaseBudget();throw error;}this.#worker=worker;let release!:()=>void;this.#idle=new Promise<void>(r=>{release=r;});
  return new Promise((resolve,reject)=>{
   let settled=false,count=0,value:unknown,failure:unknown;const settle=(error:unknown,result?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error!==undefined)reject(error);else resolve(result);};
   const abort=()=>settle(signal!.reason),timer=setTimeout(()=>settle(new OwnedWorkerTimeoutError()),timeoutMs);signal?.addEventListener('abort',abort,{once:true});
   worker.on('message',message=>{count++;if(count===1)value=message;else failure=new Error('context worker emitted multiple results');});worker.on('error',error=>{failure=error;});
   worker.once('exit',code=>{this.#worker=null;releaseBudget();release();settle(failure??(code!==0?new Error(`context worker exited ${code}`):count!==1?new Error('context worker returned no result'):undefined),value);});
   if(signal?.aborted)abort();
  });
 }
}
