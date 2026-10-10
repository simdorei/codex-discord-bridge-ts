import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {MAX_MIRROR_THREAD_BYTES,type MirrorTargetHint} from './ready.ts';
export interface MirrorPollCounts{readonly targets:bigint;readonly events:bigint;readonly sent:bigint;}
export type MirrorTargetOutcome={readonly kind:'Completed';readonly progress:MirrorPollCounts}|{readonly kind:'Failed';readonly error:unknown}|{readonly kind:'TimedOut';readonly error:unknown}|{readonly kind:'Cancelled';readonly reason:unknown};
export interface MirrorTargetFinished{readonly target:MirrorTargetHint;readonly outcome:MirrorTargetOutcome;}
interface Task{readonly target:MirrorTargetHint;readonly abort:AbortController;promise:Promise<void>;result:MirrorTargetFinished|null;cancel:(reason:unknown)=>void;}
function counts(value:unknown):MirrorPollCounts{const targets=own(value,'targets'),events=own(value,'events'),sent=own(value,'sent');for(const n of [targets,events,sent])if(typeof n!=='bigint'||n<0n||n>(1n<<64n)-1n)throw new TypeError('Expected u64 mirror poll counts');return Object.freeze({targets:targets as bigint,events:events as bigint,sent:sent as bigint});}
/** Eight actual target operations, one per thread and destination channel. A
 * deadline requests cancellation but NEVER releases the native/HTTP work slot.
 * Completed records retain capacity until harvested, bounding result backlog too.
 * Trusted poll adapters must settle only after their child work and cleanup join,
 * and check cancellation before durable handoff/cursor mutation. This owner alone
 * cannot revoke an external side effect or prove unknown delivery was absent. */
export class MirrorTargetExecution{
 #waiter:{resolve:(value:boolean)=>void;reject:(error:unknown)=>void;cleanup:()=>void}|null=null;
 readonly #tasks=new Set<Task>();readonly #threads=new Set<string>();readonly #channels=new Set<bigint>();readonly #deadline:number;#closed=false;#closing:Promise<readonly MirrorTargetFinished[]>|null=null;
 constructor(deadlineMs=10000){if(!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>10000)throw new RangeError('Expected bounded mirror target deadline');this.#deadline=deadlineMs;}
 get size():number{return this.#tasks.size;}
 activeThreads():ReadonlySet<string>{return new Set(this.#threads);}
 activeChannels():ReadonlySet<bigint>{return new Set(this.#channels);}
 tryStart(input:MirrorTargetHint,poll:(target:MirrorTargetHint,signal:AbortSignal)=>Promise<MirrorPollCounts>,signal?:AbortSignal):boolean{
  if(this.#closed)throw new TypeError('Mirror execution closed');signal?.throwIfAborted();const thread=own(input,'thread'),channel=own(input,'channel');requireDiscordText(thread);if(Buffer.byteLength(thread,'utf8')>MAX_MIRROR_THREAD_BYTES||typeof channel!=='bigint'||channel<-(1n<<63n)||channel>(1n<<63n)-1n)throw new TypeError('Invalid mirror target');if(typeof poll!=='function'||types.isProxy(poll)||types.isGeneratorFunction(poll))throw new TypeError('Expected mirror poll function');
  if(this.#tasks.size===8||this.#threads.has(thread)||this.#channels.has(channel))return false;
  const target=Object.freeze({thread,channel}),abort=new AbortController();let interrupted:'TimedOut'|'Cancelled'|null=null;
  const cancel=(reason:unknown)=>{if(abort.signal.aborted)return;interrupted='Cancelled';abort.abort(reason);};
  const task:Task={target,abort,promise:Promise.resolve(),result:null,cancel};this.#tasks.add(task);this.#threads.add(thread);this.#channels.add(channel);
  const listener=()=>cancel(signal!.reason);signal?.addEventListener('abort',listener,{once:true});if(signal?.aborted)listener();
  const timer=setTimeout(()=>{if(abort.signal.aborted)return;interrupted='TimedOut';abort.abort(new Error('Mirror target deadline elapsed; actual work still owns its slot'));},this.#deadline);
  task.promise=Promise.resolve().then(async()=>{
   let outcome:MirrorTargetOutcome;
   try{abort.signal.throwIfAborted();const pending=poll(target,abort.signal);if(!types.isPromise(pending))throw new TypeError('Mirror poll must return a native Promise');const value=await pending;outcome={kind:'Completed',progress:counts(value)};}catch(error){outcome={kind:'Failed',error};}
   finally{clearTimeout(timer);signal?.removeEventListener('abort',listener);}
   if(interrupted==='TimedOut')outcome={kind:'TimedOut',error:outcome.kind==='Failed'?outcome.error:abort.signal.reason};
   else if(interrupted==='Cancelled')outcome={kind:'Cancelled',reason:abort.signal.reason};
   task.result=Object.freeze({target,outcome:Object.freeze(outcome)});this.#notify();
  });return true;
 }
 /** One cancellable observation waiter, not another task or submission slot.
  * Cancelling the wait never cancels/releases the underlying target operations.
  * Timer-driven owners can replace a wait without accumulating Promise.race
  * listeners on a native operation that may remain pending indefinitely. */
 get waitingForSettlement():boolean{return this.#waiter!==null;}
 #notify():void{const waiter=this.#waiter;if(waiter===null)return;this.#waiter=null;waiter.cleanup();waiter.resolve(true);}
 async waitForSettlement(signal?:AbortSignal):Promise<boolean>{
  signal?.throwIfAborted();if(this.#tasks.size===0)return false;
  if([...this.#tasks].some(task=>task.result!==null))return true;
  if(this.#waiter!==null)throw new TypeError('Mirror settlement already has an observation waiter');
  return new Promise<boolean>((resolve,reject)=>{
   const abort=()=>{if(this.#waiter!==waiter)return;this.#waiter=null;waiter.cleanup();reject(signal!.reason);};
   const waiter={resolve,reject,cleanup:()=>signal?.removeEventListener('abort',abort)};this.#waiter=waiter;
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
 }
 takeSettled():readonly MirrorTargetFinished[]{const out:MirrorTargetFinished[]=[];for(const task of this.#tasks)if(task.result!==null){out.push(task.result);this.#tasks.delete(task);this.#threads.delete(task.target.thread);this.#channels.delete(task.target.channel);}return Object.freeze(out);}
 close(reason:unknown=new Error('Mirror execution stopped')):Promise<readonly MirrorTargetFinished[]>{if(this.#closing!==null)return this.#closing;this.#closed=true;for(const task of this.#tasks)task.cancel(reason);this.#closing=(async()=>{await Promise.all([...this.#tasks].map(t=>t.promise));return this.takeSettled();})();return this.#closing;}
}
Object.freeze(MirrorTargetExecution.prototype);
