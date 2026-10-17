import {performance} from "node:perf_hooks";
import {setTimeout as delay} from "node:timers/promises";
import {types} from "node:util";
import {invokeSynchronousVoid} from "../core/synchronous-void.ts";
import {GenerationWatchClosedError,type GenerationWatchReceiver} from "./generation-watch.ts";
export class RestartBackoff{
  #failures=0;
  nextDelay():number{const shift=Math.min(this.#failures,5);this.#failures=Math.min(this.#failures+1,0xffffffff);return Math.min(250*2**shift,5000);}
  reset():void{this.#failures=0;}
}
export interface RestartClock{now():number;waitUntil(deadline:number,signal:AbortSignal):Promise<void>}
const nativeClock:RestartClock=Object.freeze({now:()=>performance.now(),async waitUntil(deadline:number,signal:AbortSignal){
  try{while(true){signal.throwIfAborted();const remaining=deadline-performance.now();if(remaining<=0)return;await delay(Math.ceil(remaining),undefined,{signal});}}
  catch(error){if(signal.aborted)throw signal.reason;throw error;}
}});
export type RestartFailureReporter=(generation:bigint,error:unknown)=>void;
type Result={readonly ok:true}|{readonly ok:false;readonly error:unknown};
async function observe(operation:()=>Promise<void>):Promise<Result>{try{await operation();return {ok:true};}catch(error){return {ok:false,error};}}
function callable(value:unknown,synchronous=false):asserts value is Function{if(typeof value!=="function"||types.isProxy(value)||types.isGeneratorFunction(value)||(synchronous&&types.isAsyncFunction(value)))throw new TypeError("Expected trusted restart callback");}
async function waitRetry(restart:GenerationWatchReceiver,shutdown:AbortSignal,generation:bigint,deadline:number,clock:RestartClock):Promise<"Stop"|"Changed"|"Deadline">{
  while(true){
    if(shutdown.aborted)return "Stop";
    const controller=new AbortController(),canceled=Object.freeze({finishedSelection:true}),onShutdown=()=>controller.abort(shutdown.reason);shutdown.addEventListener("abort",onShutdown,{once:true});
    const timer=observe(()=>clock.waitUntil(deadline,controller.signal)),change=observe(()=>restart.changed(controller.signal));
    await Promise.race([timer,change]);controller.abort(canceled);const [slept,changed]=await Promise.all([timer,change]);shutdown.removeEventListener("abort",onShutdown);
    if(shutdown.aborted)return "Stop";
    if(!changed.ok&&changed.error instanceof GenerationWatchClosedError)return "Stop";
    if(!changed.ok&&changed.error!==canceled)throw changed.error;if(!slept.ok&&slept.error!==canceled)throw slept.error;
    if(slept.ok)return "Deadline";
    if(restart.borrowAndUpdate()!==generation)return "Changed";
    // Same-generation watch notifications do not change the absolute deadline.
  }
}
/** Source supervisor.rs with explicit AbortSignal shutdown (one-way true/closed subset
 * of the source shutdown watch). Does NOT cancel an already-running restart attempt:
 * it joins that operation before stopping, preserving native cleanup ownership. Caller
 * owns this returned Promise and must signal shutdown + await it before final disposal.
 * The reporter receives raw error identity and must render diagnostics safely. */
export async function runRestartSupervisor(restart:GenerationWatchReceiver,shutdown:AbortSignal,attempt:(generation:bigint)=>Promise<boolean>,report:RestartFailureReporter,clock:RestartClock=nativeClock):Promise<void>{
  try{
    callable(attempt);callable(report,true);
    const now=clock.now,wait=clock.waitUntil;callable(now,true);callable(wait);let previous=-Infinity;
    const ownedClock:RestartClock=Object.freeze({now:()=>{const value=Reflect.apply(now,clock,[]);if(typeof value!=="number"||!Number.isFinite(value)||value<previous)throw new TypeError("Invalid monotonic restart clock");previous=value;return value;},waitUntil:(deadline:number,signal:AbortSignal)=>Reflect.apply(wait,clock,[deadline,signal]) as Promise<void>});
    const backoff=new RestartBackoff();let retryGeneration:bigint|null=null,settledThrough:bigint|null=null;
    const reset=()=>{backoff.reset();retryGeneration=null;};
    while(true){
      if(shutdown.aborted)return;const requested=restart.borrowAndUpdate();
      if(requested===null||(settledThrough!==null&&requested<=settledThrough)){
        reset();try{await restart.changed(shutdown);}catch(error){if(shutdown.aborted||error instanceof GenerationWatchClosedError)return;throw error;}continue;
      }
      if(retryGeneration!==requested){reset();retryGeneration=requested;}
      let settled=false;
      try{const result:unknown=await attempt(requested);if(typeof result!=="boolean")throw new TypeError("Restart attempt must return boolean");settled=result;}
      catch(error){try{invokeSynchronousVoid(report,reportReceiver,[requested,error]);}catch(reportError){throw new AggregateError([error,reportError],"Restart failure reporting failed");}}
      if(shutdown.aborted)return;
      if(settled){settledThrough=settledThrough===null||requested>settledThrough?requested:settledThrough;reset();continue;}
      const deadline=ownedClock.now()+backoff.nextDelay();if(!Number.isFinite(deadline))throw new TypeError("Restart deadline overflow");
      if(await waitRetry(restart,shutdown,requested,deadline,ownedClock)==="Stop")return;
    }
  }finally{restart.dispose();}
}
const reportReceiver=Object.freeze({});
