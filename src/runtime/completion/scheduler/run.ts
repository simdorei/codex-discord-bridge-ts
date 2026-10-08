import {setImmediate as yieldToRuntime} from "node:timers/promises";
import {CompletionReady,type ReadyLive} from "./ready.ts";
import {CompletionExecution,type CompletionExecutionPorts} from "./execution.ts";
import {CompletionDiscovery} from "./discovery.ts";
import type {CompletionNotification} from "./envelope.ts";
import {sameCompletionIdentity,type CompletionEntry} from "../../../store/completion-metadata.ts";
import {DelayedTicks,type TickSource} from "../../delayed-ticks.ts";
import {invokeSynchronousVoid} from "../../../core/synchronous-void.ts";
/** At most one waiter and one remembered wake; no per-event promise queue. */
class Wake{
 #pending=false;#closed=false;#resolve:(()=>void)|null=null;
 notify():void{if(this.#closed)return;if(this.#resolve!==null){const r=this.#resolve;this.#resolve=null;r();}else this.#pending=true;}
 wait():Promise<void>{if(this.#closed)return Promise.resolve();if(this.#resolve!==null)throw new TypeError("Wake already owned");if(this.#pending){this.#pending=false;return Promise.resolve();}return new Promise(resolve=>{this.#resolve=resolve;});}
 close():void{this.#closed=true;this.#pending=false;this.#resolve?.();this.#resolve=null;}
}
export interface CompletionSchedulerPorts<P> extends CompletionExecutionPorts<P>{
 instanceId():string;generation():bigint;
 freshHeads(target:string):Promise<readonly CompletionEntry[]>;
 maintain(signal:AbortSignal):Promise<void>;
 /** Passive, public-safe central diagnostic hooks. Neither hook may throw. */
 report(error:unknown):void;gap(error:unknown):void;
}
/** Single-use staged scheduler. Upstream transfers owned charged envelopes through offer;
 * finishInput stops new input but drains buffered work. The final service owns upstream
 * intake and must join it too; this class is not an entire Discord/native service. */
export class CompletionScheduler<P>{
 readonly #path:string;readonly #ports:CompletionSchedulerPorts<P>;readonly #ready=new CompletionReady<CompletionNotification>();readonly #execution:CompletionExecution<P>;readonly #wake=new Wake();readonly #discovery:CompletionDiscovery;readonly #now:()=>number;readonly #input:ReadyLive<CompletionNotification>[]=[];
 #inputFinished=false;#closed=false;#used=false;
 constructor(path:string,ports:CompletionSchedulerPorts<P>,options:{discovery?:CompletionDiscovery;now?:()=>number}={}){
  this.#path=path;this.#ports={prepare:ports.prepare.bind(ports),state:ports.state.bind(ports),http:ports.http.bind(ports),prepareFailed:ports.prepareFailed.bind(ports),instanceId:ports.instanceId.bind(ports),generation:ports.generation.bind(ports),freshHeads:ports.freshHeads.bind(ports),maintain:ports.maintain.bind(ports),report:ports.report.bind(ports),gap:ports.gap.bind(ports)};this.#now=options.now??(()=>performance.now());this.#discovery=options.discovery??new CompletionDiscovery(undefined,this.#now);this.#execution=new CompletionExecution(this.#ready,this.#ports,()=>this.#wake.notify());
 }
 #report(error:unknown):void{invokeSynchronousVoid(this.#ports.report,this.#ports,[error]);}
 #gap(error:unknown):void{invokeSynchronousVoid(this.#ports.gap,this.#ports,[error]);this.#report(error);}
 /** Ownership transfers on both success and rejection. */
 offer(event:ReadyLive<CompletionNotification>):boolean{
  if(this.#closed||this.#inputFinished){event.dispose();return false;}
  if(this.#input.length>=128){event.dispose();this.#gap(new Error("completion input capacity gap; durable evidence retained"));return false;}
  this.#input.push(event);this.#wake.notify();return true;
 }
 finishInput():void{this.#inputFinished=true;this.#wake.notify();}
 notifyDeliveryReady():void{this.#discovery.wake();this.#wake.notify();}
 get pendingInput():number{return this.#input.length;}
 #clock():number{const now=this.#now();if(!Number.isFinite(now)||now<0)throw new TypeError("Expected monotonic scheduler clock");return now;}
 #discover():void{
  try{const generation=this.#ports.generation();if(typeof generation!=="bigint"||generation<0n||generation>=(1n<<63n))throw new RangeError("Completion generation outside i64");const reports=this.#discovery.read(this.#path,this.#ports.instanceId(),generation,this.#ready,this.#execution.activeTargets());
   // Consume all negative sidecars synchronously before any dispatch/await.
   const negatives=reports.flatMap(r=>r.ok&&r.metadata!==null?r.metadata.deferred:[]);this.#ready.discardOrphanHints(negatives);
   for(const report of reports){if(!report.ok)this.#gap(report.error);else if(report.metadata!==null){if(report.metadata.oversizedIdentity)this.#gap(new Error(`completion metadata identity over budget: ${report.source}`));if(report.metadata.heldReceiptHeads>0n)this.#report(new Error(`completion receipt heads retained: ${report.source} count=${report.metadata.heldReceiptHeads}; no retry scheduled`));}}
  }catch(error){this.#gap(error);}
 }
 async #harvest():Promise<void>{
  for(const result of this.#execution.takeSettled()){
   if(!result.outcome.ok){this.#report(result.outcome.error);continue;}
   if(result.kind==="Http"){this.#discovery.wake(result.entry.source);continue;}
   if(result.wake){try{const heads=await this.#ports.freshHeads(result.target),active=this.#execution.activeChannels();for(let i=heads.length-1;i>=0;i--){const entry=heads[i]!;if(![...active.values()].some(e=>sameCompletionIdentity(e,entry)))this.#ready.prioritize(entry);}this.#discovery.wakeHttp();}catch(error){this.#report(error);}}
  }
 }
 async run(signal:AbortSignal,ticks:TickSource=new DelayedTicks(50)):Promise<void>{
  if(this.#used){ticks.close();throw new TypeError("Completion scheduler already used");}this.#used=true;
  const cancel=new AbortController();let stop!:()=>void;const stopped=new Promise<'stop'>(resolve=>{stop=()=>resolve('stop');});signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
  let tick:Promise<'tick'>|undefined,wake:Promise<'wake'>|undefined,maintenance:{promise:Promise<void>;result:{ok:true}|{ok:false;error:unknown}|null}|null=null,maintenanceDue=0,discover=true,deadline:number|null=null;
  try{
   while(!signal.aborted){
    const now=this.#clock();if(this.#inputFinished&&deadline===null)deadline=now+5000;if(deadline!==null&&now>=deadline)break;
    for(let i=0;i<128;i++){const event=this.#input.shift();if(event===undefined)break;if(!this.#ready.live(event))this.#gap(new Error("completion ready capacity gap; durable evidence retained"));}
    await this.#harvest();if(signal.aborted)break;
    if(maintenance!==null&&maintenance.result!==null){if(!maintenance.result.ok)this.#report(maintenance.result.error);maintenance=null;}
    if(discover){this.#discover();discover=false;}
    this.#execution.launch();
    if(maintenance===null&&now>=maintenanceDue){const task:{promise:Promise<void>;result:{ok:true}|{ok:false;error:unknown}|null}={promise:Promise.resolve(),result:null};task.promise=Promise.resolve().then(async()=>{try{cancel.signal.throwIfAborted();await this.#ports.maintain(cancel.signal);task.result={ok:true};}catch(error){task.result={ok:false,error};}this.#wake.notify();});maintenance=task;maintenanceDue=now+30000;}
    if(this.#inputFinished&&this.#input.length===0&&this.#ready.length===0&&this.#execution.stateCount===0&&this.#execution.httpCount===0&&maintenance===null&&this.#discovery.drained)break;
    tick??=ticks.wait().then(()=>'tick' as const);wake??=this.#wake.wait().then(()=>'wake' as const);const selected=await Promise.race([tick,wake,stopped]);if(selected==='stop')break;if(selected==='tick'){tick=undefined;discover=true;}else wake=undefined;
    await yieldToRuntime();
   }
  }finally{
   this.#closed=true;const reason=signal.aborted?signal.reason:new Error("Completion scheduler drain ended");cancel.abort(reason);ticks.close();this.#wake.close();stop();signal.removeEventListener('abort',stop);
   for(const event of this.#input)event.dispose();this.#input.length=0;
   // Close first, then join all waiters and owned maintenance; never orphan a sender.
   await Promise.allSettled([this.#execution.close(reason),...(maintenance?[maintenance.promise]:[]),...(tick?[tick]:[]),...(wake?[wake]:[])]);
  }
 }
}
