import {invokeSynchronousVoid as syncVoid} from "../core/synchronous-void.ts";
import {randomUUID} from "node:crypto";
import {performance} from "node:perf_hooks";
import {types} from "node:util";
import {requestValue,notificationValue,type RequestId} from "../protocol/rpc.ts";
import {ClientLifecycle} from "./client-lifecycle.ts";
import {PendingResponses,PendingReceiverClosedError,type PendingOutcome} from "./pending-responses.ts";
import {AppServerWriter} from "./writer.ts";
export type RequestFailure=
  |{readonly kind:"Timeout";readonly method:string;readonly timeoutMs:number}
  |{readonly kind:"ResponseChannelClosed";readonly method:string}
  |{readonly kind:"TransportClosed";readonly method:string;readonly reason:string}
  |{readonly kind:"Remote";readonly method:string;readonly code:bigint;readonly message:string;readonly data:unknown};
export class AppServerRequestError extends Error{
  readonly detail:RequestFailure;
  constructor(detail:RequestFailure){
    super(detail.kind==="Timeout"?`app-server request ${detail.method} timed out after ${detail.timeoutMs} ms`:detail.kind==="ResponseChannelClosed"?`app-server request channel closed for ${detail.method}`:detail.kind==="TransportClosed"?`app-server transport closed while awaiting ${detail.method}: ${detail.reason}`:`app-server returned error ${detail.code} for ${detail.method}: ${detail.message}`);
    this.name="AppServerRequestError";this.detail=Object.freeze(detail);
  }
}
export interface RequestHooks{preflight(id:RequestId):void;writeStarted():void;writeComplete():void}

function awaitOwned<T>(result:Promise<T>,signal?:AbortSignal):Promise<T>{
  if(signal===undefined)return result;if(signal.aborted)return Promise.reject(signal.reason);
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener("abort",abort);reject(signal.reason);};
    signal.addEventListener("abort",abort,{once:true});
    void result.then(value=>{signal.removeEventListener("abort",abort);resolve(value);},error=>{signal.removeEventListener("abort",abort);reject(error);});
  });
}
const noHooks:RequestHooks=Object.freeze({preflight(){},writeStarted(){},writeComplete(){}});
/** Composes one lifecycle/pending/writer owner. No process spawn or native I/O adapter.
 * Explicit signal cancellation preserves mutation response leases after caller return.
 * Default monotonic clock is milliseconds; no nanosecond/automatic Drop equivalence. */
export class AppServerRequestClient{
  readonly #gate:ClientLifecycle;readonly #pending:PendingResponses;readonly #writer:AppServerWriter;readonly #now:()=>number;
  constructor(gate:ClientLifecycle,pending:PendingResponses,writer:AppServerWriter,monotonicNow:()=>number=()=>performance.now()){this.#gate=gate;this.#pending=pending;this.#writer=writer;this.#now=monotonicNow;}
  async request(method:string,params:unknown,waitMs:number,hooks:RequestHooks=noHooks,signal?:AbortSignal):Promise<unknown>{
    const outer=this.#gate.admit();
    try{
      signal?.throwIfAborted();
      const id=randomUUID(),responsePermit=this.#gate.admit(),registration=this.#pending.registerForMethod(id,responsePermit,waitMs,method);
      try{
        const timeout=()=>new AppServerRequestError({kind:"Timeout",method,timeoutMs:waitMs});
        try{
          const began=this.#now();if(!Number.isFinite(began))throw new TypeError("Expected finite monotonic clock");const deadline=began+waitMs;
          const checkDeadline=()=>{const now=this.#now();if(!Number.isFinite(now)||now<began)throw new TypeError("Monotonic clock moved backwards or became invalid");if(now>=deadline)throw timeout();};
          await this.#writer.write(requestValue(id,method,params),{check:()=>{checkDeadline();syncVoid(hooks.preflight,hooks,[id]);checkDeadline();},dispose(){}},()=>syncVoid(hooks.writeStarted,hooks),signal);
        }
        catch(error){registration.finish();throw error;}
        syncVoid(hooks.writeComplete,hooks);
        let outcome:PendingOutcome;
        try{outcome=await awaitOwned(registration.result,signal);}
        catch(error){
          if(signal?.aborted&&error===signal.reason)throw error;
          if(error!==null&&typeof error==="object"&&!types.isProxy(error)&&error instanceof PendingReceiverClosedError)throw new AppServerRequestError({kind:"ResponseChannelClosed",method});
          throw error;
        }
        registration.finish();
        if(outcome.kind==="Timeout")throw timeout();
        if(outcome.kind==="TransportClosed")throw new AppServerRequestError({kind:"TransportClosed",method,reason:outcome.reason});
        if(!outcome.result.ok)throw new AppServerRequestError({kind:"Remote",method,...outcome.result.error});
        return outcome.result.value;
      }finally{registration.dispose();}
    }finally{outer.release();}
  }
  async notify(method:string,params:unknown,signal?:AbortSignal):Promise<void>{
    const permit=this.#gate.admit();
    try{await this.#writer.write(notificationValue(method,params),{check(){},dispose(){}},()=>{},signal);}
    finally{permit.release();}
  }
}
