import {types} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {RemoteAgentStatus,nextRemoteGeneration} from './agent-state.ts';
export type RemoteDisconnect=Readonly<{generation:bigint;ok:true}>|Readonly<{generation:bigint;ok:false;error:unknown}>;
export interface RemoteAgentLoopPorts {
 /** Owns socket opening, serve/drain and retirement; must settle actual accepted
  * work before resolving/rejecting. The same dispatcher is retained by closure. */
 readonly connectAndServe:(generation:bigint,status:RemoteAgentStatus,shutdown:AbortSignal)=>Promise<void>;
 /** Diagnostic sink only. Raw failure is retained without coercion. A sink
  * failure stops this adapter, rather than creating an unobserved retry loop. */
 readonly disconnected:(event:RemoteDisconnect)=>Promise<void>;
}
class RemoteRunnerPortContractError extends TypeError {constructor(){super('Remote runner port must return a Promise');this.name='RemoteRunnerPortContractError';}}
function promise<T>(v:unknown):Promise<T>{if(!types.isPromise(v))throw new RemoteRunnerPortContractError();return v as Promise<T>;}
function fn<T>(ports:unknown,key:string):T{const v=own(ports,key);if(typeof v!=='function'||types.isProxy(v)||types.isGeneratorFunction(v))throw new TypeError('Expected owned remote runner port');return v as T;}
function signal(value:AbortSignal):void{if(types.isProxy(value)||!(value instanceof AbortSignal))throw new TypeError('Expected owned remote shutdown signal');}
function seconds(value:bigint):void{if(typeof value!=='bigint'||value<0n||value>18446744073709551615n)throw new RangeError('Invalid remote reconnect delay');}
/** One-way shutdown adapter. Large u64 delays are chunked to safe Node timer
 * ranges against a monotonic deadline, never truncated to a 1ms busy loop.
 * This does not emulate Tokio watch false updates or channel disappearance. */
export async function waitRemoteReconnect(delaySeconds:bigint,shutdown:AbortSignal):Promise<boolean>{
 seconds(delaySeconds);signal(shutdown);if(shutdown.aborted)return true;
 const end=process.hrtime.bigint()+delaySeconds*1000000000n;
 do{
  const remaining=end-process.hrtime.bigint(),ms=remaining<=0n?0n:(remaining+999999n)/1000000n;
  try{await sleep(Number(ms>2147483647n?2147483647n:ms),undefined,{signal:shutdown});}
  catch(error){if(shutdown.aborted)return true;throw error;}
  if(shutdown.aborted)return true;
 }while(process.hrtime.bigint()<end);
 return false;
}
/** Sequential reconnect owner. Generation starts at1 and saturates at u64 MAX.
 * A new attempt cannot start until the prior owned serve/drain has settled.
 * Authentication/socket creation and managed restore/prepare remain outside
 * this adapter. Status is disconnected before diagnostics and reconnect wait. */
export async function runRemoteAgentLoop(delaySeconds:bigint,status:RemoteAgentStatus,ports:RemoteAgentLoopPorts,shutdown:AbortSignal):Promise<void>{
 seconds(delaySeconds);signal(shutdown);if(types.isProxy(status))throw new TypeError('Expected owned remote status');RemoteAgentStatus.prototype.snapshot.call(status);
 const connect=fn<RemoteAgentLoopPorts['connectAndServe']>(ports,'connectAndServe'),disconnected=fn<RemoteAgentLoopPorts['disconnected']>(ports,'disconnected');let generation=0n;
 try{
  while(!shutdown.aborted){
   generation=nextRemoteGeneration(generation);let outcome:RemoteDisconnect=Object.freeze({generation,ok:true});
   try{await promise<void>(connect(generation,status,shutdown));}catch(error){if(error instanceof RemoteRunnerPortContractError)throw error;outcome=Object.freeze({generation,ok:false,error});}
   RemoteAgentStatus.prototype.setDisconnected.call(status);if(shutdown.aborted)return;
   await promise<void>(disconnected(outcome));
   if(await waitRemoteReconnect(delaySeconds,shutdown))return;
  }
 }finally{RemoteAgentStatus.prototype.setDisconnected.call(status);}
}
