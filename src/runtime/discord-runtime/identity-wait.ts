import {BroadcastClosedError,BroadcastLaggedError} from '../../app-server/broadcast.ts';
import type {GatewayIdentity,GatewayIdentityConflict,GatewayStateReceiver} from '../../discord/gateway/identity.ts';
import {RuntimeTypedIngressError} from './receive-error-consumer.ts';
/** Structured conflict keeps both authoritative snapshots. Display is a Node
 * diagnostic, not Rust Debug formatting of twilight Id. */
export class RuntimeGatewayIdentityConflictError extends Error{readonly conflict:GatewayIdentityConflict;constructor(conflict:GatewayIdentityConflict){super('Discord gateway READY identity changed');this.name='RuntimeGatewayIdentityConflictError';this.conflict=conflict;}}
export function failOnGatewayIdentityConflict(conflict:GatewayStateReceiver<GatewayIdentityConflict|null>):void{const value=conflict.snapshot();if(value!==null)throw new RuntimeGatewayIdentityConflictError(value);}
type Changed<T>={ok:true;value:T}|{ok:false;error:unknown};
/** Borrowed subscriptions remain usable after return. Shutdown is a one-way
 * signal representing true/watch closure. Concurrent hint reads are cancelled
 * and joined, never abandoned. Sticky snapshots remain authoritative if a hint
 * was consumed by a losing read. Shutdown and conflict outrank ready identity. */
export async function waitForGatewayIdentity(identity:GatewayStateReceiver<GatewayIdentity|null>,conflict:GatewayStateReceiver<GatewayIdentityConflict|null>,shutdown:AbortSignal,force:AbortSignal):Promise<GatewayIdentity|null>{
 let wakeShutdown!:()=>void,wakeForce!:()=>void;const stopped=new Promise<void>(r=>{wakeShutdown=r;}),forced=new Promise<void>(r=>{wakeForce=r;});shutdown.addEventListener('abort',wakeShutdown,{once:true});force.addEventListener('abort',wakeForce,{once:true});
 try{for(;;){force.throwIfAborted();if(shutdown.aborted)return null;failOnGatewayIdentityConflict(conflict);const current=identity.snapshot();if(current!==null)return current;
  const reads=new AbortController(),cancel=new Error('Identity hint wait finished');let id:Changed<GatewayIdentity|null>|undefined,collision:Changed<GatewayIdentityConflict|null>|undefined;
  const identityRead=Promise.resolve().then(()=>identity.changed(reads.signal)).then(value=>{id={ok:true,value};},error=>{id={ok:false,error};});
  const conflictRead=Promise.resolve().then(()=>conflict.changed(reads.signal)).then(value=>{collision={ok:true,value};},error=>{collision={ok:false,error};});
  try{await Promise.race([identityRead,conflictRead,stopped,forced]);}finally{reads.abort(cancel);await Promise.all([identityRead,conflictRead]);}
  force.throwIfAborted();if(shutdown.aborted)return null;failOnGatewayIdentityConflict(conflict);
  if(collision!==undefined){if(collision.ok){if(collision.value!==null)throw new RuntimeGatewayIdentityConflictError(collision.value);}else if(collision.error instanceof BroadcastClosedError)throw new RuntimeTypedIngressError('Closed','identity-conflict');else if(collision.error!==cancel&&!(collision.error instanceof BroadcastLaggedError))throw collision.error;}
  if(id!==undefined){if(id.ok){if(id.value!==null)return id.value;}else if(id.error instanceof BroadcastClosedError)throw new RuntimeTypedIngressError('Closed','identity');else if(id.error!==cancel&&!(id.error instanceof BroadcastLaggedError))throw id.error;}
 }}finally{shutdown.removeEventListener('abort',wakeShutdown);force.removeEventListener('abort',wakeForce);}
}
