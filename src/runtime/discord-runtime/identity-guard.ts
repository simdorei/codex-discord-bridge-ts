import {types} from 'node:util';
import {BroadcastClosedError,BroadcastLaggedError} from '../../app-server/broadcast.ts';
import type {GatewayIdentityConflict,GatewayStateReceiver} from '../../discord/gateway/identity.ts';
import {failOnGatewayIdentityConflict,RuntimeGatewayIdentityConflictError} from './identity-wait.ts';
import {RuntimeTypedIngressError} from './receive-error-consumer.ts';
export type IdentityGuardResult<T>={readonly completed:true;readonly value:T}|{readonly completed:false};
export class RuntimeIdentityGuardCleanupError extends AggregateError{readonly primary:unknown;readonly cleanupError:unknown;constructor(primary:unknown,cleanup:unknown){super([primary,cleanup],'Identity guard failed and task cleanup also failed');this.name='RuntimeIdentityGuardCleanupError';this.primary=primary;this.cleanupError=cleanup;}}
type Outcome<T>={ok:true;value:T}|{ok:false;error:unknown};
/** Guards one actual trusted asynchronous operation. Its signal must cancel/join
 * all owned resources. Unlike dropping a Rust future, Node explicitly waits for
 * that real operation to settle on shutdown/conflict. A noncooperative operation
 * remains pending for the outer common-deadline owner to escalate. No timeout
 * wrapper claims it stopped. Subscriptions are borrowed and left usable. */
export async function guardGatewayIdentity<T>(start:(signal:AbortSignal)=>Promise<T>,conflict:GatewayStateReceiver<GatewayIdentityConflict|null>,shutdown:AbortSignal,force:AbortSignal):Promise<IdentityGuardResult<T>>{
 if(typeof start!=='function'||types.isProxy(start)||types.isGeneratorFunction(start))throw new TypeError('Expected owned identity-guard operation');force.throwIfAborted();if(shutdown.aborted)return Object.freeze({completed:false});failOnGatewayIdentityConflict(conflict);
 const initial=conflict.tryChanged();if(initial.kind==='Closed')throw new RuntimeTypedIngressError('Closed','identity-conflict');if(initial.kind==='Value'&&initial.value!==null)throw new RuntimeGatewayIdentityConflictError(initial.value);failOnGatewayIdentityConflict(conflict);
 const taskAbort=new AbortController(),readAbort=new AbortController(),cancel=new Error('Identity guard operation cancelled');let started=false;let taskResult:Outcome<T>|undefined,readResult:Outcome<GatewayIdentityConflict|null>|undefined,read:Promise<void>|undefined;
 let wakeShutdown!:()=>void,wakeForce!:()=>void;const stopped=new Promise<void>(r=>{wakeShutdown=r;}),forced=new Promise<void>(r=>{wakeForce=r;});shutdown.addEventListener('abort',wakeShutdown,{once:true});force.addEventListener('abort',wakeForce,{once:true});
 const task=Promise.resolve().then(()=>{force.throwIfAborted();if(shutdown.aborted)throw cancel;failOnGatewayIdentityConflict(conflict);started=true;const value=start(taskAbort.signal);if(!types.isPromise(value))throw new TypeError('Guard operation must return Promise');return value;}).then(value=>{taskResult={ok:true,value};},error=>{taskResult={ok:false,error};});
 const readSnapshot=():Outcome<GatewayIdentityConflict|null>|undefined=>readResult;
 let result:IdentityGuardResult<T>|undefined,failed=false,primary:unknown;
 try{for(;;){force.throwIfAborted();if(shutdown.aborted){result=Object.freeze({completed:false});break;}failOnGatewayIdentityConflict(conflict);
  if(readResult!==undefined){const changed=readResult;readResult=undefined;read=undefined;if(changed.ok){if(changed.value!==null)throw new RuntimeGatewayIdentityConflictError(changed.value);}else if(changed.error instanceof BroadcastClosedError)throw new RuntimeTypedIngressError('Closed','identity-conflict');else if(!(changed.error instanceof BroadcastLaggedError))throw changed.error;failOnGatewayIdentityConflict(conflict);}
  if(taskResult!==undefined){
   // Promise scheduling can settle operation before the already-ready broadcast
   // rejection propagates. Join/cancel that read, then synchronously poll the
   // authoritative borrowed receiver before honoring the lower-priority output.
   readAbort.abort(cancel);await read;force.throwIfAborted();if(shutdown.aborted){result=Object.freeze({completed:false});break;}failOnGatewayIdentityConflict(conflict);
   const finishedRead=readSnapshot();if(finishedRead!==undefined){if(finishedRead.ok){if(finishedRead.value!==null)throw new RuntimeGatewayIdentityConflictError(finishedRead.value);}else if(finishedRead.error instanceof BroadcastClosedError)throw new RuntimeTypedIngressError('Closed','identity-conflict');else if(finishedRead.error!==cancel&&!(finishedRead.error instanceof BroadcastLaggedError))throw finishedRead.error;}
   for(;;){const hint=conflict.tryChanged();if(hint.kind==='Closed')throw new RuntimeTypedIngressError('Closed','identity-conflict');if(hint.kind==='Value'&&hint.value!==null)throw new RuntimeGatewayIdentityConflictError(hint.value);failOnGatewayIdentityConflict(conflict);if(hint.kind==='Empty')break;}
   if(!taskResult.ok)throw taskResult.error;result=Object.freeze({completed:true,value:taskResult.value});break;
  }
  if(read===undefined)read=Promise.resolve().then(()=>conflict.changed(readAbort.signal)).then(value=>{readResult={ok:true,value};},error=>{readResult={ok:false,error};});
  await Promise.race([task,read,stopped,forced]);
 }}catch(error){failed=true;primary=error;}
 finally{shutdown.removeEventListener('abort',wakeShutdown);force.removeEventListener('abort',wakeForce);readAbort.abort(cancel);if(taskResult===undefined)taskAbort.abort(force.aborted?force.reason:cancel);await Promise.all([task,...(read===undefined?[]:[read])]);}
 // Expected cancellation is not an operational failure. A distinct cleanup error
 // is never silently discarded; preserve a conflict/force primary alongside it.
 if(started&&taskResult!==undefined&&!taskResult.ok&&!(taskAbort.signal.aborted&&taskResult.error===taskAbort.signal.reason)&&(!failed||taskResult.error!==primary)){
  if(failed)throw new RuntimeIdentityGuardCleanupError(primary,taskResult.error);throw taskResult.error;
 }
 if(failed)throw primary;return result!;
}
