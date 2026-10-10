import {serializeDiscordComponent,type DiscordComponent} from "./components.ts";
import {messageNonce} from "./message-nonce.ts";
import {DISCORD_MAX_LEN,requireDiscordText} from "./text.ts";
export type MessageContentFailure={readonly kind:"ContentEmpty"}|{readonly kind:"ContentTooLong";readonly actual:number;readonly maximum:number};
const contentErrors=new WeakMap<object,string>();
export function idempotentContentErrorMessage(value:unknown):string|null{return value!==null&&(typeof value==="object"||typeof value==="function")?contentErrors.get(value)??null:null;}
export class IdempotentMessageContentError extends Error{
  readonly kind:MessageContentFailure["kind"];readonly failure:MessageContentFailure;
  constructor(failure:MessageContentFailure){super(failure.kind==="ContentEmpty"?"Discord message content must not be empty":`Discord message content has ${failure.actual} characters; maximum is ${failure.maximum}`);this.name="IdempotentMessageContentError";this.kind=failure.kind;this.failure=Object.freeze({...failure});contentErrors.set(this,this.message);}
}
export interface IdempotentMessageRequest {readonly method:"POST";readonly path:string;readonly body:string}
/** No-components CreateMessage profile. Authentication, HTTP and typed receipt decoding belong to the transport adapter. */
export function idempotentMessageRequest(channelId:bigint,content:string,domain:string,logicalKey:string,chunkIndex:bigint|number):IdempotentMessageRequest{
  return idempotentMessageRequestWithComponents(channelId,content,[],domain,logicalKey,chunkIndex);
}
export function idempotentMessageRequestWithComponents(channelId:bigint,content:string,components:readonly DiscordComponent[],domain:string,logicalKey:string,chunkIndex:bigint|number):IdempotentMessageRequest{
  requireDiscordText(content);
  if(content.replace(/^\p{White_Space}+/u,"").replace(/\p{White_Space}+$/u,"")==="")throw new IdempotentMessageContentError({kind:"ContentEmpty"});
  let actual=0;for(const _char of content)actual++;
  if(actual>DISCORD_MAX_LEN)throw new IdempotentMessageContentError({kind:"ContentTooLong",actual,maximum:DISCORD_MAX_LEN});
  const nonce=messageNonce(domain,channelId,logicalKey,chunkIndex);
  // twilight-model 0.17.1 AllowedMentions::default serializes only parse:[];
  // replied_user=false and empty roles/users are omitted by its serde attributes.
  // Source: https://api.twilight.rs/src/twilight_model/channel/message/allowed_mentions.rs.html
  const encoded:string[]=[];for(const component of components)encoded.push(serializeDiscordComponent(component));
  const body=`{"content":${JSON.stringify(content)},"allowed_mentions":{"parse":[]}${encoded.length?`,"components":[${encoded.join(",")}]`:""},"nonce":${nonce},"enforce_nonce":true}`;
  return Object.freeze({method:"POST",path:`channels/${channelId}/messages`,body});
}
