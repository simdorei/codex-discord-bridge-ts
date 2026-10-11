import {NodeGatewayWebSocket,type GatewaySocketConnectOptions} from '../discord/gateway/node-websocket.ts';
import {SecretToken} from '../config/remote.ts';
import {RemoteTextReader} from './frame-reader.ts';
/** Concrete remote transport over the shared owned socket engine. ws owns
 * automatic pong writes; they do not enter the JSON decoding lane. The remote
 * profile caps each inbound message at12MB and uses stream backpressure. This
 * does not certify a total process memory bound, dispatcher or session authority. */
export class NodeRemoteWebSocket{
 readonly #socket:NodeGatewayWebSocket;readonly #reader:RemoteTextReader;
 private constructor(socket:NodeGatewayWebSocket){
  this.#socket=socket;
  this.#reader=new RemoteTextReader(async signal=>{const frame=await socket.receive(signal);if(frame===null)return null;if(frame.kind==='Text')return {type:'text',text:frame.text};return {type:frame.kind==='Binary'?'binary':'close'};},async()=>{throw new TypeError('Pong ownership belongs to the native socket');});
 }
 static async connect(url:string,token:SecretToken,options:GatewaySocketConnectOptions={}):Promise<NodeRemoteWebSocket>{return new NodeRemoteWebSocket(await NodeGatewayWebSocket.connectRemote(url,token,options));}
 get ownedSockets():number{return this.#socket.ownedSockets;}
 get pendingOperations():number{return this.#socket.pendingOperations;}
 get disposed():boolean{return this.#socket.disposed;}
 receive(waitingForHello:boolean,signal?:AbortSignal):Promise<string|null>{return this.#reader.receiveText(waitingForHello,signal);}
 async send(text:string,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();let cleanup:Promise<void>|undefined;const abort=()=>{cleanup=this.#socket.dispose();};signal?.addEventListener('abort',abort,{once:true});
  try{if(signal?.aborted){abort();throw signal.reason;}await this.#socket.sendText(text);signal?.throwIfAborted();}
  catch(error){if(signal?.aborted)throw signal.reason;throw error;}
  finally{signal?.removeEventListener('abort',abort);if(cleanup!==undefined)await cleanup;}
 }
 dispose():Promise<void>{return this.#socket.dispose();}
}
Object.freeze(NodeRemoteWebSocket.prototype);
