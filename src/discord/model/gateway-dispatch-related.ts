import {parseSerdeField,type StructField,type StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {modelOption as option,modelUnsigned as unsigned,modelSnowflake as id,modelImageHash as image,modelStruct as struct,modelVector as vector,modelShape as shape} from './fields.ts';
import {discordUserField} from './user.ts';
import {discordMemberField} from './channel.ts';
import {modelTimestamp as timestamp} from './timestamp.ts';
const u8=unsigned(8);
const permissionType:StructFieldDecoder=(_raw,_depth,context)=>{const value=context.decode(u8) as bigint;if(value<1n||value>3n)throw new SyntaxError('Unknown command permission type');return value;};
const permission=struct(shape([['id',id],['type',permissionType],['permission','bool']]));
export const discordGuildEmojiField=struct(shape([['animated','bool'],['available','bool'],['id',id],['managed','bool'],['name','string'],['require_colons','bool'],['roles',vector(id)],['user',option(discordUserField)]],['user'],{animated:false,available:false,managed:false,require_colons:false,roles:[]}));
export const discordStickerField=struct(shape([['available','bool'],['description','string?'],['format_type',u8],['guild_id',option(id)],['id',id],['type',u8],['name','string'],['pack_id',option(id)],['sort_value',option('u64')],['tags','string'],['user',option(discordUserField)]],['description','guild_id','pack_id','sort_value','user'],{available:false}));
export const discordVoiceStateField=struct(shape([
 ['channel_id',option(id)],['deaf','bool'],['guild_id',option(id)],['member',option(discordMemberField)],['mute','bool'],['self_deaf','bool'],['self_mute','bool'],['self_stream','bool'],['self_video','bool'],['session_id','string'],['suppress','bool'],['user_id',id],['request_to_speak_timestamp',option(timestamp)],
],['channel_id','guild_id','member','request_to_speak_timestamp'],{self_stream:false}));
const entityMetadata=struct(shape([['location','string?']],['location']));
export const discordScheduledEventField=struct(shape([
 ['channel_id',option(id)],['creator',option(discordUserField)],['creator_id',option(id)],['description','string?'],['entity_id',option(id)],['entity_metadata',option(entityMetadata)],['entity_type',u8],['guild_id',id],['id',id],['image',option(image)],['name','string'],['privacy_level',u8],['scheduled_end_time',option(timestamp)],['scheduled_start_time',timestamp],['status',u8],['user_count',option('u64')],
],['channel_id','creator','creator_id','description','entity_id','entity_metadata','image','scheduled_end_time','user_count']));
const fields=new Map<string,StructField>([
 ['APPLICATION_COMMAND_PERMISSIONS_UPDATE',struct(shape([['application_id',id],['guild_id',id],['id',id],['permissions',vector(permission)]]))],
 ['VOICE_STATE_UPDATE',discordVoiceStateField],
 ['GUILD_EMOJIS_UPDATE',struct(shape([['emojis',vector(discordGuildEmojiField)],['guild_id',id]]))],
 ['GUILD_STICKERS_UPDATE',struct(shape([['guild_id',id],['stickers',vector(discordStickerField)]]))],
 ['GUILD_SCHEDULED_EVENT_CREATE',discordScheduledEventField],['GUILD_SCHEDULED_EVENT_DELETE',discordScheduledEventField],['GUILD_SCHEDULED_EVENT_UPDATE',discordScheduledEventField],
]);
/** Partial related-model registry, with source-shaped validation projections. */
export function discordRelatedDispatchField(name:string):StructField|undefined{return fields.get(name);}
export function decodeDiscordRelatedDispatch(name:string,text:string):Record<string,unknown>{const field=fields.get(name);if(field===undefined)throw new SyntaxError('Unsupported related dispatch model');return parseSerdeField(text,field) as Record<string,unknown>;}
