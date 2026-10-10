import {types} from 'node:util';
import {requireDiscordText} from '../../discord/text.ts';
import {MirrorTargetReady,type MirrorReadyLimits,type MirrorTargetHint} from './ready.ts';
import {MirrorTargetExecution,type MirrorPollCounts,type MirrorTargetFinished} from './execution.ts';
import {SessionMirrorRetryState,type SessionMirrorFailureReport} from './retry.ts';
function settledMetadata(value:unknown):unknown{if(types.isPromise(value)){void Promise.prototype.then.call(value,undefined,()=>undefined);throw new TypeError('Mirror metadata callback returned Promise');}return value;}
const TIMEOUT='phase=target_poll; deadline=10s; cursor retained; in-flight delivery outcome may be unknown; no success inferred';
export interface MirrorDispatchResult{readonly finished:MirrorTargetFinished;readonly report:SessionMirrorFailureReport|null;}
interface Retry{readonly state:SessionMirrorRetryState;readyAt:bigint;textBytes:number;}
/** Bounded orchestration of source refresh/dispatch/completion ordering. IO and
 * durable receipt/cursor checks remain the explicit owned poll adapter. Shared
 * discovery timing, filesystem snapshots and shutdown supervisor are not created
 * here. A diagnostic conversion failure stops dispatch and preserves harvested
 * records for close; it cannot silently turn a failed target into a success. */
export class MirrorDispatch{
 readonly #ready:MirrorTargetReady;readonly #execution:MirrorTargetExecution;readonly #poll:(target:MirrorTargetHint,signal:AbortSignal)=>Promise<MirrorPollCounts>;readonly #clock:()=>bigint;readonly #render:(error:unknown)=>string;readonly #retry=new Map<string,Retry>();readonly #started:bigint;#last:bigint;#retryBytes=0;#closed=false;#faulted=false;#held:readonly MirrorTargetFinished[]=[];#closing:Promise<readonly MirrorTargetFinished[]>|null=null;
 constructor(limits:MirrorReadyLimits,poll:(target:MirrorTargetHint,signal:AbortSignal)=>Promise<MirrorPollCounts>,render:(error:unknown)=>string,clock:()=>bigint=()=>process.hrtime.bigint()){
  for(const f of [poll,render,clock])if(typeof f!=='function'||types.isProxy(f)||types.isGeneratorFunction(f))throw new TypeError('Expected owned mirror callbacks');if(types.isAsyncFunction(render)||types.isAsyncFunction(clock))throw new TypeError('Expected synchronous mirror metadata callbacks');
  this.#ready=new MirrorTargetReady(limits);this.#execution=new MirrorTargetExecution();this.#poll=poll;this.#render=render;this.#clock=clock;const now=settledMetadata(clock());if(typeof now!=='bigint'||now<0n)throw new TypeError('Expected monotonic nanoseconds');this.#started=now;this.#last=now;
 }
 #now():bigint{const now=settledMetadata(this.#clock());if(typeof now!=='bigint'||now<this.#last)throw new TypeError('Mirror monotonic clock moved backwards');this.#last=now;return now;}
 #open():void{if(this.#closed||this.#faulted)throw new TypeError('Mirror dispatch is closed or faulted');}
 get activeCount():number{return this.#execution.size;}
 get readyCount():number{return this.#ready.length;}
 refresh(targets:readonly MirrorTargetHint[]):void{this.#open();const active=this.#execution.activeThreads();this.#ready.refresh(targets,active);const present=new Set(this.#ready.snapshot().map(t=>t.thread));for(const [thread,retry]of this.#retry)if(!present.has(thread)&&!active.has(thread)){this.#retryBytes-=retry.textBytes;this.#retry.delete(thread);}}
 dispatch():number{this.#open();const now=this.#now();let started=0;while(this.#execution.size<8){const next=this.#ready.take(this.#execution.activeThreads(),this.#execution.activeChannels(),thread=>(this.#retry.get(thread)?.readyAt??0n)<=now);if(next===null)break;if(!this.#execution.tryStart(next,this.#poll))throw new TypeError('Mirror ownership changed during synchronous dispatch');started++;}return started;}
 waitForSettlement():Promise<boolean>{return this.#execution.waitForSettlement();}
 harvest():readonly MirrorDispatchResult[]{
  this.#open();const rows=this.#execution.takeSettled();if(rows.length===0)return Object.freeze([]);this.#held=rows;
  try{
   const now=this.#now();const texts=rows.map(row=>{const outcome=row.outcome;if(outcome.kind==='Completed'||outcome.kind==='Cancelled')return null;const text=outcome.kind==='TimedOut'?TIMEOUT:settledMetadata(this.#render(outcome.error));requireDiscordText(text);if(Buffer.byteLength(text,'utf8')>16384)throw new RangeError('Mirror diagnostic byte budget exceeded');return text;});
   let bytes=this.#retryBytes;for(let i=0;i<rows.length;i++){const row=rows[i]!,old=this.#retry.get(row.target.thread);bytes-=old?.textBytes??0;bytes+=texts[i]===null?0:Buffer.byteLength(texts[i]!,'utf8');}if(bytes>1048576)throw new RangeError('Mirror retry metadata budget exceeded');
   const result:MirrorDispatchResult[]=[];
   for(let i=0;i<rows.length;i++){const row=rows[i]!,thread=row.target.thread,text=texts[i]!;let report:SessionMirrorFailureReport|null=null;if(text===null){this.#retry.delete(thread);}else{const retry=this.#retry.get(thread)??{state:new SessionMirrorRetryState(),readyAt:0n,textBytes:0};const decision=retry.state.onFailure(now-this.#started,text);retry.readyAt=now+decision.retryAfterNanoseconds;retry.textBytes=Buffer.byteLength(text,'utf8');this.#retry.set(thread,retry);report=decision.report;}result.push(Object.freeze({finished:row,report}));}
   this.#retryBytes=bytes;this.#held=[];return Object.freeze(result);
  }catch(error){this.#faulted=true;throw error;}
 }
 close(reason?:unknown):Promise<readonly MirrorTargetFinished[]>{if(this.#closing!==null)return this.#closing;this.#closed=true;this.#closing=(async()=>{const pending=await this.#execution.close(reason);const all=Object.freeze([...this.#held,...pending]);this.#held=[];this.#retry.clear();this.#retryBytes=0;return all;})();return this.#closing;}
}
Object.freeze(MirrorDispatch.prototype);
