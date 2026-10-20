import type {Worker} from 'node:worker_threads';
import {storeWorkerClassification,storeWorkerPath} from './store-worker-manifest.ts';
import {hasReusableWorkerOperation} from './reusable-worker-operations.ts';

// Only entries whose complete operation and cleanup are inside
// serveReusableWorker may be kept alive. Other native effects remain one-shot.
const extension=import.meta.url.endsWith('.js')?'.js':'.ts';
export interface ReusableWorkerRequest{readonly key:string;readonly url:URL;readonly input:{entry:string;input:unknown;path:string|null};}
export function reusableWorkerRequest(url:URL,input:unknown):ReusableWorkerRequest|undefined{
 if(!hasReusableWorkerOperation(url))return undefined;
 const field=storeWorkerClassification(url);if(field===undefined)throw new Error('Reusable worker is absent from the native manifest');
 const path=field===null?null:storeWorkerPath(input,field),dispatcher=new URL('./reusable-'+(field===null?'read':'store')+'-worker'+extension,import.meta.url);
 return {key:JSON.stringify([dispatcher.href,path]),url:dispatcher,input:{entry:url.href,input,path}};
}
/** Preserve the single-module cache key for an already running v1 installer.
 * The shared dispatcher uses ReusableWorkerRequest.key instead. */
export function reusableWorkerKey(url:URL,input:unknown):string|undefined{const request=reusableWorkerRequest(url,input);return request===undefined?undefined:JSON.stringify([url.href,request.input.path]);}

interface Request{
 readonly sequence:number;readonly resolve:(value:unknown)=>void;readonly reject:(reason:unknown)=>void;
 readonly joined:()=>void;readonly cleanup:()=>void;settled:boolean;
}
/** One actual native lifetime. Idle entries stay warm for the runtime lifetime,
 * like resident Rust tasks; the finite lane cap still evicts mismatched entries. A successful operation can release its caller
 * after the handler's scoped cleanup, but the pool retains its physical lane
 * and store registration until native exit. Abort/timeout retires the worker;
 * joining that request then waits for actual exit, including a blocked DB call. */
export class ReusableNativeWorker{
 readonly exited:Promise<void>;readonly worker:Worker;
 readonly #idle:()=>void;readonly #onExit:()=>void;readonly #onRetire:()=>void;
 #request:Request|undefined;#sequence=-1;#retiring=false;#exited=false;#failure:unknown;
 constructor(worker:Worker,callbacks:{idle:()=>void;exit:()=>void;retire:()=>void}){
  this.worker=worker;this.#idle=callbacks.idle;this.#onExit=callbacks.exit;this.#onRetire=callbacks.retire;
  let exited!:()=>void;this.exited=new Promise<void>(resolve=>{exited=resolve;});
  worker.on('message',(raw:unknown)=>{
   const request=this.#request;
   if(this.#retiring&&request?.settled)return;
   if(request===undefined||raw===null||typeof raw!=='object'||Object.keys(raw).length!==2||Reflect.get(raw,'sequence')!==request.sequence||!Object.hasOwn(raw,'value')){
    this.#fail(new Error('Reusable native worker returned an invalid or late reply'));return;
   }
   this.#settle(request,undefined,Reflect.get(raw,'value'));
   if(!this.#retiring){this.#request=undefined;request.joined();this.#idle();}
  });
  worker.on('error',error=>{this.#failure=error;this.#fail(error);});
  worker.once('exit',code=>{
   this.#exited=true;
   const request=this.#request;this.#request=undefined;
   if(request!==undefined){this.#settle(request,this.#failure??new Error(`Reusable native worker exited before completion (${code})`));request.joined();}
   this.#onExit();exited();
  });
 }
 get retiring():boolean{return this.#retiring||this.#exited;}
 reserve():void{if(this.retiring||this.#request!==undefined)throw new Error('Reusable native worker is unavailable');}
 run(input:unknown,timeoutMs:number,timeout:()=>Error,signal?:AbortSignal):{result:Promise<unknown>;joined:Promise<void>}{
  if(this.retiring||this.#request!==undefined)throw new Error('Reusable native worker is unavailable');
  const sequence=++this.#sequence;
  let join!:()=>void;const joined=new Promise<void>(resolve=>{join=resolve;});
  const result=new Promise<unknown>((resolve,reject)=>{
   const abort=()=>this.#fail(signal!.reason),timer=setTimeout(()=>this.#fail(timeout()),timeoutMs);
   this.#request={sequence,resolve,reject,joined:join,settled:false,cleanup:()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);}};
   signal?.addEventListener('abort',abort,{once:true});
   // The first operation is already in Worker.workerData; never submit it twice.
   if(sequence!==0)try{this.worker.postMessage({sequence,input});}catch(error){this.#fail(error);}
   if(signal?.aborted)abort();
  });
  return {result,joined};
 }
 #settle(request:Request,error:unknown,value?:unknown):void{
  if(request.settled)return;request.settled=true;request.cleanup();
  if(error!==undefined)request.reject(error);else request.resolve(value);
 }
 #fail(error:unknown):void{if(this.#request!==undefined)this.#settle(this.#request,error);this.retire();}
 retire():void{
  if(this.retiring)return;this.#retiring=true;this.#onRetire();
  // Never terminate a worker that could be inside a database transaction.
  try{this.worker.postMessage({close:true});}catch(error){this.#failure??=error;}
 }
}

export class OwnedWorkerReusePool{
 readonly entries=new Set<ReusableNativeWorker>();closing=false;started=0;reused=0;
 add(entry:ReusableNativeWorker):void{if(this.closing)throw new Error('Native worker pool is closing');this.entries.add(entry);this.started++;}
 async close():Promise<void>{this.closing=true;const entries=[...this.entries];for(const entry of entries)entry.retire();await Promise.all(entries.map(entry=>entry.exited));}
}
