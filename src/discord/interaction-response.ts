import {DISCORD_MAX_LEN,fitSingleMessage,requireDiscordText} from './text.ts';
export interface AutocompleteChoice {readonly name:string;readonly value:string}
export type InteractionResponse={readonly type:1|5|6}|{readonly type:4;readonly data:{readonly allowed_mentions:{readonly parse:readonly []};readonly content:string;readonly flags?:64}}|{readonly type:8;readonly data:{readonly choices:readonly AutocompleteChoice[]}};
const responses=new WeakSet<object>();
function owned<T extends InteractionResponse>(value:T):T{Object.freeze(value);responses.add(value);return value;}
export function pongResponse():InteractionResponse{return owned({type:1});}
export function deferredChannelResponse():InteractionResponse{return owned({type:5});}
export function deferredInteractionUpdateResponse():InteractionResponse{return owned({type:6});}
export function isInteractionResponse(value:unknown):value is InteractionResponse{return value!==null&&(typeof value==='object'||typeof value==='function')&&responses.has(value);}
export function autocompleteResponse(choices:readonly AutocompleteChoice[]):InteractionResponse{
 if(!Array.isArray(choices)||choices.length>25)throw new TypeError('Expected at most 25 string choices');
 const copy=choices.map(choice=>{requireDiscordText(choice.name);requireDiscordText(choice.value);return Object.freeze({name:choice.name,value:choice.value});});
 return owned({type:8,data:Object.freeze({choices:Object.freeze(copy)})});
}
export function emptyAutocompleteResponse():InteractionResponse{return autocompleteResponse([]);}
export function interactionMessage(content:string,ephemeral:boolean):InteractionResponse{if(typeof ephemeral!=='boolean')throw new TypeError('Expected ephemeral flag');return owned({type:4,data:Object.freeze({allowed_mentions:Object.freeze({parse:Object.freeze([]) as readonly []}),content:fitSingleMessage(content,DISCORD_MAX_LEN),...(ephemeral?{flags:64 as const}:{})})});}
export function invalidInteractionMessage(reason:string):InteractionResponse{requireDiscordText(reason);return interactionMessage(`Discord interaction rejected: ${reason}`,true);}
/** Only this source-supported generated response profile may reach the serializer;
 * arbitrary caller JSON/components/attachments are not accepted by this helper. */
export function serializeInteractionResponse(response:InteractionResponse):string{if(!responses.has(response))throw new TypeError('Expected owned interaction response');return JSON.stringify(response);}
