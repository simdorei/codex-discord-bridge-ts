import {types} from 'node:util';
export class RemoteWorkerCapacityError extends Error{constructor(){super('the local bridge worker queue is full');this.name='RemoteWorkerCapacityError';}}
export class RemoteWorkerJoinBusyError extends Error{constructor(){super('A remote worker result collector is already waiting');this.name='RemoteWorkerJoinBusyError';}}
export type RemoteWorkerResult<T>={readonly ok:true;readonly value:T}|{readonly ok:false;readonly error:unknown};
type Job<T>={operation:()=>Promise<T>;bytes:number};
type Completed<T>={result:RemoteWorkerResult<T>;bytes:number};
/** Source JoinSet/semaphore accounting: at most four active and sixteen total,
 * including completed but uncollected results. A finite declared payload-byte
 * budget is additional admission, not heap accounting. No timers, extra worker
 * threads, retries or synthetic cancellation. A disconnect owner must cancel its
 * operation signals and collect every accepted result before releasing custody. */
export class BoundedRemoteWorkers<T>{
 readonly #maxActive:number;readonly #maxPending:number;readonly #maxBytes:number;
 #active=0;#pending=0;#bytes=0;#waiting:Job<T>[]=[];#completed:Completed<T>[]=[];
 #joiner:{deliver:()=>void}|null=null;
 constructor(maxActive=4,maxPending=16,maxBytes=4194304){
  if(!Number.isSafeInteger(maxActive)||maxActive<1||maxActive>4||!Number.isSafeInteger(maxPending)||maxPending<maxActive||maxPending>16||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4194304)throw new RangeError('Invalid remote worker capacity');
  this.#maxActive=maxActive;this.#maxPending=maxPending;this.#maxBytes=maxBytes;
 }
 snapshot(){return Object.freeze({active:this.#active,waiting:this.#waiting.length,completed:this.#completed.length,pending:this.#pending,retainedBytes:this.#bytes});}
 isEmpty():boolean{return this.#pending===0;}
 submit(operation:()=>Promise<T>,retainedBytes:number):void{
  if(typeof operation!=='function'||types.isProxy(operation)||types.isGeneratorFunction(operation))throw new TypeError('Expected owned remote operation');
  if(!Number.isSafeInteger(retainedBytes)||retainedBytes<0||retainedBytes>this.#maxBytes)throw new RangeError('Invalid declared command byte size');
  if(this.#pending>=this.#maxPending||this.#bytes+retainedBytes>this.#maxBytes)throw new RemoteWorkerCapacityError();
  this.#pending++;this.#bytes+=retainedBytes;this.#waiting.push({operation,bytes:retainedBytes});this.#pump();
 }
 #pump():void{
  while(this.#active<this.#maxActive&&this.#waiting.length>0){
   const job=this.#waiting.shift()!;this.#active++;
   Promise.resolve().then(()=>{const value=job.operation();if(!types.isPromise(value))throw new TypeError('Remote operation must return a Promise');return value;}).then(value=>this.#finish({ok:true,value},job.bytes),error=>this.#finish({ok:false,error},job.bytes));
  }
 }
 #finish(result:RemoteWorkerResult<T>,bytes:number):void{
  this.#active--;this.#completed.push({result:Object.freeze(result),bytes});this.#joiner?.deliver();this.#pump();
 }
 #take():RemoteWorkerResult<T>{
  const done=this.#completed.shift()!;this.#pending--;this.#bytes-=done.bytes;return done.result;
 }
 /** Aborting the wait never cancels the operation or releases its accounting. */
 async joinNext(signal?:AbortSignal):Promise<RemoteWorkerResult<T>|null>{
  signal?.throwIfAborted();if(this.#joiner!==null)throw new RemoteWorkerJoinBusyError();
  if(this.#completed.length>0)return this.#take();if(this.#pending===0)return null;
  return new Promise((resolve,reject)=>{
   const clean=()=>{signal?.removeEventListener('abort',abort);this.#joiner=null;};
   const abort=()=>{clean();reject(signal!.reason);};
   this.#joiner={deliver:()=>{clean();resolve(this.#take());}};
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
 }
}
Object.freeze(BoundedRemoteWorkers.prototype);
