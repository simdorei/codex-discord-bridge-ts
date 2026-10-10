import * as http from 'node:http';
import * as https from 'node:https';
import type {Socket} from 'node:net';
import {requireDiscordText} from '../discord/text.ts';
import type {AttachmentResponse,AttachmentTransport} from './attachment-download.ts';
class AttachmentHttpError extends Error {constructor(text:string){super(text);this.name='AttachmentHttpError';}}
interface ResponseOwner {abort():void; release():Promise<void>}
/** Credential-free HTTP/1.1 attachment streaming. Own agents and sockets only.
 * No decompression (source reqwest features omit compression), no automatic
 * retry, no global client shutdown and no synthetic timeout. Caller closes it.
 * Proxy environments/credential URLs/HTTP2 parity are not implemented. */
export class AttachmentHttpClient implements AttachmentTransport {
 readonly #http=new http.Agent({keepAlive:true});readonly #https=new https.Agent({keepAlive:true});
 readonly #active=new Set<ResponseOwner>();readonly #sockets=new Map<Socket,Promise<void>>();#closed=false;#closing:Promise<void>|null=null;
 get activeRequests(){return this.#active.size;}get ownedSockets(){return this.#sockets.size;}
 #url(value:string,base?:URL):URL {
  requireDiscordText(value);let url:URL;try{url=new URL(value,base);}catch{throw new AttachmentHttpError('invalid attachment URL');}
  if(!['http:','https:'].includes(url.protocol)||url.username!==''||url.password!=='')throw new AttachmentHttpError('unsupported attachment URL profile');return url;
 }
 #track(socket:Socket){if(this.#sockets.has(socket)||socket.closed)return;this.#sockets.set(socket,new Promise<void>(resolve=>socket.once('close',()=>{this.#sockets.delete(socket);resolve();})));}
 async get(value:string):Promise<AttachmentResponse>{
  let url=this.#url(value);for(let redirects=0;;redirects++){
   const response=await this.#one(url);
   if([301,302,303,307,308].includes(response.status)&&response.location!==null){
    await response.release();if(redirects>=10)throw new AttachmentHttpError('attachment redirect limit exceeded');url=this.#url(response.location,url);continue;
   }
   if(response.status>=400){await response.release();throw new AttachmentHttpError(`attachment HTTP status ${response.status}`);}
   return response;
  }
 }
 async #one(url:URL):Promise<AttachmentResponse&{status:number;location:string|null}>{
  if(this.#closed)throw new AttachmentHttpError('attachment client closed');
  const tls=url.protocol==='https:';let request:http.ClientRequest;
  try{request=(tls?https:http).request(url,{method:'GET',agent:tls?this.#https:this.#http,headers:{accept:'*/*'}});}catch{throw new AttachmentHttpError('attachment request construction failed');}
  request.on('error',()=>{});request.on('socket',socket=>this.#track(socket));
  const requestClosed=new Promise<void>(r=>request.once('close',r));let incoming:http.IncomingMessage|undefined,bodyClosed:Promise<void>|undefined,disposing:Promise<void>|null=null,read=false,released=false;
  const owner:ResponseOwner={abort(){request.destroy();incoming?.destroy();},release:()=>disposing??=(async()=>{released=true;incoming?.destroy();request.destroy();await Promise.allSettled([requestClosed,...(bodyClosed?[bodyClosed]:[])]);this.#active.delete(owner);})()};
  this.#active.add(owner);
  const headers=new Promise<http.IncomingMessage>((resolve,reject)=>{
   request.once('error',()=>reject(new AttachmentHttpError('attachment request failed')));
   request.once('close',()=>{if(incoming===undefined)reject(new AttachmentHttpError('attachment request closed before headers'));});
   request.once('response',response=>{incoming=response;response.on('error',()=>{});bodyClosed=new Promise<void>(r=>{response.once('close',r);if(response.closed)r();});resolve(response);});
  });void headers.catch(()=>undefined);
  try {
   request.end();const response=await headers,status=response.statusCode;if(status===undefined)throw new AttachmentHttpError('missing attachment status');
   const raw=response.headers['content-length'];const contentLength=typeof raw==='string'&&/^[0-9]+$/.test(raw)&&BigInt(raw)<1n<<64n?BigInt(raw):null;
   const chunks=(async function*(){if(read||released)throw new AttachmentHttpError('attachment body already consumed');read=true;try{for await(const chunk of response)yield Buffer.from(chunk);}catch{throw new AttachmentHttpError('attachment response body failed');}})();
   return Object.freeze({status,location:response.headers.location??null,contentLength,chunks,release:owner.release});
  }catch(error){await owner.release();throw error;}
 }
 close():Promise<void>{
  if(this.#closing!==null)return this.#closing;this.#closed=true;for(const owner of this.#active)owner.abort();const pending=[...this.#active].map(owner=>owner.release());this.#http.destroy();this.#https.destroy();
  this.#closing=(async()=>{await Promise.allSettled(pending);await Promise.allSettled([...this.#sockets.values()]);})();return this.#closing;
 }
}
Object.freeze(AttachmentHttpClient.prototype);
