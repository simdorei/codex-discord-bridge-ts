import {types} from 'node:util';
import {NodeDiscordHttpWire} from './node-http-wire.ts';
import {DiscordChannelRateLimiter} from './rate-header-adapter.ts';
import {DiscordResponseEngine} from './response-engine.ts';
import {discordMessageDecoder} from './model/message.ts';
import type {IdempotentMessageRequest} from './idempotent-message.ts';
import type {DiscordReceiptTransport} from '../runtime/completion/receipt-sender.ts';
import type {TypingTransport} from '../runtime/completion/typing.ts';
export interface DiscordChannelClientOptions{
 readonly token:string|null;
 readonly report:(error:unknown)=>void;
 readonly globalLimit?:number;
 readonly headerTimeoutMs?:number;
 /** Credential-free literal loopback only, explicitly for integration tests. */
 readonly testOrigin?:string;
}
/** One owned channel-profile client shares wire, rate state and token invalidation
 * across typing/messages. It supplies the complete response decoder internally.
 * Gateway discovery, interaction routes and service bootstrap are separate scopes. */
export class DiscordChannelClient implements DiscordReceiptTransport,TypingTransport{
 readonly #wire:NodeDiscordHttpWire;readonly #rate:DiscordChannelRateLimiter;readonly #engine:DiscordResponseEngine;#closing:Promise<void>|null=null;
 private constructor(wire:NodeDiscordHttpWire,rate:DiscordChannelRateLimiter,engine:DiscordResponseEngine){this.#wire=wire;this.#rate=rate;this.#engine=engine;}
 /** No request is sent while constructing. Failed construction joins any initialized
  * resource owners; no detached cleanup task or global Node agent is used. */
 static async create(options:DiscordChannelClientOptions):Promise<DiscordChannelClient>{
  if(typeof options.report!=='function'||types.isProxy(options.report)||types.isAsyncFunction(options.report)||types.isGeneratorFunction(options.report))throw new TypeError('Expected synchronous rate diagnostic reporter');
  const origin=options.testOrigin;
  if(origin!==undefined&&(typeof origin!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/api\/v10\/$/u.test(origin)||options.token!==null))throw new TypeError('Test origin requires credential-free literal loopback');
  let wire:NodeDiscordHttpWire|undefined,rate:DiscordChannelRateLimiter|undefined;
  try{
   wire=new NodeDiscordHttpWire(origin);
   rate=new DiscordChannelRateLimiter({report:options.report,...(options.globalLimit===undefined?{}:{globalLimit:options.globalLimit})});
   const engine=new DiscordResponseEngine({wire,rateLimiter:rate,decoder:discordMessageDecoder,token:options.token,...(options.headerTimeoutMs===undefined?{}:{headerTimeoutMs:options.headerTimeoutMs})});
   return new DiscordChannelClient(wire,rate,engine);
  }catch(error){
   await Promise.allSettled([...(rate===undefined?[]:[rate.close(error)]),...(wire===undefined?[]:[wire.close()])]);throw error;
  }
 }
 sendValidated(request:IdempotentMessageRequest):Promise<bigint>{return this.#engine.sendValidated(request);}
 createTyping(channel:bigint,signal:AbortSignal):Promise<void>{return this.#engine.createTyping(channel,signal);}
 get authorizationInvalidated():boolean{return this.#engine.authorizationInvalidated;}
 get activeRequests():number{return this.#wire.activeRequests;}
 get ownedSockets():number{return this.#wire.ownedSockets;}
 /** Abort all three owners together, then join them. Waiting for just the engine
  * would not by itself prove keep-alive sockets and rate timers were reclaimed. */
 close(reason:unknown=new Error('Discord channel client stopped')):Promise<void>{
  if(this.#closing!==null)return this.#closing;
  this.#closing=(async()=>{const results=await Promise.allSettled([this.#engine.close(reason),this.#rate.close(reason),this.#wire.close()]);const errors=results.flatMap(r=>r.status==='rejected'?[r.reason]:[]);if(errors.length===1)throw errors[0];if(errors.length>1)throw new AggregateError(errors,'Discord channel client cleanup failed');})();return this.#closing;
 }
}
