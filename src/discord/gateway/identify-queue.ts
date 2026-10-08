import {setImmediate as yieldToRuntime} from 'node:timers/promises';
import {nativeGatewayShutdownClock,type GatewayShutdownClock} from './shutdown.ts';
const DELAY_MS=5000,PERIOD_MS=86400000;
export class GatewayIdentifyQueueClosed extends Error{constructor(){super('Gateway identify queue closed');this.name='GatewayIdentifyQueueClosed';}}
interface Request{settled:boolean;resolve:()=>void;reject:(error:unknown)=>void;detach:()=>void}
export interface GatewayIdentifyBudget{readonly remaining:number;readonly total:number;readonly resetAfterMs:number}
/** Shared single-bucket owner for the bridge's actual Config::new default queue.
 * Default: one successful permit per 5s, 1000 per daily period. Cancelled queued
 * receivers are skipped, but a visited bucket still advances its 5s interval.
 * Grant consumes quota even if the caller later discards it. Dynamic updates,
 * multi-bucket mode and disabled max_concurrency=0 are not implemented here.
 * Explicit close cancels/joins this owner's timer and rejects outstanding grants. */
export class SingleBucketGatewayIdentifyQueue{
 readonly #clock:GatewayShutdownClock;readonly #total:number;#remaining:number;#resetAt:number;#intervalAt:number;#lastNow=0;readonly #requests:Request[]=[];
 #wake:(()=>void)|undefined;#closed=false;#failed=false;#failure:unknown;readonly #worker:Promise<void>;#closing:Promise<void>|undefined;
 constructor(options:{clock?:GatewayShutdownClock;budget?:GatewayIdentifyBudget}={}){
  const source=options.clock??nativeGatewayShutdownClock;this.#clock=Object.freeze({now:source.now.bind(source),sleepUntil:source.sleepUntil.bind(source)});
  const budget=options.budget??{remaining:1000,total:1000,resetAfterMs:PERIOD_MS};if(!Number.isInteger(budget.total)||budget.total<1||budget.total>4294967295||!Number.isInteger(budget.remaining)||budget.remaining<0||budget.remaining>budget.total||!Number.isFinite(budget.resetAfterMs)||budget.resetAfterMs<0||budget.resetAfterMs>Number.MAX_SAFE_INTEGER-PERIOD_MS)throw new TypeError('Unsupported identify budget');
  this.#total=budget.total;this.#remaining=budget.remaining;const now=this.#now();this.#intervalAt=now;this.#resetAt=now+budget.resetAfterMs;if(!Number.isFinite(this.#resetAt)||this.#resetAt>Number.MAX_SAFE_INTEGER)throw new RangeError('Identify reset deadline out of range');
  this.#worker=this.#run().catch(error=>{this.#failed=true;this.#failure=error;this.#closed=true;this.#rejectAll(error);});
 }
 #now():number{const value=this.#clock.now();if(!Number.isFinite(value)||value<this.#lastNow||value>Number.MAX_SAFE_INTEGER-PERIOD_MS)throw new TypeError('Expected bounded monotonic identify clock');this.#lastNow=value;return value;}
 snapshot(){return Object.freeze({remaining:this.#remaining,total:this.#total,queued:this.#requests.filter(item=>!item.settled).length,queuedSlots:this.#requests.length,resetAtMs:this.#resetAt,nextBucketAtMs:this.#intervalAt,closed:this.#closed});}
 enqueue(shard:number,signal?:AbortSignal):Promise<void>{
  if(!Number.isInteger(shard)||shard<0||shard>4294967295)return Promise.reject(new TypeError('Expected u32 shard'));if(this.#closed)return Promise.reject(this.#failed?this.#failure:new GatewayIdentifyQueueClosed());if(signal?.aborted)return Promise.reject(signal.reason);
  const promise=new Promise<void>((resolve,reject)=>{const item:Request={settled:false,resolve,reject,detach:()=>signal?.removeEventListener('abort',abort)};const abort=()=>{if(item.settled)return;item.settled=true;item.detach();reject(signal?.reason);this.#wake?.();};signal?.addEventListener('abort',abort,{once:true});this.#requests.push(item);});this.#wake?.();return promise;
 }
 #rejectAll(error:unknown):void{for(const item of this.#requests.splice(0)){if(!item.settled){item.settled=true;item.detach();item.reject(error);}}}
 async #wait(deadline?:number):Promise<void>{
  let wake!:()=>void;const notified=new Promise<{kind:'Wake'}>(resolve=>{wake=()=>resolve({kind:'Wake'});this.#wake=wake;}),cancel=new AbortController();
  const timer=deadline===undefined?undefined:Promise.resolve().then(()=>this.#clock.sleepUntil(deadline,cancel.signal)).then(()=>({kind:'Time' as const}),error=>({kind:'Error' as const,error}));
  try{const result=await(timer===undefined?notified:Promise.race([notified,timer]));if(result.kind==='Error')throw result.error;}finally{if(this.#wake===wake)this.#wake=undefined;cancel.abort(new GatewayIdentifyQueueClosed());if(timer!==undefined)await timer;}
 }
 async #run():Promise<void>{
  try{while(!this.#closed){
   const now=this.#now();if(this.#remaining!==this.#total&&now>=this.#resetAt)this.#remaining=this.#total;
   if(this.#requests.length===0){await this.#wait(this.#remaining===this.#total?undefined:this.#resetAt);continue;}
   if(this.#remaining===0){await this.#wait(this.#resetAt);continue;}
   if(now<this.#intervalAt){await this.#wait(this.#remaining===this.#total?this.#intervalAt:Math.min(this.#intervalAt,this.#resetAt));continue;}
   this.#intervalAt=now+DELAY_MS;if(this.#remaining===this.#total)this.#resetAt=now+PERIOD_MS;
   while(this.#requests.length!==0){const item=this.#requests.shift()!;if(item.settled)continue;item.settled=true;item.detach();this.#remaining--;item.resolve();await yieldToRuntime();break;}
  }}catch(error){this.#failed=true;this.#failure=error;this.#closed=true;throw error;}finally{this.#rejectAll(this.#failed?this.#failure:new GatewayIdentifyQueueClosed());}
 }
 close():Promise<void>{if(this.#closing!==undefined)return this.#closing;this.#closed=true;this.#wake?.();this.#closing=(async()=>{await this.#worker;if(this.#failed)throw this.#failure;})();return this.#closing;}
}
