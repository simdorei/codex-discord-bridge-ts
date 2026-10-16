import {types} from "node:util";
import {TargetLocks,type TargetLocksRetainedWorkSnapshot} from "../core/keyed-locks.ts";
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
export interface OwnedAsyncWritePreflight<T>{
  /** Must settle only after accepted native DB work has stopped touching storage.
   * Rejection cannot mean rollback; the adapter retains any unknown durable claim. */
  check():Promise<T>;
  /** Synchronous in-memory recheck of original admission/generation/deadline after
   * native settlement. This is not a fresh authority capture or another DB wait. */
  validate(value:T):void;
  /** Failure cleanup joins its accepted work; never fabricate not_sent for an
   * indeterminate native claim. Success transfers the returned value to caller. */
  dispose(value:T):Promise<void>;
}
function nativePromise<T>(value:unknown):Promise<T>{if(!types.isPromise(value))throw new TypeError('Owned writer preflight must return a Promise');return value as Promise<T>;}
function pinOwned<T>(input:OwnedAsyncWritePreflight<T>):OwnedAsyncWritePreflight<T>{
 if(input===null||typeof input!=='object'||types.isProxy(input))throw new TypeError('Expected owned async preflight');
 const get=(key:string,synchronous=false):Function=>{const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='function'||types.isProxy(d.value)||types.isGeneratorFunction(d.value)||(synchronous&&types.isAsyncFunction(d.value)))throw new TypeError('Expected own preflight callback');return d.value;};
 const check=get('check'),validate=get('validate',true),dispose=get('dispose');
 return Object.freeze({check:()=>nativePromise<T>(Reflect.apply(check,input,[])),validate:(value:T)=>{const result=sync(()=>Reflect.apply(validate,input,[value]));if(result!==undefined)throw new TypeError('Preflight validation must return void');},dispose:async(value:T)=>{const result=await nativePromise<unknown>(Reflect.apply(dispose,input,[value]));if(result!==undefined)throw new TypeError('Preflight disposer must resolve void');}});
}
function sync<T>(callback:()=>T):T{
  if(typeof callback!=="function"||types.isProxy(callback)||types.isAsyncFunction(callback)||types.isGeneratorFunction(callback))throw new TypeError("Writer hook must be synchronous");
  const result=callback();if(types.isPromise(result)){void Promise.prototype.then.call(result,undefined,()=>undefined);throw new TypeError("Writer hook must not return a Promise");}return result;
}
/** Writer-owned encoded bytes, not retained heap, pooled storage or adapter copies. */
export interface AppServerWriterRetainedWorkSnapshot {
  readonly retainedWriteOperationCount:number;
  readonly retainedEncodedBufferBytes:number;
  readonly stdinLock:TargetLocksRetainedWorkSnapshot;
}
/** Serialized source write ordering with explicit AbortSignal/owned join rather than
 * automatic future Drop. Merely abandoning its Promise does NOT cancel a write. */
export class AppServerWriter{
  readonly #locks=new TargetLocks(); #input:OwnedAppServerInput|null;readonly #close:Pick<ClientCloseCoordinator,"closed"|"markClosed">;
  #retainedWriteOperationCount=0;
  #retainedEncodedBufferBytes=0;
  snapshotRetainedWork():AppServerWriterRetainedWorkSnapshot{
    return Object.freeze({retainedWriteOperationCount:this.#retainedWriteOperationCount,
      retainedEncodedBufferBytes:this.#retainedEncodedBufferBytes,
      stdinLock:this.#locks.snapshotRetainedWork()});
  }
  constructor(input:OwnedAppServerInput|null,close:Pick<ClientCloseCoordinator,"closed"|"markClosed">){this.#input=input;this.#close=close;}
  /** Take stdin exactly once under the SAME writer lock. The owner callback must
   * shutdown and dispose the taken pipe even if shutdown fails. No future writes
   * can reuse this slot; the close coordinator must seal admission before calling. */
  async shutdownInput(shutdown:(input:OwnedAppServerInput)=>Promise<void>):Promise<void>{
    await this.#locks.run("stdin",async()=>{const input=this.#input;this.#input=null;if(input!==null)await shutdown(input);});
  }
  write<T>(value:unknown,preflight:WritePreflight<T>,writeStarted:()=>void,signal?:AbortSignal):Promise<T>{
    return this.#write(value,preflight,null,writeStarted,signal);
  }
  /** Additive off-thread preflight boundary. This does not change synchronous
   * request hooks or wire a DB adapter. The same stdin lease is retained across
   * native settlement and cleanup; cancellation never releases it early. */
  writeWithOwnedPreflight<T>(value:unknown,preflight:OwnedAsyncWritePreflight<T>,writeStarted:()=>void,signal?:AbortSignal):Promise<T>{
    return this.#write(value,null,pinOwned(preflight),writeStarted,signal);
  }
  async #write<T>(value:unknown,preflight:WritePreflight<T>|null,owned:OwnedAsyncWritePreflight<T>|null,writeStarted:()=>void,signal?:AbortSignal):Promise<T>{
    if(this.#close.closed)throw new AppServerClosedError();signal?.throwIfAborted();
    let encoded:Buffer|undefined=Buffer.from(serializeSerdeValue(value)+"\n","utf8");
    const encodedBytes=encoded.byteLength;
    this.#retainedWriteOperationCount++;this.#retainedEncodedBufferBytes+=encodedBytes;
    try{
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
      admitted=owned===null?sync(()=>preflight!.check()):await owned.check();hasAdmitted=true;
      if(owned!==null){if(this.#close.closed)throw new AppServerClosedError();signal?.throwIfAborted();owned.validate(admitted);if(this.#close.closed)throw new AppServerClosedError();}
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
      try{if(hasAdmitted&&!complete){if(owned!==null)await owned.dispose(admitted as T);else{const result=sync(()=>preflight!.dispose(admitted as T));if(result!==undefined)throw new TypeError("Preflight disposer must return void");}}}catch(error){cleanupErrors.push(error);}
      finally{lease.release();}
      if(cleanupErrors.length!==0)throw new AggregateError(failed?[primary,...cleanupErrors]:cleanupErrors,"App-server write cleanup failed");
    }
    }finally{
      encoded=undefined;
      this.#retainedWriteOperationCount--;this.#retainedEncodedBufferBytes-=encodedBytes;
    }
  }
}
