import type {ResponseCustodyScope} from '../store/response-custody.ts';
import {OwnedWorkerSlot} from './owned-worker-slot.ts';

/** Internal same-isolate job, not an IPC schema or execution authority. */
export interface NativeResponseCompletionJob {
 readonly requestId:string;
 readonly scope:ResponseCustodyScope;
 readonly authority:unknown;
 readonly payload:unknown;
 readonly outcome:'flushed'|'not_sent';
}
interface Prepared {readonly slot:OwnedWorkerSlot;used:boolean}
/** Fixed post-effect scheduler. Constructor values are validated and pinned by
 * the original owner. No receipt, refusal proof or replay permission escapes. */
export class NativeResponseCompletionTransport {
 readonly #path:string;readonly #timeout:number;
 readonly #prepared=new WeakMap<object,Prepared>();
 readonly #tasks=new Set<Promise<unknown>>();#closed=false;
 constructor(path:string,timeoutMs:number){this.#path=path;this.#timeout=timeoutMs;}
 prepare():object{
  // Preserve the owner's synchronous slot-allocation stage even after close.
  // Abandoned handles hold no native work and have no strong lifetime registry.
  const slot=new OwnedWorkerSlot('Control'),handle=Object.freeze({});
  this.#prepared.set(handle,{slot,used:false});return handle;
 }
 submit(handle:object,job:NativeResponseCompletionJob,signal:AbortSignal):Promise<unknown>{
  const prepared=this.#prepared.get(handle);
  if(prepared===undefined||prepared.used)throw new TypeError('Expected unused response completion transport handle');
  prepared.used=true;
  if(this.#closed)throw new TypeError('Native response completion transport is closed');
  const slot=prepared.slot;
  const task=(async()=>{
   try{
    // No asynchronous hop precedes the original fixed Control submission.
    return await slot.runControlCompletion(new URL('./native-response-completion-worker.ts',import.meta.url),{
     path:this.#path,requestId:job.requestId,scope:job.scope,authority:job.authority,payload:job.payload,outcome:job.outcome,
    },this.#timeout,signal);
   }finally{await slot.join();}
  })();
  this.#tasks.add(task);const clear=()=>{this.#tasks.delete(task);};void task.then(clear,clear);return task;
 }
 async close():Promise<void>{this.#closed=true;await Promise.allSettled([...this.#tasks]);}
}
