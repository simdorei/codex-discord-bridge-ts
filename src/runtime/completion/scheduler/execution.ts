import {CompletionReady,COMPLETION_STATE_SLOTS,COMPLETION_HTTP_SLOTS,type ReadyStateWork,type ReadyAdmission} from "./ready.ts";
import type {CompletionEntry} from "../../../store/completion-metadata.ts";
import type {CompletionNotification} from "./envelope.ts";
export type CompletionWorkOutcome={readonly ok:true}|{readonly ok:false;readonly error:unknown};
export type CompletionExecutionResult=
 |{readonly kind:"State";readonly target:string;readonly native:boolean;readonly wake:boolean;readonly outcome:CompletionWorkOutcome}
 |{readonly kind:"Http";readonly entry:CompletionEntry;readonly outcome:CompletionWorkOutcome};
/** Trusted adapters own their IO cancellation. Returning settles the entire operation,
 * including children; an HTTP timeout must not be treated as proven non-delivery. */
export interface CompletionExecutionPorts<P>{
 prepare(work:ReadyStateWork<CompletionNotification>):ReadyAdmission<P>|null;
 state(work:ReadyStateWork<CompletionNotification>,permit:P,signal:AbortSignal):Promise<void>;
 http(entry:CompletionEntry,signal:AbortSignal):Promise<void>;
 prepareFailed(error:unknown):void;
}
interface Task {promise:Promise<void>;result:CompletionExecutionResult|null}
const target=(work:ReadyStateWork<CompletionNotification>)=>work.kind==="Live"?work.live.target:work.entry.target;
const wake=(work:ReadyStateWork<CompletionNotification>)=>work.kind==="Durable"||["turn/started","turn/completed","item/completed","thread/goal/updated"].includes(work.live.payload.notification.method);
/** Owned bounded execution half of the scheduler. Discovery, tick timing and fresh-head
 * prioritization remain the enclosing loop's responsibility. Completed but unharvested
 * tasks retain their slot and lane identity; no unbounded result queue is created. */
export class CompletionExecution<P>{
 readonly #notify:()=>void;readonly #ready:CompletionReady<CompletionNotification>;readonly #ports:CompletionExecutionPorts<P>;readonly #abort=new AbortController();
 readonly #targets=new Set<string>();readonly #channels=new Map<bigint,CompletionEntry>();readonly #states=new Set<Task>();readonly #http=new Set<Task>();#native=0;#closed=false;#closing:Promise<void>|null=null;#pumping=false;
 constructor(ready:CompletionReady<CompletionNotification>,ports:CompletionExecutionPorts<P>,notify:()=>void=()=>{}){this.#notify=notify;this.#ready=ready;this.#ports={prepare:ports.prepare.bind(ports),state:ports.state.bind(ports),http:ports.http.bind(ports),prepareFailed:ports.prepareFailed.bind(ports)};}
 get stateCount():number{return this.#states.size;}
 get httpCount():number{return this.#http.size;}
 get nativeCount():number{return this.#native;}
 activeTargets():ReadonlySet<string>{return new Set(this.#targets);}
 activeChannels():ReadonlyMap<bigint,CompletionEntry>{return new Map(this.#channels);}
 /** No await occurs while ownership is selected. Each launched task always owns and
  * releases its original permit/envelope, even on synchronous callback failure. */
 launch():void{
  if(this.#closed)throw new TypeError("Completion execution closed");if(this.#pumping)throw new TypeError("Completion execution launch is not reentrant");this.#pumping=true;
  try{
   while(this.#states.size<COMPLETION_STATE_SLOTS){
    let release:(()=>void)|null=null;
    const chosen=this.#ready.takeStateAdmitted(this.#targets,this.#native,work=>{
     try{const admitted=this.#ports.prepare(work);if(admitted!==null)release=()=>admitted.release();return admitted;}
     catch(error){this.#ports.prepareFailed(error);return null;}
    });
    if(chosen===null)break;const releaseSelected=release!;const key=target(chosen.work);this.#targets.add(key);if(chosen.needsNative)this.#native++;
    const task:Task={promise:Promise.resolve(),result:null};
    const promise=Promise.resolve().then(async()=>{
     let outcome:CompletionWorkOutcome={ok:true};try{this.#abort.signal.throwIfAborted();await this.#ports.state(chosen.work,chosen.permit,this.#abort.signal);}catch(error){outcome={ok:false,error};}
     const cleanupErrors:unknown[]=[];try{releaseSelected();}catch(error){cleanupErrors.push(error);}try{if(chosen.work.kind==="Live")chosen.work.live.dispose();}catch(error){cleanupErrors.push(error);}
     if(cleanupErrors.length)outcome={ok:false,error:new AggregateError(outcome.ok?cleanupErrors:[outcome.error,...cleanupErrors],"Completion state cleanup failed")};
     task.result={kind:"State",target:key,native:chosen.needsNative,wake:wake(chosen.work),outcome};this.#notify();
    });
    task.promise=promise;this.#states.add(task);
   }
   while(this.#http.size<COMPLETION_HTTP_SLOTS){const entry=this.#ready.takeHttp(this.#channels);if(entry===null)break;this.#channels.set(entry.channel,entry);
    const task:Task={promise:Promise.resolve(),result:null};const promise=Promise.resolve().then(async()=>{let outcome:CompletionWorkOutcome={ok:true};try{this.#abort.signal.throwIfAborted();await this.#ports.http(entry,this.#abort.signal);}catch(error){outcome={ok:false,error};}task.result={kind:"Http",entry,outcome};this.#notify();});task.promise=promise;this.#http.add(task);
   }
  }finally{this.#pumping=false;}
 }
 /** Harvest only settled records; releasing bookkeeping never abandons running IO. */
 takeSettled():readonly CompletionExecutionResult[]{
  const results:CompletionExecutionResult[]=[];for(const task of this.#states){if(task.result===null)continue;const result=task.result;if(result.kind!=="State")throw new TypeError("Invalid state task result");this.#states.delete(task);this.#targets.delete(result.target);if(result.native)this.#native--;results.push(result);}
  for(const task of this.#http){if(task.result===null)continue;const result=task.result;if(result.kind!=="Http")throw new TypeError("Invalid HTTP task result");this.#http.delete(task);this.#channels.delete(result.entry.channel);results.push(result);}return Object.freeze(results);
 }
 /** Cooperative cancellation, followed by actual join. No Promise.race is used to
  * pretend that timed-out HTTP/native work was stopped. Noncooperative adapters can
  * delay shutdown; the service must supply bounded owned transports. */
 close(reason:unknown=new Error("Completion execution stopped")):Promise<void>{
  if(this.#closing!==null)return this.#closing;this.#closed=true;this.#abort.abort(reason);
  this.#closing=(async()=>{await Promise.allSettled([...this.#states,...this.#http].map(t=>t.promise));this.takeSettled();this.#ready.dispose();})();return this.#closing;
 }
}
