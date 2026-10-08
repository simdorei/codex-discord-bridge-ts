import {slashCommandRegistrationRequest} from './commands.ts';
import {decodeDiscordGatewayBotInfoBytes,DiscordGatewayModelError,type DiscordGatewayBotInfo} from './model/gateway-info.ts';
import {setImmediate as yieldToRuntime} from 'node:timers/promises';
import {types} from 'node:util';
import {invokeSynchronousVoid} from '../core/synchronous-void.ts';
import {parseDiscordApiError} from './api-error.ts';
import type {IdempotentMessageRequest} from './idempotent-message.ts';
import {DiscordTransportFault} from './transport-fault.ts';
import type {DiscordReceiptTransport} from '../runtime/completion/receipt-sender.ts';
import type {TypingTransport} from '../runtime/completion/typing.ts';
export type DiscordHttpMethod='POST'|'GET'|'PUT';
export interface DiscordWireRequest{readonly method:DiscordHttpMethod;readonly path:string;readonly body:string|null;readonly authorization:string|null}
/** Response/body/decompression/socket custody belongs to this trusted adapter. release
 * must cancel/drain and settle owned IO, even when the caller did not read the body. */
export interface DiscordWireResponse{readonly status:number;readonly headers:ReadonlyMap<string,Uint8Array>;bytes():Promise<Uint8Array>;release():Promise<void>}
export interface DiscordHttpWire{request(input:DiscordWireRequest,headerTimeoutMs:number,signal:AbortSignal):Promise<DiscordWireResponse>}
/** One shared rate limiter for the entire client. complete consumes the response's
 * header update and permits further queued work; release is idempotent fallback for
 * pre-response failures, not a second grant or a delay until body decoding finishes. */
export interface DiscordRatePermit{complete(status:number,headers:ReadonlyMap<string,Uint8Array>):void;release():void}
export interface DiscordRateLimiter{acquire(method:DiscordHttpMethod,path:string,signal:AbortSignal):Promise<DiscordRatePermit>}
/** Mandatory complete twilight Message-compatible decoder, not an id-only JSON probe.
 * Its full implementation/qualification is separate; there is no permissive default. */
export interface DiscordMessageDecoder{decode(body:Uint8Array):bigint}
const transport=()=>new DiscordTransportFault('Transport','request outcome is unconfirmed');
function channel(value:bigint):string{if(typeof value!=='bigint'||value<=0n||value>=(1n<<64n))throw new DiscordTransportFault('Validation','invalid channel identity');return value.toString();}
function own(input:IdempotentMessageRequest,key:string):unknown{if(input===null||typeof input!=='object'||types.isProxy(input))throw new DiscordTransportFault('BuildingRequest','invalid request snapshot');const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,'value'))throw new DiscordTransportFault('BuildingRequest','invalid request field');return d.value;}
function messageRequest(input:IdempotentMessageRequest):IdempotentMessageRequest{
  const method=own(input,'method'),path=own(input,'path'),body=own(input,'body');if(method!=='POST'||typeof path!=='string'||typeof body!=='string')throw new DiscordTransportFault('BuildingRequest','invalid message route');
  const route=/^channels\/([1-9][0-9]{0,19})\/messages$/u.exec(path);if(route===null||route[0]!==path)throw new DiscordTransportFault('BuildingRequest','invalid message route');channel(BigInt(route[1]!));
 return Object.freeze({method:'POST',path,body});
}
/** Pinned Twilight response-state behavior, with required wire/rate/model adapters.
 * This is NOT a complete production HTTP client until those adapters are qualified.
 * 429 retries reacquire a rate permit and reuse the exact request; other failures never
 * automatically retry. No token/response body is exposed in diagnostics. */
export class DiscordResponseEngine implements DiscordReceiptTransport,TypingTransport{
 readonly #wire:DiscordHttpWire;readonly #rate:DiscordRateLimiter;readonly #decoder:DiscordMessageDecoder;readonly #authorization:string|null;readonly #timeout:number;readonly #shutdown=new AbortController();readonly #tasks=new Set<Promise<unknown>>();#invalid=false;#closing:Promise<void>|null=null;
 constructor(options:{wire:DiscordHttpWire;rateLimiter:DiscordRateLimiter;decoder:DiscordMessageDecoder;token:string|null;headerTimeoutMs?:number}){
  const token=options.token;if(token!==null&&typeof token!=='string')throw new DiscordTransportFault('CreatingHeader','invalid authorization header');
  const authorization=token===null?null:token.startsWith('Bot ')||token.startsWith('Bearer ')?token:`Bot ${token}`;
  // HeaderValue rejects controls/newlines. This supported adapter uses ASCII tokens.
  if(authorization!==null&&/[^\x20-\x7e]/.test(authorization))throw new DiscordTransportFault('CreatingHeader','invalid authorization header');
  if(typeof options.decoder.decode!=="function"||types.isProxy(options.decoder.decode)||types.isAsyncFunction(options.decoder.decode)||types.isGeneratorFunction(options.decoder.decode))throw new DiscordTransportFault("BuildingRequest","a synchronous complete receipt decoder is required");
  this.#authorization=authorization;this.#wire={request:options.wire.request.bind(options.wire)};this.#rate={acquire:options.rateLimiter.acquire.bind(options.rateLimiter)};this.#decoder={decode:options.decoder.decode.bind(options.decoder)};this.#timeout=options.headerTimeoutMs??10000;if(!Number.isSafeInteger(this.#timeout)||this.#timeout<0||this.#timeout>2147483647)throw new DiscordTransportFault('BuildingRequest','invalid timeout profile');
 }
 get authorizationInvalidated():boolean{return this.#invalid;}
 #run<T>(operation:(signal:AbortSignal)=>Promise<T>,input?:AbortSignal):Promise<T>{
  if(this.#closing!==null)return Promise.reject(this.#shutdown.signal.reason);
  const signal=input===undefined?this.#shutdown.signal:AbortSignal.any([this.#shutdown.signal,input]);const task=Promise.resolve().then(()=>{signal.throwIfAborted();if(this.#invalid)throw new DiscordTransportFault('Unauthorized','authorization was invalidated');return operation(signal);});this.#tasks.add(task);void task.then(()=>this.#tasks.delete(task),()=>this.#tasks.delete(task));return task;
 }
 sendValidated(input:IdempotentMessageRequest):Promise<bigint>{
  const {path,body}=messageRequest(input);
  return this.#run(signal=>this.#request('POST',path,body,bytes=>{const id=this.#decoder.decode(bytes);if(types.isPromise(id))void Promise.prototype.then.call(id,undefined,()=>undefined);if(typeof id!=='bigint'||id<=0n||id>=(1n<<64n))throw new Error('invalid identity');return id;},()=>new DiscordTransportFault('Receipt','response model could not be decoded'),signal)) as Promise<bigint>;
 }
 /** Source send_idempotent_message awaits response headers, unlike the separate
  * durable receipt API. Success body is released without decoding. */
 sendWithoutReceipt(input:IdempotentMessageRequest,signal?:AbortSignal):Promise<void>{const {path,body}=messageRequest(input);return this.#run(async owned=>{await this.#request('POST',path,body,null,()=>new Error('unused no-receipt decoder'),owned);},signal);}
 createTyping(id:bigint,signal:AbortSignal):Promise<void>{return this.#run(async owned=>{await this.#request('POST',`channels/${channel(id)}/typing`,null,null,()=>new Error('unused typing decoder'),owned);},signal);}
 getGatewayBot(signal?:AbortSignal):Promise<DiscordGatewayBotInfo>{return this.#run(owned=>this.#request('GET','gateway/bot',null,decodeDiscordGatewayBotInfoBytes,()=>new DiscordGatewayModelError(),owned),signal) as Promise<DiscordGatewayBotInfo>;}
 registerSlashCommands(applicationId:bigint,guildId:bigint|null,qa:boolean,signal?:AbortSignal):Promise<void>{const request=slashCommandRegistrationRequest(applicationId,guildId,qa);return this.#run(async owned=>{await this.#request('PUT',request.path,request.body,null,()=>new Error('unused registration decoder'),owned);},signal);}
 async #request<T>(method:DiscordHttpMethod,path:string,body:string|null,decode:((bytes:Uint8Array)=>T)|null,decodeFailure:()=>Error,signal:AbortSignal):Promise<T|void>{
  const request:DiscordWireRequest=Object.freeze({method,path,body,authorization:this.#authorization});
  for(;;){signal.throwIfAborted();let permit:DiscordRatePermit|undefined,response:DiscordWireResponse|undefined;
   try{
    try{permit=await this.#rate.acquire(method,path,signal);signal.throwIfAborted();response=await this.#wire.request(request,this.#timeout,signal);}catch(error){if(signal.aborted&&error===signal.reason)throw error;throw transport();}
    const status=response.status;if(!Number.isInteger(status)||status<100||status>599)throw transport();if(status===401&&this.#authorization!==null)this.#invalid=true;
    try{invokeSynchronousVoid(permit.complete,permit,[status,response.headers]);}catch{throw transport();}
    if(status>=200&&status<300){
     if(decode===null)return;
     try{return decode(await response.bytes());}catch{throw decodeFailure();}
    }
    if(status!==429){
     try{const bytes=await response.bytes(),text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);parseDiscordApiError(text);}catch{throw transport();}
     throw new DiscordTransportFault('Response',`provider returned HTTP ${status}`,status);
    }
   }finally{
    try{if(response!==undefined)await response.release();}finally{if(permit!==undefined)invokeSynchronousVoid(permit.release,permit);}
   }
   // Same safe body/nonce, no retry after unknown transport or receipt failures.
   await yieldToRuntime();
  }
 }
 /** Does not claim cancellation until every owned operation actually settles. */
 close(reason:unknown=new Error('Discord response engine stopped')):Promise<void>{if(this.#closing!==null)return this.#closing;this.#shutdown.abort(reason);this.#closing=Promise.allSettled([...this.#tasks]).then(()=>undefined);return this.#closing;}
}
