import {TargetLocks} from "../core/keyed-locks.ts";
import {ClientCloseCoordinator} from "./close-coordinator.ts";
import {ClientRuntimeState} from "./runtime-state.ts";
import {AppServerWriter,type OwnedAppServerInput} from "./writer.ts";
import {AppServerRequestError} from "./request-client.ts";
export interface OwnedChildWait{wait(signal?:AbortSignal):Promise<void>;startKill():void}
export interface CloseBudgets{readonly gracefulMs:number;readonly forcedMs:number}
export const DEFAULT_CLOSE_BUDGETS:CloseBudgets=Object.freeze({gracefulMs:1500,forcedMs:5000});
const REASON="closed by client";
type WaitResult={kind:"Reaped"}|{kind:"TimedOut"}|{kind:"Failed";error:unknown};
async function boundedWait(child:OwnedChildWait,ms:number):Promise<WaitResult>{
  const controller=new AbortController(),timeout=Symbol("owned child wait timeout"),timer=setTimeout(()=>controller.abort(timeout),ms);
  try{await child.wait(controller.signal);return {kind:"Reaped"};}
  catch(error){return controller.signal.aborted&&error===timeout?{kind:"TimedOut"}:{kind:"Failed",error};}
  finally{clearTimeout(timer);}
}
/** Frozen close.rs algorithm with explicit cancellable wait adapters. A timeout must
 * cancel/join ONLY the wait observation, never kill implicitly or lose child custody.
 * Unknown exit retains the exact child for explicit later reconciliation/retry. */
export class ClientProcessCloser{
  readonly #close:ClientCloseCoordinator;readonly #state:ClientRuntimeState;readonly #writer:AppServerWriter;
  readonly #shutdown:(input:OwnedAppServerInput)=>Promise<void>;readonly #budgets:CloseBudgets;readonly #locks=new TargetLocks();#child:OwnedChildWait|null;
  constructor(close:ClientCloseCoordinator,state:ClientRuntimeState,writer:AppServerWriter,child:OwnedChildWait|null,shutdown:(input:OwnedAppServerInput)=>Promise<void>,budgets:CloseBudgets=DEFAULT_CLOSE_BUDGETS){
    for(const value of [budgets.gracefulMs,budgets.forcedMs])if(!Number.isSafeInteger(value)||value<0||value>2147483647)throw new TypeError("Expected bounded close timeouts");
    this.#close=close;this.#state=state;this.#writer=writer;this.#child=child;this.#shutdown=shutdown;this.#budgets=Object.freeze({...budgets});
  }
  get hasRetainedChild():boolean{return this.#child!==null;}
  async close():Promise<void>{
    this.#close.beginClientClose(REASON);let failed=false,first:unknown;
    const record=(error:unknown)=>{if(!failed){failed=true;first=error;}};
    try{await this.#writer.shutdownInput(this.#shutdown);}catch(error){record(error);}
    await this.#locks.run("child",async()=>{
      const child=this.#child;if(child===null)return;
      const graceful=await boundedWait(child,this.#budgets.gracefulMs);let reaped=graceful.kind==="Reaped";
      if(!reaped){
        if(graceful.kind==="Failed")record(graceful.error);
        try{child.startKill();}catch(error){record(error);}
        const forced=await boundedWait(child,this.#budgets.forcedMs);reaped=forced.kind==="Reaped";
        if(forced.kind==="Failed")record(forced.error);
        else if(forced.kind==="TimedOut")record(new AppServerRequestError({kind:"Timeout",method:"process/exit",timeoutMs:this.#budgets.forcedMs}));
      }
      if(reaped){this.#state.confirmOwnedProcessExit();this.#child=null;}
    });
    try{await this.#close.markClosed(REASON);}catch(error){if(failed)throw new AggregateError([first,error],"App-server close publication cleanup failed");throw error;}
    if(failed)throw first;
  }
}
