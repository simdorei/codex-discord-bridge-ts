import {types} from 'node:util';
import {BoundedRemoteWorkers,RemoteWorkerJoinBusyError} from './bounded-workers.ts';
import type {RemoteWorkerResult} from './bounded-workers.ts';

export class RemoteConnectionClosedError extends Error {
 constructor(){super('Remote connection no longer accepts work');this.name='RemoteConnectionClosedError';}
}
export type RemoteConnectionOutcome = {readonly ok:true}|{readonly ok:false;readonly error:unknown};

/** Borrowed-dispatcher custody only. Commands receive one connection cancellation
 * signal and the original generation. Shutdown requests cancellation, then waits
 * for every accepted operation to actually settle. It never invents termination.
 * Raw failures are retained for the outer bridge error mapper. No socket, session
 * authorization, result serialization, retry, or retire_sessions is performed. */
export class RemoteConnectionWorkers<T> {
 readonly #workers:BoundedRemoteWorkers<T>;
 readonly #cancel=new AbortController();
 readonly #generation:bigint;
 #closed=false;
 #collector:Promise<RemoteWorkerResult<T>|null>|null=null;
 #readiness:Promise<boolean>|null=null;
 #drain:Promise<RemoteConnectionOutcome>|null=null;
 constructor(generation:bigint,maxActive=4,maxPending=16,maxBytes=4194304){
  if(typeof generation!=='bigint'||generation<0n||generation>18446744073709551615n)throw new RangeError('Invalid connection generation');
  this.#generation=generation;this.#workers=new BoundedRemoteWorkers(maxActive,maxPending,maxBytes);
 }
 snapshot(){return Object.freeze({...this.#workers.snapshot(),closed:this.#closed,cancelled:this.#cancel.signal.aborted,generation:this.#generation});}
 submit(operation:(generation:bigint,cancelled:AbortSignal)=>Promise<T>,retainedBytes:number):void{
  if(this.#closed)throw new RemoteConnectionClosedError();
  if(typeof operation!=='function'||types.isProxy(operation)||types.isGeneratorFunction(operation))throw new TypeError('Expected owned connection operation');
  this.#workers.submit(()=>operation(this.#generation,this.#cancel.signal),retainedBytes);
 }
 joinNext():Promise<RemoteWorkerResult<T>|null>{
  if(this.#closed)return Promise.reject(new RemoteConnectionClosedError());
  if(this.#collector!==null||this.#readiness!==null)return Promise.reject(new RemoteWorkerJoinBusyError());
  const collected=this.#workers.joinNext();
  this.#collector=collected;
  void collected.then(()=>{if(this.#collector===collected)this.#collector=null;},()=>{if(this.#collector===collected)this.#collector=null;});
  return collected;
 }
 /** Non-consuming readiness for event selection; capacity is retained until
  * the single owning coordinator selects and takes the completed result. */
 waitReady():Promise<boolean>{
  if(this.#closed)return Promise.reject(new RemoteConnectionClosedError());
  if(this.#collector!==null||this.#readiness!==null)return Promise.reject(new RemoteWorkerJoinBusyError());
  const ready=this.#workers.waitReady();this.#readiness=ready;
  void ready.then(()=>{if(this.#readiness===ready)this.#readiness=null;},()=>{if(this.#readiness===ready)this.#readiness=null;});
  return ready;
 }
 takeReady():RemoteWorkerResult<T>|null{
  if(this.#closed)throw new RemoteConnectionClosedError();
  if(this.#collector!==null||this.#readiness!==null)throw new RemoteWorkerJoinBusyError();
  return this.#workers.takeReady();
 }
 /** First close owns its outcome. Later close calls join that same drain. */
 close(previousError?:unknown):Promise<RemoteConnectionOutcome>{
  if(this.#drain!==null)return this.#drain;
  this.#closed=true;
  // Install the shared promise before abort listeners can re-enter close().
  let resolve!:(outcome:RemoteConnectionOutcome)=>void;
  this.#drain=new Promise(r=>{resolve=r;});
  const pendingCollector=this.#collector,pendingReadiness=this.#readiness;
  const initial:RemoteConnectionOutcome=arguments.length===0?{ok:true}:{ok:false,error:previousError};
  this.#cancel.abort(new RemoteConnectionClosedError());
  void this.#collectAll(initial,pendingCollector,pendingReadiness).then(resolve);
  return this.#drain;
 }
 async #collectAll(initial:RemoteConnectionOutcome,pending:Promise<RemoteWorkerResult<T>|null>|null,readiness:Promise<boolean>|null):Promise<RemoteConnectionOutcome>{
  let outcome=initial;
  const note=(value:RemoteWorkerResult<T>|null)=>{if(value!==null&&!value.ok&&outcome.ok)outcome={ok:false,error:value.error};};
  // No external collector can start after closed. An already waiting collector
  // is joined first, so no result is lost and joinNext is never called twice.
  if(readiness!==null){try{await readiness;}catch(error){if(outcome.ok)outcome={ok:false,error};}}
  if(pending!==null){try{note(await pending);}catch(error){if(outcome.ok)outcome={ok:false,error};}}
  while(!this.#workers.isEmpty())note(await this.#workers.joinNext());
  return Object.freeze(outcome);
 }
}
Object.freeze(RemoteConnectionWorkers.prototype);
