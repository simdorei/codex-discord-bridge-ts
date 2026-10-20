import {types} from 'node:util';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {SecretToken} from '../config/remote.ts';
import {NodeRemoteWebSocket} from './node-websocket.ts';
import {RemoteAgentStatus} from './agent-state.ts';
import {serveRemoteConnection,type RemoteConnectionPorts} from './connection-lifecycle.ts';
export interface RemoteSocketConfiguration{readonly bridgeUrl:string;readonly deviceToken:SecretToken;readonly deviceId:string;}
export type RemoteDispatcherPorts=Pick<RemoteConnectionPorts,'beginConnection'|'retireSessions'|'execute'>;
/** Concrete opening -> protocol10 serve/drain/retire -> actual socket disposal.
 * The dispatcher remains an explicit caller-owned port, not an implementation of
 * local project authority. Its accepted operations must join before retirement.
 * One-way shutdown also cancels hello; see serveRemoteConnection's adapter scope. */
export async function connectAndServeRemote(config:RemoteSocketConfiguration,dispatcher:RemoteDispatcherPorts,generation:bigint,status:RemoteAgentStatus,shutdown:AbortSignal):Promise<void>{
 const url=own(config,'bridgeUrl'),device=own(config,'deviceId'),token=own(config,'deviceToken');requireDiscordText(url);requireDiscordText(device);
 if(typeof generation!=='bigint'||generation<0n||generation>18446744073709551615n)throw new RangeError('Invalid remote generation');
 if(types.isProxy(status))throw new TypeError('Expected owned remote status');RemoteAgentStatus.prototype.snapshot.call(status);
 if(types.isProxy(shutdown)||!(shutdown instanceof AbortSignal))throw new TypeError('Expected owned remote stop signal');
 const begin=own(dispatcher,'beginConnection'),retire=own(dispatcher,'retireSessions'),execute=own(dispatcher,'execute');
 for(const fn of [begin,retire,execute])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned remote dispatcher port');
 let socket:NodeRemoteWebSocket|undefined;
 try{
  if(shutdown.aborted)return;
  try{socket=await NodeRemoteWebSocket.connect(url,token as SecretToken,{signal:shutdown});}
  catch(error){if(shutdown.aborted&&error===shutdown.reason)return;throw error;}
  const wire=socket;
  await serveRemoteConnection(device,generation,status,{
   beginConnection:g=>Reflect.apply(begin as Function,dispatcher,[g]),
   retireSessions:()=>Reflect.apply(retire as Function,dispatcher,[]),
   execute:(command,g,signal)=>Reflect.apply(execute as Function,dispatcher,[command,g,signal]),
   receive:(hello,signal)=>wire.receive(hello,signal),send:(text,signal)=>wire.send(text,signal)
  },shutdown);
 }finally{try{await socket?.dispose();}finally{RemoteAgentStatus.prototype.setDisconnected.call(status);}}
}
