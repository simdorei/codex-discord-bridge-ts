import {parseSerdeField,type StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {modelOption as option,modelUnsigned as unsigned,modelSnowflake as id,modelStruct as struct,modelVector as vector,modelShape as shape} from './fields.ts';
import {discordUserField} from './user.ts';
import {modelTimestamp as timestamp} from './timestamp.ts';
import {discordAttachmentField,discordEmbedField} from './media.ts';
import {discordComponentField} from './component.ts';
import {discordChannelField} from './channel.ts';
import {discordInteractionTypeField,discordMessageActivityField,discordMessageApplicationField,discordMessageCallField,discordMessageFlagsField,discordMessageInteractionField,discordPartialMemberField,discordChannelMentionField,discordMentionField,discordMessageSnapshotField,discordPollField,discordReactionField,discordMessageReferenceField,discordRoleSubscriptionField,discordMessageStickerField} from './message-parts.ts';
import type {DiscordMessageDecoder} from '../response-engine.ts';

/** AnonymizableId suppresses Id's error, but it does not rewind the JSON parser.
 * For valid JSON this only succeeds if the failed deserialize consumed its token.
 * Empty containers are consumed; nonempty unsupported containers leave unread data.
 * Malformed JSON is rejected at the root instead of emulating error-swallowing
 * acceptance of invalid JSON. This decoder is a valid-JSON response profile. */
const anonymizableId:StructFieldDecoder=(input,_depth,context)=>{
 const raw=input.trim();
 if(raw[0]==='['||raw[0]==='{'){
  if(!/^(?:\[[\x20\t\n\r]*\]|\{[\x20\t\n\r]*\})$/u.test(raw))throw new SyntaxError('Unconsumed anonymizable identity container');
  context.value();return 0n;
 }
 if(raw[0]==='"'){
  // serde_json's leading-surrogate error consumes the following non-backslash
  // byte. Only a final closing quote leaves the entire valid JSON token consumed.
  for(let i=1;i<raw.length-1;){
   if(raw[i]!=='\\'){i++;continue;}
   if(raw[i+1]!=='u'){i+=2;continue;}
   const unit=Number.parseInt(raw.slice(i+2,i+6),16);
   if(unit>=0xdc00&&unit<=0xdfff)throw new SyntaxError('Unconsumed trailing surrogate identity');
   if(unit>=0xd800&&unit<=0xdbff){
    const next=i+6;
    if(next===raw.length-1)return 0n;
    if(raw.slice(next,next+2)!=='\\u')throw new SyntaxError('Unconsumed leading surrogate identity');
    const low=Number.parseInt(raw.slice(next+2,next+6),16);
    if(low<0xdc00||low>0xdfff)throw new SyntaxError('Unconsumed surrogate pair identity');
    i=next+6;
   }else i+=6;
  }
  context.decode('string');
 }
 const exponent=/[eE](\+?)([0-9]+)$/u.exec(raw);
 if(exponent!==null&&/[1-9]/u.test(raw.slice(0,exponent.index))){
  let value=0;const digits=exponent[2]!;
  for(let i=0;i<digits.length;i++){
   value=value*10+Number(digits[i]);
   if(value>2147483647){if(i<digits.length-1)throw new SyntaxError('Unconsumed overflowing identity exponent');break;}
  }
 }
 try{return context.decode(id);}catch(error){if(!(error instanceof SyntaxError)&&!(error instanceof RangeError))throw error;return 0n;}
};
const integrationOwners=struct(shape([['0',option(anonymizableId)],['1',option(id)]],['0','1']));
export const discordInteractionMetadataField:StructFieldDecoder=(_raw,_depth,context)=>context.struct(metadataShape);
const metadataShape=shape([
 ['authorizing_integration_owners',integrationOwners],['id',id],['interacted_message_id',option(id)],['type',discordInteractionTypeField],['original_response_message_id',option(id)],['target_message_id',option(id)],['target_user',option(discordUserField)],['triggering_interaction_metadata',option(discordInteractionMetadataField)],['user',discordUserField],
],['interacted_message_id','original_response_message_id','target_message_id','target_user','triggering_interaction_metadata']);
export const discordMessageField:StructFieldDecoder=(_raw,_depth,context)=>context.struct(messageShape);
const messageShape=shape([
 ['activity',option(discordMessageActivityField)],['application',option(discordMessageApplicationField)],['application_id',option(id)],['attachments',vector(discordAttachmentField)],['author',discordUserField],['call',option(discordMessageCallField)],['channel_id',id],['components',vector(discordComponentField)],['content','string'],['edited_timestamp',option(timestamp)],['embeds',vector(discordEmbedField)],['flags',option(discordMessageFlagsField)],['guild_id',option(id)],['id',id],['interaction',option(discordMessageInteractionField)],['interaction_metadata',option(discordInteractionMetadataField)],['type',unsigned(8)],['member',option(discordPartialMemberField)],['mention_channels',vector(discordChannelMentionField)],['mention_everyone','bool'],['mention_roles',vector(id)],['mentions',vector(discordMentionField)],['message_snapshots',vector(discordMessageSnapshotField)],['pinned','bool'],['poll',option(discordPollField)],['reactions',vector(discordReactionField)],['message_reference',option(discordMessageReferenceField)],['referenced_message',option(discordMessageField)],['role_subscription_data',option(discordRoleSubscriptionField)],['sticker_items',vector(discordMessageStickerField)],['timestamp',timestamp],['thread',option(discordChannelField)],['tts','bool'],['webhook_id',option(id)],
],['activity','application','application_id','call','edited_timestamp','flags','guild_id','interaction','interaction_metadata','member','poll','message_reference','referenced_message','role_subscription_data','thread','webhook_id'],{components:[],mention_channels:[],message_snapshots:[],reactions:[],sticker_items:[]});
/** Fully traverses recognized Message/transitive fields before returning its identity.
 * Returns validation projections; does not serialize models or authorize publication. */
export function decodeDiscordMessage(text:string):Record<string,unknown>{return parseSerdeField(text,discordMessageField) as Record<string,unknown>;}
export const discordMessageDecoder:DiscordMessageDecoder=Object.freeze({
 decode(body:Uint8Array):bigint{
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(body);
  return decodeDiscordMessage(text).id as bigint;
 },
});
