import http from 'node:http';
import https from 'node:https';
import {Duplex} from 'node:stream';
import {types} from 'node:util';
import WebSocket,{createWebSocketStream} from 'ws';
export type GatewaySocketMessage={readonly kind:'Text';readonly text:string}|{readonly kind:'Binary';readonly bytes:Uint8Array}|{readonly kind:'Close';readonly code:number;readonly reason:Uint8Array};
export class GatewaySocketError extends Error{constructor(message:string){super(message);this.name='GatewaySocketError';}}
export type GatewaySendFailureStage='BeforePayload'|'AfterPayload';
const sendFailures=new WeakMap<object,GatewaySendFailureStage>();
function sendFailure<T extends Error>(error:T,stage:GatewaySendFailureStage):T{sendFailures.set(error,stage);return error;}
/** Passive identity lookup: public fields, prototype copies and proxies cannot
 * forge a send-stage classification. AfterPayload means replay is unsafe, not
 * that Discord acknowledged the bytes. */
export function gatewaySendFailureStage(error:unknown):GatewaySendFailureStage|null{return error!==null&&typeof error==='object'?sendFailures.get(error)??null:null;}
export interface GatewaySocketConnectOptions{readonly signal?:AbortSignal;readonly timeoutMs?:number}
/** One WebSocket/agent/stream owner. HTTP upgrade has a ten-second default
 * deadline; all cancellation/disposal paths join actual tracked socket close.
 * Readable object mode retains message boundaries and text/binary distinction.
 * Backpressure pauses reads but, like source Limits::unlimited(), one message may
 * be arbitrarily large. This is not a total memory bound or a Discord session. */
export class NodeGatewayWebSocket{
 readonly #agent:http.Agent;readonly #sockets=new Map<Duplex,Promise<void>>();readonly #operations=new Set<Promise<unknown>>();readonly #abort=new AbortController();
 #ws:WebSocket|undefined;#stream:Duplex|undefined;#wsClosed:Promise<void>=Promise.resolve();#streamClosed:Promise<void>=Promise.resolve();#closed=false;#ended=false;#failure=false;#failureReported=false;#closeDelivered=false;#closeCode=1006;#closeReason=new Uint8Array();#reading=false;#writing=false;#disposed=false;#disposePromise:Promise<void>|undefined;
 private constructor(secure:boolean){
  this.#agent=secure?new https.Agent({keepAlive:false}):new http.Agent({keepAlive:false});
  const original=this.#agent.createConnection.bind(this.#agent);
  this.#agent.createConnection=(options,callback)=>{const socket=original(options,(error,created)=>{if(created)this.#trackSocket(created);callback?.(error,created);});if(socket)this.#trackSocket(socket);return socket;};
 }
 #trackSocket(socket:Duplex):void{if(this.#sockets.has(socket)||socket.closed)return;const closed=new Promise<void>(resolve=>{socket.once('close',()=>{this.#sockets.delete(socket);resolve();});});this.#sockets.set(socket,closed);}
 static connect(url:string,options:GatewaySocketConnectOptions={}):Promise<NodeGatewayWebSocket>{return this.#connect(url,options,false);}
 /** Test route cannot leave literal IPv4 loopback or follow redirects. No headers
  * or credentials are accepted by either transport constructor. */
 static connectForTest(url:string,options:GatewaySocketConnectOptions={}):Promise<NodeGatewayWebSocket>{return this.#connect(url,options,true);}
 static async #connect(input:string,options:GatewaySocketConnectOptions,loopback:boolean):Promise<NodeGatewayWebSocket>{
  const url=new URL(input);if(url.username||url.password||url.hash)throw new TypeError('Unsupported Gateway URL authority');
  if(loopback?url.protocol!=='ws:'||url.hostname!=='127.0.0.1':url.protocol!=='wss:'||!/^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/u.test(url.hostname)||url.port!==''&&url.port!=='443')throw new TypeError('Unsupported Gateway socket destination');
  const timeout=options.timeoutMs??10000;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>2147483647)throw new RangeError('Invalid Gateway handshake timeout');options.signal?.throwIfAborted();
  const owner=new NodeGatewayWebSocket(!loopback);try{await owner.#open(url,timeout,options.signal);return owner;}catch(error){await owner.dispose();throw error;}
 }
 async #open(url:URL,timeout:number,signal?:AbortSignal):Promise<void>{
  const ws=this.#ws=new WebSocket(url,{agent:this.#agent,handshakeTimeout:timeout,followRedirects:false,perMessageDeflate:false,maxPayload:0,maxFragments:0,maxBufferedChunks:0,allowSynchronousEvents:false});
  this.#wsClosed=new Promise<void>(resolve=>{ws.once('close',(code,reason)=>{this.#closed=true;this.#closeCode=code;this.#closeReason=new Uint8Array(reason);resolve();});});
  ws.on('error',()=>{this.#failure=true;});
  const stream=this.#stream=createWebSocketStream(ws,{readableObjectMode:true,readableHighWaterMark:1});
  this.#streamClosed=new Promise<void>(resolve=>stream.once('close',resolve));stream.on('error',()=>{this.#failure=true;});stream.once('end',()=>{this.#ended=true;});
  await new Promise<void>((resolve,reject)=>{const deadline=setTimeout(()=>{clean();reject(new GatewaySocketError('Gateway WebSocket handshake deadline exceeded'));},timeout);const clean=()=>{clearTimeout(deadline);ws.off('open',opened);ws.off('error',failed);ws.off('close',closed);signal?.removeEventListener('abort',aborted);};const opened=()=>{clean();resolve();};const failed=()=>{clean();reject(new GatewaySocketError('Gateway WebSocket handshake failed'));};const closed=()=>{clean();reject(new GatewaySocketError('Gateway WebSocket closed before open'));};const aborted=()=>{clean();reject(signal?.reason);};ws.once('open',opened);ws.once('error',failed);ws.once('close',closed);signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();});
 }
 get ownedSockets():number{return this.#sockets.size;}
 get pendingOperations():number{return this.#operations.size;}
 get disposed():boolean{return this.#disposed;}
 #track<T>(operation:Promise<T>):Promise<T>{this.#operations.add(operation);void operation.then(()=>this.#operations.delete(operation),()=>this.#operations.delete(operation));return operation;}
 receive(signal?:AbortSignal):Promise<GatewaySocketMessage|null>{if(this.#reading)return Promise.reject(new TypeError('Concurrent Gateway socket read'));if(this.#disposed)return Promise.reject(new GatewaySocketError('Gateway socket disposed'));this.#reading=true;return this.#track(this.#receive(signal));}
 async #receive(external?:AbortSignal):Promise<GatewaySocketMessage|null>{
  const signal=external===undefined?this.#abort.signal:AbortSignal.any([external,this.#abort.signal]),stream=this.#stream!;
  try{for(;;){signal.throwIfAborted();const value:unknown=stream.read();if(value!==null){if(typeof value==='string')return Object.freeze({kind:'Text',text:value});if(types.isUint8Array(value))return Object.freeze({kind:'Binary',bytes:new Uint8Array(value as Uint8Array)});throw new GatewaySocketError('Unsupported socket frame value');}
   if(this.#failure&&!this.#failureReported){this.#failureReported=true;throw new GatewaySocketError('Gateway WebSocket transport failed');}
   if(this.#closed||this.#ended){if(this.#closeDelivered)return null;this.#closeDelivered=true;return Object.freeze({kind:'Close',code:this.#closeCode,reason:new Uint8Array(this.#closeReason)});}
   await new Promise<void>((resolve,reject)=>{const cleanup=()=>{stream.off('readable',wake);stream.off('end',wake);stream.off('error',wake);stream.off('close',wake);this.#ws!.off('close',wake);signal.removeEventListener('abort',abort);};const wake=()=>{cleanup();resolve();};const abort=()=>{cleanup();reject(signal.reason);};stream.once('readable',wake);stream.once('end',wake);stream.once('error',wake);stream.once('close',wake);this.#ws!.once('close',wake);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();else if(stream.readableLength>0||this.#closed||this.#ended||this.#failure&&!this.#failureReported)wake();});
  }}finally{this.#reading=false;}
 }
 sendText(text:string):Promise<void>{if(typeof text!=='string'||/[\uD800-\uDFFF]/u.test(text))return Promise.reject(sendFailure(new TypeError('Expected valid Gateway text'),'BeforePayload'));return this.#send(text,false);}
 sendBinary(bytes:Uint8Array):Promise<void>{if(!types.isUint8Array(bytes))return Promise.reject(sendFailure(new TypeError('Expected owned Gateway bytes'),'BeforePayload'));return this.#send(Buffer.from(bytes),true);}
 #send(data:string|Buffer,binary:boolean):Promise<void>{
  if(this.#disposed||this.#ws?.readyState!==WebSocket.OPEN)return Promise.reject(sendFailure(new GatewaySocketError('Gateway socket not open'),'BeforePayload'));
  if(this.#writing)return Promise.reject(sendFailure(new TypeError('Concurrent Gateway socket write'),'BeforePayload'));
  this.#writing=true;
  return this.#track(new Promise<void>((resolve,reject)=>{
   const failed=()=>{this.#writing=false;reject(sendFailure(new GatewaySocketError('Gateway socket send failed'),'AfterPayload'));};
   try{this.#ws!.send(data,{binary},error=>{if(error)failed();else{this.#writing=false;resolve();}});}catch{failed();}
  }));
 }
 requestClose(code=1000,reason=''):void{if(typeof reason!=='string'||/[\uD800-\uDFFF]/u.test(reason))throw new TypeError('Expected valid close reason');if(this.#disposed)throw new GatewaySocketError('Gateway socket disposed');this.#ws!.close(code,reason);}
 /** ws can emit close before a cancelled upgrade's underlying socket closes.
  * Join our own agent sockets as well, then owned read/write operations. */
 dispose():Promise<void>{if(this.#disposePromise!==undefined)return this.#disposePromise;this.#disposed=true;this.#abort.abort(new GatewaySocketError('Gateway socket disposed'));this.#stream?.destroy();this.#ws?.terminate();this.#agent.destroy();this.#disposePromise=(async()=>{await Promise.allSettled([this.#wsClosed,this.#streamClosed]);this.#agent.destroy();await Promise.allSettled([...this.#sockets.values()]);await Promise.allSettled([...this.#operations]);})();return this.#disposePromise;}
}
