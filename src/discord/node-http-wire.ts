import {isMirrorChannelMethod} from './mirror-channel-request.ts';
import {messageComponentClearResource} from './message-component-clear-request.ts';
import {isOriginalInteractionResponsePath} from './interaction-update-request.ts';
import {isInteractionCallbackPath} from './interaction-callback-request.ts';
import {isCommandRegistrationPath} from './commands.ts';
import * as http from 'node:http';
import * as https from 'node:https';
import type {Socket} from 'node:net';
import {brotliDecompress} from 'node:zlib';
import {promisify} from 'node:util';
import type {DiscordHttpWire,DiscordWireRequest,DiscordWireResponse} from './response-engine.ts';
const decompress=promisify(brotliDecompress);
class WireError extends Error{constructor(message:string){super(message);this.name='DiscordWireError';}}
interface Active {abort():void;dispose():Promise<void>}
/** Own HTTP/1.1 agent, request/socket lifetime and Brotli body decoding. The production
 * origin is fixed to Discord v10. A credential-free literal loopback origin exists only
 * for tests; no arbitrary proxy, redirect or TLS-verification override is supported. */
export class NodeDiscordHttpWire implements DiscordHttpWire{
 readonly #base:URL;readonly #loopback:boolean;readonly #agent:http.Agent;readonly #active=new Set<Active>();readonly #sockets=new Map<Socket,Promise<void>>();#closed=false;#closing:Promise<void>|null=null;
 constructor(base='https://discord.com/api/v10/'){
  if(typeof base!=='string')throw new TypeError('Expected HTTP origin');let url:URL;try{url=new URL(base);}catch{throw new TypeError('Unsupported Discord wire origin');}
  const production=url.origin==='https://discord.com',loopback=url.protocol==='http:'&&url.hostname==='127.0.0.1';
  if((!production&&!loopback)||url.username!==''||url.password!==''||url.search!==''||url.hash!==''||url.pathname!=='/api/v10/')throw new TypeError('Unsupported Discord wire origin');
  this.#base=url;this.#loopback=loopback;this.#agent=loopback?new http.Agent({keepAlive:true}):new https.Agent({keepAlive:true});
 }
 get activeRequests():number{return this.#active.size;}
 get ownedSockets():number{return this.#sockets.size;}
 #track(socket:Socket):void{if(this.#sockets.has(socket)||socket.closed)return;const closed=new Promise<void>(resolve=>{socket.once('close',()=>{this.#sockets.delete(socket);resolve();});});this.#sockets.set(socket,closed);}
 async request(input:DiscordWireRequest,timeout:number,signal:AbortSignal):Promise<DiscordWireResponse>{
  signal.throwIfAborted();if(this.#closed)throw new WireError('HTTP wire closed');
  const {method,path,body,authorization}=input,route=typeof path==='string'?/^channels\/([1-9][0-9]{0,19})\/(messages|typing)$/u.exec(path):null;
  const gateway=method==='GET'&&path==='gateway/bot'&&body===null;
  const channel=method==='POST'&&route!==null&&route[0]===path&&BigInt(route[1]!)<(1n<<64n)&&(route[2]==='messages'?typeof body==='string':body===null)&&!(typeof body==='string'&&/[\uD800-\uDFFF]/u.test(body));
  const commands=method==='PUT'&&isCommandRegistrationPath(path)&&typeof body==='string'&&!/[\uD800-\uDFFF]/u.test(body);
  const callback=method==='POST'&&isInteractionCallbackPath(path)&&typeof body==='string'&&!/[\uD800-\uDFFF]/u.test(body)&&authorization===null;
  const update=method==='PATCH'&&isOriginalInteractionResponsePath(path)&&typeof body==='string'&&!/[\uD800-\uDFFF]/u.test(body)&&authorization===null;
  const clear=method==='PATCH'&&messageComponentClearResource(path)!==null&&body==='{"components":[]}';
  const mirror=isMirrorChannelMethod(method,path)&&(method==='GET'?body===null:typeof body==='string'&&!/[\uD800-\uDFFF]/u.test(body));
  if(!gateway&&!channel&&!commands&&!callback&&!update&&!clear&&!mirror)throw new WireError('Invalid HTTP request profile');
  if(authorization!==null&&(typeof authorization!=='string'||/[^\x20-\x7e]/u.test(authorization)))throw new WireError('Invalid HTTP authorization');
  if(this.#loopback&&authorization!==null)throw new WireError('Credentials are forbidden for loopback tests');
  if(!Number.isSafeInteger(timeout)||timeout<0||timeout>2147483647)throw new WireError('Invalid header deadline');
  const headers:http.OutgoingHttpHeaders={'user-agent':'DiscordBot (https://github.com/simdorei/codex-discord-bridge-ts, 0.0.0)','accept-encoding':'br','content-length':body===null?0:Buffer.byteLength(body)};
  if(body!==null)headers['content-type']='application/json';if(authorization!==null)headers.authorization=authorization;
  const target=new URL(path,this.#base),client=this.#loopback?http:https;
  let request:http.ClientRequest;try{request=client.request(target,{method,headers,agent:this.#agent});}catch{throw new WireError('HTTP request construction failed');}
  request.on('socket',socket=>this.#track(socket));request.on('error',()=>{});
  const requestClosed=new Promise<void>(resolve=>{request.once('close',resolve);});
  let response:http.IncomingMessage|undefined,responseClosed:Promise<void>|undefined,bodyWork:Promise<Uint8Array>|undefined,disposing:Promise<void>|undefined,read=false,released=false,headerTimer:ReturnType<typeof setTimeout>|undefined;
  const abort=()=>{const error=new WireError('HTTP request cancelled');request.destroy(error);response?.destroy(error);};
  const record:Active={abort,dispose:()=>disposing??=(async()=>{
   released=true;clearTimeout(headerTimer);
   if(response!==undefined){if(!response.readableEnded){if(response.complete&&bodyWork===undefined)response.resume();else response.destroy();}}
   else request.destroy();
   await Promise.allSettled([requestClosed,...(responseClosed?[responseClosed]:[]),...(bodyWork?[bodyWork]:[])]);
   signal.removeEventListener('abort',abort);this.#active.delete(record);
  })()};this.#active.add(record);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  const received=new Promise<http.IncomingMessage>((resolve,reject)=>{
   request.once('error',()=>reject(signal.aborted?signal.reason:new WireError('HTTP request failed')));
   request.once('response',incoming=>{clearTimeout(headerTimer);response=incoming;incoming.on('error',()=>{});responseClosed=new Promise<void>(done=>{incoming.once('close',done);if(incoming.closed)done();});resolve(incoming);});
  });
  void received.catch(()=>undefined); // Own rejection even if request.end throws synchronously.
  headerTimer=setTimeout(()=>{request.destroy(new WireError('HTTP response header deadline exceeded'));},timeout);
  try{
   request.end(body??undefined);const incoming=await received,status=incoming.statusCode;if(status===undefined)throw new WireError('Missing HTTP status');
   const values=new Map<string,Uint8Array>();for(let i=0;i<incoming.rawHeaders.length;i+=2){const name=incoming.rawHeaders[i]!.toLowerCase();if(!values.has(name))values.set(name,Buffer.from(incoming.rawHeaders[i+1]!,'latin1'));}
   const compressed=values.has('content-encoding');
   return Object.freeze({status,headers:values,bytes:()=>{
    if(released||read)return Promise.reject(new WireError('Response body ownership already consumed'));read=true;
    bodyWork=(async()=>{try{const chunks:Buffer[]=[];for await(const chunk of incoming)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks);return compressed?await decompress(bytes):bytes;}catch{throw signal.aborted?signal.reason:new WireError('HTTP response body could not be read');}})();return bodyWork;
   },release:()=>record.dispose()});
  }catch(error){await record.dispose();throw signal.aborted?signal.reason:error;}
 }
 /** Agent/socket cleanup is explicit and joined; caller must also close its response
  * engine/rate owner. No global Node agent or unrelated connection is destroyed. */
 close():Promise<void>{if(this.#closing!==null)return this.#closing;this.#closed=true;for(const record of this.#active)record.abort();const pending=[...this.#active].map(r=>r.dispose());this.#agent.destroy();this.#closing=(async()=>{await Promise.allSettled(pending);this.#agent.destroy();await Promise.allSettled([...this.#sockets.values()]);})();return this.#closing;}
}
