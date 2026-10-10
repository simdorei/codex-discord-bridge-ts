import {historyChannelResource} from './history-request.ts';
import {mirrorChannelResource} from './mirror-channel-request.ts';
import {messageComponentClearResource} from './message-component-clear-request.ts';
import {isOriginalInteractionResponsePath, originalInteractionResponseResource} from './interaction-update-request.ts';
import {isInteractionCallbackPath} from './interaction-callback-request.ts';
import {isCommandRegistrationPath} from './commands.ts';
/** Source: twilight-http-ratelimiting 0.17.1 actor, narrowed to POST channel
 * messages/typing, GET gateway/bot and PUT application commands. Exact callback paths are global-exempt; predicates remain outside. */
export interface ChannelRateHeaders{readonly bucket:Uint8Array;readonly limit:number;readonly remaining:number;readonly resetAtMs:number}
export interface ChannelRatePermit{complete(headers:ChannelRateHeaders|null):void;release():void}
export interface RateClock{now():number;schedule(atMs:number,callback:()=>void):()=>void}
const nativeClock:RateClock={now:()=>performance.now(),schedule(at,callback){const timer=setTimeout(callback,Math.min(2147483647,Math.max(0,at-performance.now())));return()=>clearTimeout(timer);}};
interface Pending{readonly path:string;readonly resource:string;readonly exempt:boolean;readonly signal:AbortSignal;resolve(permit:ChannelRatePermit):void;reject(error:unknown):void;abort():void;pending:boolean}
interface Queue{inFlight:boolean;pending:Pending[];limit:number;remaining:number;resetAt:number|null}
const empty=():Queue=>({inFlight:false,pending:[],limit:0,remaining:0,resetAt:null});
const GC_MS=6*60*60*1000;
function identity(path:string):string{const history=historyChannelResource(path);if(history!==null)return history;const mirror=mirrorChannelResource(path);if(mirror!==null)return mirror;const clear=messageComponentClearResource(path);if(clear!==null)return clear;const webhook=originalInteractionResponseResource(path);if(webhook!==null)return webhook;if(path==='gateway/bot'||isCommandRegistrationPath(path)||isInteractionCallbackPath(path))return 'none';if(typeof path!=='string')throw new TypeError('Expected channel endpoint');const match=/^channels\/([1-9][0-9]{0,19})\/(messages|typing)$/u.exec(path);if(match===null||match[0]!==path||BigInt(match[1]!)>=(1n<<64n))throw new TypeError('Expected canonical channel message/typing endpoint');return 'channels/'+match[1];}
function headers(value:ChannelRateHeaders):{bucket:string;limit:number;remaining:number;resetAtMs:number}{
 if(!(value.bucket instanceof Uint8Array)||!Number.isInteger(value.limit)||value.limit<0||value.limit>65535||!Number.isInteger(value.remaining)||value.remaining<0||value.remaining>65535||!Number.isFinite(value.resetAtMs)||value.resetAtMs<0)throw new TypeError('Invalid parsed rate headers');return {bucket:Buffer.from(value.bucket).toString('hex'),limit:value.limit,remaining:value.remaining,resetAtMs:value.resetAtMs};
}
/** One owner with source queue eligibility and a global one-second window.
 * Fresh exempt requests may start past global-blocked pending requests when the
 * queue is otherwise idle; already-queued requests retain source FIFO eligibility.
 * Completion releases a permit immediately at headers; release() without headers is
 * cancellation and preserves the source unconditional refund up to the global cap,
 * including an exempt request when the window was partly spent. Queued cancellation
 * never consumes a slot; source FIFO tombstones remain until eligible popping.
 * Parsed-header input uses monotonic milliseconds, not Rust Instant nanosecond parity. */
export class DiscordChannelRateState{
 readonly #clock:RateClock;readonly #limit:number;#remaining:number;#globalAt:number|null=null;#gcAt:number;#timer:(()=>void)|null=null;readonly #buckets=new Map<string,string>();readonly #queues=new Map<string,Queue>();readonly #active=new Set<Pending>();#closed=false;#reason:unknown;#closing:Promise<void>|null=null;#closedResolve:(()=>void)|null=null;
 constructor(globalLimit=50,clock:RateClock=nativeClock){if(!Number.isInteger(globalLimit)||globalLimit<1||globalLimit>65535)throw new RangeError('Expected positive u16 global limit');this.#limit=globalLimit;this.#remaining=globalLimit;this.#clock=clock;this.#gcAt=this.#now()+GC_MS;}
 #now():number{const v=this.#clock.now();if(!Number.isFinite(v)||v<0)throw new TypeError('Expected monotonic rate clock');return v;}
 #key(resource:string,bucket?:string):string{return JSON.stringify([resource,bucket??null]);}
 #queue(path:string,resource:string):Queue{const key=this.#key(resource,this.#buckets.get(path));let q=this.#queues.get(key);if(q===undefined){q=empty();this.#queues.set(key,q);}return q;}
 get activeCount():number{return this.#active.size;}
 get pendingCount():number{return [...this.#queues.values()].reduce((n,q)=>n+q.pending.filter(req=>req.pending).length,0);}
 get globalRemaining():number{return this.#remaining;}
 acquire(path:string,signal:AbortSignal):Promise<ChannelRatePermit>{
  const resource=identity(path);if(this.#closed)return Promise.reject(this.#reason);if(signal.aborted)return Promise.reject(signal.reason);this.#expire();
  return new Promise((resolve,reject)=>{const req:Pending={path,resource,exempt:isInteractionCallbackPath(path)||isOriginalInteractionResponsePath(path),signal,resolve,reject,pending:true,abort:()=>{if(!req.pending)return;req.pending=false;// Retain cancelled tombstone until source FIFO eligibility can pop it.
   signal.removeEventListener('abort',req.abort);reject(signal.reason);this.#arm();}};
   signal.addEventListener('abort',req.abort,{once:true});const q=this.#queue(path,resource);if(!q.inFlight&&(q.remaining!==0||q.resetAt===null)&&(this.#remaining!==0||req.exempt))this.#grant(q,req);else q.pending.push(req);this.#arm();
  });
 }
 #grant(q:Queue,req:Pending):void{
  if(!req.pending)return;if(req.signal.aborted){req.abort();return;}req.pending=false;req.signal.removeEventListener('abort',req.abort);q.inFlight=true;this.#active.add(req);
  if(!req.exempt){if(this.#remaining===this.#limit)this.#globalAt=this.#now()+1000;this.#remaining--;}
  let done=false;req.resolve(Object.freeze({complete:(value:ChannelRateHeaders|null)=>{if(done)throw new TypeError('Rate permit already completed');const h=value===null?null:headers(value);done=true;this.#finish(req,h,false);},release:()=>{if(done)return;done=true;this.#finish(req,null,true);}}));
 }
 #pop(q:Queue):void{
  if(this.#closed||q.inFlight)return;for(;;){const front=q.pending[0];if(front===undefined||(this.#remaining===0&&!front.exempt))return;const req=q.pending.shift()!;if(!req.pending)continue;if(req.signal.aborted){req.abort();continue;}this.#grant(q,req);return;}
 }
 #finish(req:Pending,h:ReturnType<typeof headers>|null,cancelled:boolean):void{
  if(!this.#active.delete(req))throw new TypeError('Unknown rate permit');
  if(h===null){if(cancelled&&this.#remaining!==this.#limit)this.#remaining++;const q=this.#queue(req.path,req.resource);q.inFlight=false;this.#pop(q);}
  else{
   const old=this.#buckets.get(req.path),oldKey=this.#key(req.resource,old),nextKey=this.#key(req.resource,h.bucket);let q:Queue;
   if(old===h.bucket)q=this.#queues.get(nextKey)!;
   else{const previous=this.#queues.get(oldKey)!;previous.inFlight=false;const moving=previous.pending.filter(p=>p.pending&&p.path===req.path);previous.pending=previous.pending.filter(p=>p.pending&&p.path!==req.path);this.#pop(previous);this.#buckets.set(req.path,h.bucket);
    q=this.#queues.get(nextKey)??empty();if(!this.#queues.has(nextKey))this.#queues.set(nextKey,q);q.pending.push(...moving);
    if(q.inFlight){this.#arm();this.#maybeClosed();return;}
   }
   q.inFlight=false;q.limit=h.limit;q.remaining=h.remaining;q.resetAt=h.resetAtMs;if(q.remaining!==0)this.#pop(q);
  }
  this.#expire();this.#arm();this.#maybeClosed();
 }
 #expire():void{
  if(this.#closed)return;const now=this.#now();
  if(now>=this.#gcAt){for(const [path,bucket]of this.#buckets){const resource=identity(path),key=this.#key(resource,bucket),q=this.#queues.get(key);if(q===undefined||(!q.inFlight&&q.pending.length===0&&q.resetAt===null)){this.#queues.delete(key);this.#buckets.delete(path);}}this.#gcAt=now+GC_MS;}
  if(this.#globalAt!==null&&now>=this.#globalAt&&this.#remaining!==this.#limit){this.#remaining=this.#limit;for(const q of this.#queues.values())if(!q.inFlight&&(q.remaining!==0||q.resetAt===null))this.#pop(q);}
  for(const q of this.#queues.values())if(q.resetAt!==null&&q.resetAt<=now){q.resetAt=null;if(q.remaining===0)this.#pop(q);}
 }
 #arm():void{
  this.#timer?.();this.#timer=null;if(this.#closed)return;let at=this.#gcAt;if(this.#globalAt!==null&&this.#remaining!==this.#limit)at=Math.min(at,this.#globalAt);for(const q of this.#queues.values())if(q.resetAt!==null)at=Math.min(at,q.resetAt);
  this.#timer=this.#clock.schedule(at,()=>{this.#timer=null;this.#expire();this.#arm();});
 }
 #maybeClosed():void{if(this.#closed&&this.#active.size===0){this.#queues.clear();this.#buckets.clear();this.#closedResolve?.();this.#closedResolve=null;}}
 close(reason:unknown=new Error('Channel rate manager stopped')):Promise<void>{
  if(this.#closing!==null)return this.#closing;this.#closed=true;this.#reason=reason;this.#timer?.();this.#timer=null;
  for(const q of this.#queues.values()){for(const req of q.pending){if(req.pending){req.pending=false;req.signal.removeEventListener('abort',req.abort);req.reject(reason);}}q.pending=[];}
  this.#closing=new Promise(resolve=>{this.#closedResolve=resolve;});this.#maybeClosed();return this.#closing;
 }
}
