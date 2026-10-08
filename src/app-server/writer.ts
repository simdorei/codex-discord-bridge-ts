import {types} from "node:util";
import {TargetLocks} from "../core/keyed-locks.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {AppServerClosedError} from "./client-errors.ts";
import type {ClientCloseCoordinator} from "./close-coordinator.ts";
export interface OwnedAppServerInput{
  /** Must settle only after this operation has stopped touching the pipe. Cancellation
   * must stop/join the owned operation; rejecting while native work continues is invalid. */
  writeAll(bytes:Uint8Array,signal?:AbortSignal):Promise<void>;
  flush(signal?:AbortSignal):Promise<void>;
}
export interface WritePreflight<T>{
  check():T;
  /** Drop-equivalent cleanup on failure after successful check, including missing stdin.
   * Success transfers ownership of T to the caller instead. Must not throw. */
  dispose(value:T):void;
}
function sync<T>(callback:()=>T):T{
  if(typeof callback!=="function"||types.isProxy(callback)||types.isAsyncFunction(callback)||types.isGeneratorFunction(callback))throw new TypeError("Writer hook must be synchronous");
  const result=callback();if(types.isPromise(result)){void Promise.prototype.then.call(result,undefined,()=>undefined);throw new TypeError("Writer hook must not return a Promise");}return result;
}
/** Serialized source write ordering with explicit AbortSignal/owned join rather than
 * automatic future Drop. Merely abandoning its Promise does NOT cancel a write. */
export class AppServerWriter{
  readonly #locks=new TargetLocks(); #input:OwnedAppServerInput|null;readonly #close:Pick<ClientCloseCoordinator,"closed"|"markClosed">;
  constructor(input:OwnedAppServerInput|null,close:Pick<ClientCloseCoordinator,"closed"|"markClosed">){this.#input=input;this.#close=close;}
  /** Take stdin exactly once under the SAME writer lock. The owner callback must
   * shutdown and dispose the taken pipe even if shutdown fails. No future writes
   * can reuse this slot; the close coordinator must seal admission before calling. */
  async shutdownInput(shutdown:(input:OwnedAppServerInput)=>Promise<void>):Promise<void>{
    await this.#locks.run("stdin",async()=>{const input=this.#input;this.#input=null;if(input!==null)await shutdown(input);});
  }
  async write<T>(value:unknown,preflight:WritePreflight<T>,writeStarted:()=>void,signal?:AbortSignal):Promise<T>{
    if(this.#close.closed)throw new AppServerClosedError();signal?.throwIfAborted();
    const encoded=Buffer.from(serializeSerdeValue(value)+"\n","utf8");
    const lease=await this.#locks.acquire("stdin",signal);
    let admitted:T|undefined,hasAdmitted=false,attempted=false,complete=false,closeTask:Promise<void>|undefined;
    let failed=false,primary:unknown;
    const markIndeterminate=()=>{
      if(closeTask!==undefined)return closeTask;
      try{closeTask=this.#close.markClosed("app-server write outcome indeterminate");}catch(error){closeTask=Promise.reject(error);}
      void closeTask.catch(()=>undefined);return closeTask;
    };
    const abort=()=>{if(attempted&&!complete)void markIndeterminate();};
    try{
      if(this.#close.closed)throw new AppServerClosedError();signal?.throwIfAborted();
      admitted=sync(()=>preflight.check());hasAdmitted=true;
      if(this.#input===null)throw new AppServerClosedError();
      // An abort during synchronous durable preflight is still before write-start.
      signal?.throwIfAborted();attempted=true;signal?.addEventListener("abort",abort,{once:true});
      const hookResult=sync(writeStarted);if(hookResult!==undefined)throw new TypeError("Write-start hook must return void");signal?.throwIfAborted();
      await this.#input.writeAll(encoded,signal);signal?.throwIfAborted();
      await this.#input.flush(signal);signal?.throwIfAborted();
      complete=true;return admitted;
    }catch(error){failed=true;primary=error;throw error;}
    finally{
      signal?.removeEventListener("abort",abort);
      const cleanupErrors:unknown[]=[];
      try{if(attempted&&!complete)await markIndeterminate();}catch(error){cleanupErrors.push(error);}
      try{if(hasAdmitted&&!complete){const result=sync(()=>preflight.dispose(admitted as T));if(result!==undefined)throw new TypeError("Preflight disposer must return void");}}catch(error){cleanupErrors.push(error);}
      finally{lease.release();}
      if(cleanupErrors.length!==0)throw new AggregateError(failed?[primary,...cleanupErrors]:cleanupErrors,"App-server write cleanup failed");
    }
  }
}
