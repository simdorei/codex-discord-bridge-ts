import {types} from 'node:util';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {RemoteAgentStatus} from './agent-state.ts';
import {RemoteFrameError} from './frame-reader.ts';
import {runRemoteCommandLoop} from './command-loop.ts';
import type {RemoteCommandLoopPorts} from './command-loop.ts';
import {decodeGatewayMessageOffThread,serializeBridgeMessageOffThread} from './native-decode.ts';
export interface RemoteConnectionPorts {
 readonly beginConnection:(generation:bigint)=>Promise<void>;
 readonly retireSessions:()=>Promise<void>;
 readonly receive:(waitingForHello:boolean,signal:AbortSignal)=>Promise<string|null>;
 readonly send:RemoteCommandLoopPorts['send'];
 readonly execute:RemoteCommandLoopPorts['execute'];
}
export class RemoteBridgeLifecycleError extends Error {
 readonly kind:'MissingHelloAck'|'Generation';readonly phase:'begin'|'retire'|null;readonly previous:unknown;
 constructor(kind:RemoteBridgeLifecycleError['kind'],phase:RemoteBridgeLifecycleError['phase']=null,cause?:unknown,previous?:unknown){
  super(kind==='MissingHelloAck'?'the gateway did not acknowledge the bridge hello':'local bridge generation error'+(typeof cause==='string'?': '+cause:''),{cause});this.name='RemoteBridgeLifecycleError';this.kind=kind;this.phase=phase;this.previous=previous;
 }
}
function promise<T>(value:unknown):Promise<T>{if(!types.isPromise(value))throw new TypeError('Owned connection port must return a Promise');return value as Promise<T>;}
function port<T>(input:unknown,key:string):T{const value=own(input,key);if(typeof value!=='function'||types.isProxy(value)||types.isGeneratorFunction(value))throw new TypeError('Expected owned connection port');return value as T;}

/** Owns begin -> hello/ack -> commands/drain -> retire -> disconnected. Borrowed
 * ports still supply the real socket and dispatcher; no token or session is
 * manufactured here. One-way shutdown also cancels handshake I/O as an explicit
 * adapter safety extension: source serve_inner itself does not select shutdown
 * during hello. Accepted I/O/native work must actually settle before retirement.
 * Pre-aborted entry creates no connection generation or retirement side effect. */
export async function serveRemoteConnection(deviceId:string,generation:bigint,status:RemoteAgentStatus,ports:RemoteConnectionPorts,shutdown:AbortSignal,maxBytes=12000000):Promise<void>{
 requireDiscordText(deviceId);
 if(typeof generation!=='bigint'||generation<0n||generation>18446744073709551615n)throw new RangeError('Invalid connection generation');
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>12000000||deviceId.length>maxBytes)throw new RangeError('Invalid remote connection frame budget');
 if(types.isProxy(status))throw new TypeError('Expected owned remote status');RemoteAgentStatus.prototype.snapshot.call(status);
 if(types.isProxy(shutdown)||!(shutdown instanceof AbortSignal))throw new TypeError('Expected owned shutdown signal');
 const begin=port<RemoteConnectionPorts['beginConnection']>(ports,'beginConnection'),retire=port<RemoteConnectionPorts['retireSessions']>(ports,'retireSessions'),receive=port<RemoteConnectionPorts['receive']>(ports,'receive'),send=port<RemoteConnectionPorts['send']>(ports,'send'),execute=port<RemoteConnectionPorts['execute']>(ports,'execute');
 if(shutdown.aborted){RemoteAgentStatus.prototype.setDisconnected.call(status);return;}
 let previous:unknown;
 try{
  try{await promise<void>(begin(generation));}catch(error){throw new RemoteBridgeLifecycleError('Generation','begin',error);}
  const hello=Object.freeze({type:'hello' as const,protocol_version:10n as const,device_id:deviceId});
  const wire=await serializeBridgeMessageOffThread(hello,maxBytes,shutdown);await promise<void>(send(wire,shutdown));
  const raw=await promise<string|null>(receive(true,shutdown));shutdown.throwIfAborted();
  if(raw===null)throw new RemoteFrameError('ClosedBeforeHello');
  const ack=await decodeGatewayMessageOffThread(raw,maxBytes,shutdown);
  if(ack.type!=='hello_ack')throw new RemoteBridgeLifecycleError('MissingHelloAck');
  RemoteAgentStatus.prototype.setConnected.call(status,generation);
  await runRemoteCommandLoop(generation,{receive:signal=>receive(false,signal),send,execute},shutdown,maxBytes);
 }catch(error){
  previous=error;if(!(shutdown.aborted&&error===shutdown.reason))throw error;
 }finally{
  try{await promise<void>(retire());}
  catch(error){throw new RemoteBridgeLifecycleError('Generation','retire',error,previous);}
  finally{RemoteAgentStatus.prototype.setDisconnected.call(status);}
 }
}
