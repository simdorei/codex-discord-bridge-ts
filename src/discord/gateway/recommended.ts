import {types} from 'node:util';
import {setImmediate as yieldToRuntime} from 'node:timers/promises';
import {SecretToken} from '../../config/remote.ts';
import {DiscordChannelClient} from '../channel-client.ts';
import {isDiscordGatewayModelError} from '../model/gateway-info.ts';
import {GatewayRuntime,type GatewayRuntimeOptions} from './runtime.ts';
import {GatewayMessageDriver,type GatewayDriverClock} from './message-driver.ts';
import {GatewayDecodedShardPort} from './decoded-shard-port.ts';
import {SingleBucketGatewayIdentifyQueue} from './identify-queue.ts';
import {NodeGatewayWebSocket} from './node-websocket.ts';
import {gatewayHeartbeatJitter} from './heartbeat-timing.ts';
import {gatewayIntents} from './config.ts';
import {gatewayOwnField} from './values.ts';
import type {DecodedGatewayInteraction} from './decoded-interaction.ts';
import type {GatewayShutdownReport} from './shutdown.ts';
interface CommonOptions{
 readonly messageContent:boolean;
 readonly reportReceiveErrorDrop:GatewayRuntimeOptions['reportReceiveErrorDrop'];
 readonly reportTriggerFailure:GatewayRuntimeOptions['reportTriggerFailure'];
 readonly reportHttpError:(error:unknown)=>void;
 readonly jitter?:(intervalNs:bigint)=>bigint;
 readonly signal?:AbortSignal;
}
export interface RecommendedGatewayOptions extends CommonOptions{readonly token:SecretToken}
export interface RecommendedGatewayTestOptions extends CommonOptions{readonly httpOrigin:string;readonly gatewayUrl:string;readonly clock?:GatewayDriverClock}
interface Captured{messageContent:boolean;jitter:(intervalNs:bigint)=>bigint;reportHttpError:(error:unknown)=>void;runtimeOptions:GatewayRuntimeOptions;signal:AbortSignal|undefined}
function optional(input:object,key:string):unknown{return Object.hasOwn(input,key)?gatewayOwnField(input,key):undefined;}
function synchronous(input:object,key:string):Function{const f=gatewayOwnField(input,key);if(typeof f!=='function'||types.isProxy(f)||types.isAsyncFunction(f)||types.isGeneratorFunction(f))throw new TypeError('Expected synchronous Gateway callback');return f.bind(input);}
function capture(input:CommonOptions):Captured{
 const messageContent=gatewayOwnField(input,'messageContent') as boolean;gatewayIntents(messageContent);
 const reportHttpError=synchronous(input,'reportHttpError') as (error:unknown)=>void;
 const runtimeOptions=Object.freeze({reportReceiveErrorDrop:synchronous(input,'reportReceiveErrorDrop') as GatewayRuntimeOptions['reportReceiveErrorDrop'],reportTriggerFailure:synchronous(input,'reportTriggerFailure') as GatewayRuntimeOptions['reportTriggerFailure']});
 const jitter=optional(input,'jitter')??gatewayHeartbeatJitter;if(typeof jitter!=='function'||types.isProxy(jitter)||types.isAsyncFunction(jitter)||types.isGeneratorFunction(jitter))throw new TypeError('Expected synchronous heartbeat jitter');
 const signal=optional(input,'signal') as AbortSignal|undefined;signal?.throwIfAborted();return {messageContent,jitter:jitter as (n:bigint)=>bigint,reportHttpError,runtimeOptions,signal};
}
export class GatewayRecommendedStartError extends Error{readonly kind:'Request'|'Deserializing';constructor(kind:'Request'|'Deserializing',cause:unknown){super('failed to start recommended Discord gateway shards: '+(kind==='Request'?'request failed to complete':"payload isn't a recognized type"),{cause});this.name='GatewayRecommendedStartError';this.kind=kind;}}
/** Explicit Node owner around source start_paused. runtime.shutdown() ends shard
 * work but intentionally leaves shared HTTP available for final consumers. close()
 * joins runtime first, then identify queue and HTTP. The caller must eventually
 * close this outer owner; GC is not Rust Drop. No live call is made by imports. */
export class RecommendedGateway{
 readonly runtime:GatewayRuntime<DecodedGatewayInteraction>;readonly http:DiscordChannelClient;
 readonly #queue:SingleBucketGatewayIdentifyQueue;readonly #shutdown:(deadline?:number)=>Promise<GatewayShutdownReport>;readonly #runtimeClosed:()=>boolean;readonly #closeHttp:(reason?:unknown)=>Promise<void>;
 #closing:Promise<GatewayShutdownReport>|undefined;#closed=false;
 private constructor(runtime:GatewayRuntime<DecodedGatewayInteraction>,http:DiscordChannelClient,queue:SingleBucketGatewayIdentifyQueue){this.runtime=runtime;this.http=http;this.#queue=queue;this.#shutdown=GatewayRuntime.prototype.shutdown.bind(runtime);const closed=Object.getOwnPropertyDescriptor(GatewayRuntime.prototype,'resourcesClosed')!.get!;this.#runtimeClosed=()=>closed.call(runtime) as boolean;this.#closeHttp=DiscordChannelClient.prototype.close.bind(http);Object.freeze(this);}
 static async startPaused(options:RecommendedGatewayOptions):Promise<RecommendedGateway>{const input=capture(options),token=gatewayOwnField(options,'token') as SecretToken,raw=SecretToken.prototype.expose.call(token);return this.#build(input,token,()=>DiscordChannelClient.create({token:raw,report:input.reportHttpError}));}
 /** Credential-free HTTP and internally generated fake WS token only. The test
  * route cannot accept a real caller token or arbitrary non-loopback destination. */
 static async startPausedForTest(options:RecommendedGatewayTestOptions):Promise<RecommendedGateway>{
  const input=capture(options),httpOrigin=gatewayOwnField(options,'httpOrigin') as string,gatewayUrl=gatewayOwnField(options,'gatewayUrl');if(typeof gatewayUrl!=='string')throw new TypeError('Expected loopback Gateway URL');const url=new URL(gatewayUrl);if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.username!==''||url.password!==''||url.search!==''||url.hash!==''||url.pathname!=='/'||url.port==='')throw new TypeError('Expected literal loopback Gateway URL');
  const clock=optional(options,'clock') as GatewayDriverClock|undefined;
  return this.#build(input,new SecretToken('offline-fixture'),()=>DiscordChannelClient.create({token:null,testOrigin:httpOrigin,report:input.reportHttpError}),{gatewayUrl:url.href,...(clock===undefined?{}:{clock})});
 }
 static async #build(input:Captured,token:SecretToken,createHttp:()=>Promise<DiscordChannelClient>,test?:{gatewayUrl:string;clock?:GatewayDriverClock}):Promise<RecommendedGateway>{
  let http:DiscordChannelClient|undefined,queue:SingleBucketGatewayIdentifyQueue|undefined;const ports:GatewayDecodedShardPort[]=[];
  try{
   http=await createHttp();const clock=test?.clock===undefined?undefined:Object.freeze({nowNs:test.clock.nowNs.bind(test.clock),sleepUntilNs:test.clock.sleepUntilNs.bind(test.clock)});
   queue=new SingleBucketGatewayIdentifyQueue(clock===undefined?{}:{clock:{now:()=>Number(clock.nowNs())/1e6,sleepUntil:(deadline,signal)=>clock.sleepUntilNs(BigInt(Math.ceil(deadline*1e6)),signal)}});
   let info;try{info=await http.getGatewayBot(input.signal);}catch(error){if(input.signal?.aborted&&error===input.signal.reason)throw error;throw new GatewayRecommendedStartError(isDiscordGatewayModelError(error)?'Deserializing':'Request',error);}
   // Pinned create_recommended uses only shards here. URL/session budget are fully
   // decoded, but do not override the default endpoint or shared default queue.
   const total=Number(info.shards);for(let shard=0;shard<total;shard++){
    input.signal?.throwIfAborted();const driver=new GatewayMessageDriver({token,shardNumber:shard,shardTotal:total,messageContent:input.messageContent,identifyQueue:queue,jitter:input.jitter,...(clock===undefined?{}:{clock}),...(test===undefined?{}:{connect:(_url:string,signal:AbortSignal)=>NodeGatewayWebSocket.connectForTest(test.gatewayUrl,{signal})})});
    try{ports.push(new GatewayDecodedShardPort(driver));}catch(error){await driver.dispose();throw error;}
    if((shard+1)%64===0)await yieldToRuntime(undefined,input.signal===undefined?undefined:{signal:input.signal});
   }
   input.signal?.throwIfAborted();return new RecommendedGateway(GatewayRuntime.fromOwnedPorts(ports,input.runtimeOptions),http,queue);
  }catch(error){const cleanup=await Promise.allSettled([...ports.map(port=>port.dispose()),...(queue===undefined?[]:[queue.close()]),...(http===undefined?[]:[http.close()])]);const failures=cleanup.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(failures.length)throw new AggregateError([error,...failures],'Gateway startup and cleanup failed');throw error;}
 }
 snapshot(){return Object.freeze({closed:this.#closed,pendingTasks:this.runtime.pendingTasks,httpRequests:this.http.activeRequests,httpSockets:this.http.ownedSockets,queue:this.#queue.snapshot()});}
 close(deadlineMs?:number,reason:unknown=new Error('Recommended Gateway stopped')):Promise<GatewayShutdownReport>{
  if(this.#closing!==undefined)return this.#closing;
  this.#closing=(async()=>{let report:GatewayShutdownReport|undefined,failed=false,primary:unknown;try{report=await this.#shutdown(deadlineMs);}catch(error){failed=true;primary=error;}
   if(!this.#runtimeClosed()){if(failed)throw primary;throw new Error('Gateway tasks have not settled');}
   const cleanup=await Promise.allSettled([this.#queue.close(),this.#closeHttp(reason)]),errors=cleanup.flatMap(result=>result.status==='rejected'?[result.reason]:[]);this.#closed=true;if(failed)errors.unshift(primary);if(errors.length===1)throw errors[0];if(errors.length>1)throw new AggregateError(errors,'Gateway owner cleanup failed');return report!;
  })();return this.#closing;
 }
}
