import {createHash} from 'node:crypto';
import {clonePendingServerRequest,type PendingServerRequest} from '../app-server/server-request-state.ts';
import {ServerRequestOccurrence} from '../protocol/ids.ts';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import type {DiscordComponent} from '../discord/components.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {serializeDiscordComponent} from '../discord/components.ts';
import {requireDiscordText} from '../discord/text.ts';
import type {ServerPrompt} from './server-prompt.ts';
export const SERVER_REQUEST_PROMPT_DOMAIN='server-request/prompt/v1';
export function requirePromptGeneration(generation:bigint):void{if(typeof generation!=='bigint'||generation<0n||generation>=(1n<<64n))throw new TypeError('Expected u64 prompt generation');}
/** Exact source semantic v2 hash; occurrence bytes and typed request ID are
 * length-prefixed, followed by method/thread/text/component-array JSON bytes.
 * Channel and chunk index remain in the outer durable receipt/Discord nonce. */
export function serverPromptIdentity(generation:bigint,input:PendingServerRequest,inputPrompt:ServerPrompt):string{
 requirePromptGeneration(generation);const request=clonePendingServerRequest(input),threadId=own(inputPrompt,'threadId'),text=own(inputPrompt,'text'),rawComponents=own(inputPrompt,'components');requireDiscordText(threadId);requireDiscordText(text);
 if(!Array.isArray(rawComponents)||types.isProxy(rawComponents))throw new TypeError('Expected prompt components');const encoded:string[]=[];for(let i=0;i<rawComponents.length;i++)encoded.push(serializeDiscordComponent(own(rawComponents,String(i)) as DiscordComponent));
 const id=serializeSerdeValue(request.id),components='['+encoded.join(',')+']',hash=createHash('sha256').update('cdr-runtime/server-request-prompt/v2');
 for(const value of [ServerRequestOccurrence.prototype.asBytes.call(request.occurrence),Buffer.from(id),Buffer.from(request.method),Buffer.from(threadId),Buffer.from(text),Buffer.from(components)]){const length=Buffer.alloc(8);length.writeBigUInt64BE(BigInt(value.length));hash.update(length);hash.update(value);}
 return `${generation}:${id}:${hash.digest('hex')}`;
}
/** Process-local optimization only. Eviction or process restart never authorizes
 * a new send: the durable receipt remains the authority for each chunk. */
export class SentServerPromptCache{
 #generation:bigint|null=null;readonly #keys=new Set<string>();
 #select(generation:bigint){requirePromptGeneration(generation);if(this.#generation!==generation){this.#generation=generation;this.#keys.clear();}}
 contains(generation:bigint,key:string):boolean{requireDiscordText(key);this.#select(generation);return this.#keys.has(key);}
 remember(generation:bigint,key:string):void{requireDiscordText(key);this.#select(generation);this.#keys.add(key);while(this.#keys.size>512)this.#keys.delete(this.#keys.values().next().value!);}
 get size():number{return this.#keys.size;}
}
