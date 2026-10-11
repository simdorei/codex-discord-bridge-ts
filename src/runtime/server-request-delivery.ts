import {types} from 'node:util';
import {PortableResidentLifecycle} from '../app-server/portable-resident-lifecycle.ts';
import {clonePendingServerRequest,type PendingServerRequest} from '../app-server/server-request-state.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {requireDiscordText,splitDeliveryChunks} from '../discord/text.ts';
import {verifyPromptAuthority,PromptAuthorityError} from './server-prompt-authority.ts';
import {buildServerPrompt} from './server-prompt.ts';
import {sendReceiptChunk,type DiscordReceiptTransport} from './completion/receipt-sender.ts';
import {serverPromptIdentity,SentServerPromptCache,SERVER_REQUEST_PROMPT_DOMAIN,requirePromptGeneration} from './server-prompt-identity.ts';
export class ServerRequestGenerationMismatch extends Error{readonly expected:bigint;readonly actual:bigint;constructor(expected:bigint,actual:bigint){super(`app-server generation changed: expected ${expected}, current ${actual}`);this.name='ServerRequestGenerationMismatch';this.expected=expected;this.actual=actual;}}
export class ServerRequestSnapshotUnstable extends Error{readonly attempts=3;constructor(){super('app-server generation changed during 3 pending-request snapshots');this.name='ServerRequestSnapshotUnstable';}}
/** Serial original-request delivery core. Caller supplies the exact native owner
 * and a validated HTTP transport. No default channel, fabricated occurrence or
 * approval response exists here. Signal cancellation joins actual HTTP/receipt
 * work; a late known acceptance is still committed by the receipt state machine.
 * Scheduler retries and runtime startup binding are separate. */
export class ServerRequestDelivery{
 readonly #database:string;readonly #server:PortableResidentLifecycle;readonly #transport:DiscordReceiptTransport;readonly #sent=new SentServerPromptCache();#busy=false;#workerOwned=false;
 constructor(database:string,server:PortableResidentLifecycle,transport:DiscordReceiptTransport){
  requireDiscordText(database);PortableResidentLifecycle.prototype.lifecycleSnapshot.call(server);const send=own(transport,'sendValidated');if(typeof send!=='function'||types.isProxy(send)||types.isGeneratorFunction(send))throw new TypeError('Expected owned server prompt transport');
  this.#database=database;this.#server=server;this.#transport=Object.freeze({sendValidated:(request:Parameters<DiscordReceiptTransport['sendValidated']>[0])=>Reflect.apply(send,transport,[request])});
 }
 #generation(expected:bigint){requirePromptGeneration(expected);const actual=PortableResidentLifecycle.prototype.generation.call(this.#server);if(actual!==expected)throw new ServerRequestGenerationMismatch(expected,actual);}
 async #process(generation:bigint,input:PendingServerRequest,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();this.#generation(generation);const request=clonePendingServerRequest(input),authority=await verifyPromptAuthority(this.#database,this.#server,request,generation);signal?.throwIfAborted();
  const prompt=buildServerPrompt(request,generation),key=serverPromptIdentity(generation,request,prompt);if(this.#sent.contains(generation,key))return;
  const chunks=splitDeliveryChunks(prompt.text,true);
  for(let index=0;index<chunks.length;index++){
   signal?.throwIfAborted();this.#generation(generation);const current=await verifyPromptAuthority(this.#database,this.#server,request,generation);if(current.channelId!==authority.channelId)throw new PromptAuthorityError('original delivery channel changed');signal?.throwIfAborted();
   await sendReceiptChunk(this.#database,this.#transport,authority.channelId,{domain:SERVER_REQUEST_PROMPT_DOMAIN,logicalKey:key,chunkIndex:index,content:chunks[index]!},index+1===chunks.length?prompt.components:[],null,signal);
  }
  this.#sent.remember(generation,key);
 }
 async #exclusive(operation:()=>Promise<void>):Promise<void>{if(this.#busy)throw new TypeError('Server request delivery is already owned');this.#busy=true;try{await operation();}finally{this.#busy=false;}}
 async process(generation:bigint,request:PendingServerRequest,signal?:AbortSignal):Promise<void>{
  if(this.#workerOwned)throw new TypeError('Server request delivery is already owned');await this.#exclusive(()=>this.#process(generation,request,signal));
 }
 async recover(signal?:AbortSignal):Promise<void>{if(this.#workerOwned)throw new TypeError('Server request delivery is already owned');await this.#exclusive(()=>this.#recover(signal));}
 async #recover(signal?:AbortSignal):Promise<void>{
   signal?.throwIfAborted();let snapshot:Readonly<{generation:bigint;requests:PendingServerRequest[]}>|undefined;
   for(let attempt=0;attempt<3;attempt++){const generation=PortableResidentLifecycle.prototype.generation.call(this.#server),requests=await Promise.resolve(PortableResidentLifecycle.prototype.pendingServerRequests.call(this.#server,null));signal?.throwIfAborted();if(PortableResidentLifecycle.prototype.generation.call(this.#server)===generation){snapshot={generation,requests};break;}}
   if(snapshot===undefined)throw new ServerRequestSnapshotUnstable();let failed=false,first:unknown;
   for(const request of snapshot.requests){signal?.throwIfAborted();try{await this.#process(snapshot.generation,request,signal);}catch(error){signal?.throwIfAborted();if(!failed){failed=true;first=error;}}}
   if(failed)throw first;
 }
 /** Runtime loop borrows exclusive delivery ownership through its joined exit. */
 claimWorker(server:PortableResidentLifecycle){
  if(server!==this.#server)throw new TypeError('Server request worker resident mismatch');if(this.#busy||this.#workerOwned)throw new TypeError('Server request delivery is already owned');this.#workerOwned=true;let released=false;
  const require=()=>{if(released)throw new TypeError('Server request worker ownership released');};
  return Object.freeze({process:(generation:bigint,request:PendingServerRequest,signal?:AbortSignal)=>{require();return this.#exclusive(()=>this.#process(generation,request,signal));},recover:(signal?:AbortSignal)=>{require();return this.#exclusive(()=>this.#recover(signal));},dispose:()=>{if(released)return;if(this.#busy)throw new TypeError('Server request operation has not joined');released=true;this.#workerOwned=false;}});
 }
}
Object.freeze(ServerRequestDelivery.prototype);
