import {isMainThread} from 'node:worker_threads';
import {OwnedWorkerSlot} from './owned-worker-slot.ts';

export type NativeMutationOperation='beginMutationWithOrigin'|'beginQueueMutation'|'beginStopMutation'|'finishMutation'|'finishStopMutation';

/** Internal, main-isolate persistence transport. It returns raw worker data, never
 * a durable receipt or permission to dispatch. The fixed worker and Control lane
 * preserve the existing trusted-module boundary; this is not an IPC authority API. */
export class NativeMutationTransport {
 readonly #path:string;readonly #runtime:string;readonly #timeout:number;
 readonly #tasks=new Set<Promise<unknown>>();
 readonly #controllers=new Set<AbortController>();
 readonly #admissions=new WeakMap<Promise<unknown>,boolean>();
 #closed=false;
 constructor(path:string,runtime:string,timeoutMs:number){this.#path=path;this.#runtime=runtime;this.#timeout=timeoutMs;}
 get busy():boolean{return this.#tasks.size>0;}
 /** Read only the phase sampled synchronously for this exact submission. Queued
  * completion is conservatively admitted, even if it never constructs a worker.
  * This preserves slot.busy's existing meaning, not stronger refusal provenance. */
 wasAdmitted(submission:Promise<unknown>):boolean{
  const phase=this.#admissions.get(submission);
  if(phase===undefined)throw new TypeError('Expected submission from this native mutation transport');
  return phase;
 }
 submit(operation:NativeMutationOperation,input:unknown,signal?:AbortSignal):Promise<unknown>{
  if(this.#closed)throw new Error('Native mutation transport is closed');
  const controller=new AbortController(),slot=new OwnedWorkerSlot('Control');this.#controllers.add(controller);
  const abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  let admitted=false;
  const task=(async()=>{
   try{
    if(!isMainThread)throw new TypeError('Native workers must be submitted by the main runtime owner');
    if(operation!=='beginMutationWithOrigin'&&operation!=='beginQueueMutation'&&operation!=='beginStopMutation'&&operation!=='finishMutation'&&operation!=='finishStopMutation')throw new TypeError('Expected fixed native mutation operation');
    const complete=operation==='finishMutation'||operation==='finishStopMutation';
    const data={path:this.#path,runtime:this.#runtime,operation,input};
    const pending=complete?slot.runControlCompletion(new URL('./native-mutation-worker.ts',import.meta.url),data,this.#timeout,controller.signal):slot.run(new URL('./native-mutation-worker.ts',import.meta.url),data,this.#timeout,controller.signal);
    admitted=slot.busy;
    let raw:unknown;try{raw=await pending;}finally{await slot.join();}
    controller.signal.throwIfAborted();return raw;
   }finally{signal?.removeEventListener('abort',abort);}
  })();
  // The async body has reached its first await (or synchronous failure) here.
  // Never inspect slot.busy later, after completion/exit can change it.
  this.#admissions.set(task,admitted);this.#tasks.add(task);
  const clear=()=>{this.#tasks.delete(task);this.#controllers.delete(controller);};void task.then(clear,clear);
  return task;
 }
 async close(reason:unknown=new Error('Native mutation owner closed')):Promise<void>{
  this.#closed=true;for(const controller of this.#controllers)controller.abort(reason);
  await Promise.allSettled([...this.#tasks]);
 }
}
Object.freeze(NativeMutationTransport.prototype);
