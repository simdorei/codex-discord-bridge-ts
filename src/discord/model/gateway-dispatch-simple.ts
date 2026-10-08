import {parseSerdeField,type StructField,type StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {modelOption as option,modelUnsigned as unsigned,modelSnowflake as id,modelStruct as struct,modelVector as vector,modelShape as shape} from './fields.ts';
import {discordChannelField,discordMemberField,discordPresenceField,discordThreadMemberField} from './channel.ts';
import {discordUserField} from './user.ts';
import {discordCurrentUserField} from './gateway-ready.ts';
import {discordEmojiField} from './component.ts';
import {discordRoleField,discordEntitlementField} from './interaction-resolved.ts';
import {discordHexColorField} from './message-parts.ts';
import {modelTimestamp as timestamp} from './timestamp.ts';
const ban=struct(shape([['guild_id',id],['user',discordUserField]]));
const vote=struct(shape([['answer_id',unsigned(8)],['channel_id',id],['guild_id',option(id)],['message_id',id],['user_id',id]],['guild_id']));
const role=struct(shape([['guild_id',id],['role',discordRoleField]]));
const scheduledUser=struct(shape([['guild_id',id],['guild_scheduled_event_id',id],['user_id',id]]));
const stagePrivacy:StructFieldDecoder=(_raw,_depth,context)=>{const value=context.decode(unsigned(8));if(value!==2n)throw new SyntaxError('Unknown stage privacy level');return value;};
export const discordStageInstanceField=struct(shape([['channel_id',id],['guild_id',id],['guild_scheduled_event_id',option(id)],['id',id],['privacy_level',stagePrivacy],['topic','string']],['guild_scheduled_event_id']));
const reaction=struct(shape([['burst','bool'],['burst_colors',vector(discordHexColorField)],['channel_id',id],['emoji',discordEmojiField],['guild_id',option(id)],['member',option(discordMemberField)],['message_author_id',option(id)],['message_id',id],['user_id',id]],['guild_id','member','message_author_id'],{burst_colors:[]}));
// Private registry: callers cannot mutate its membership or install new schemas.
const fields=new Map<string,StructField>([
 ['STAGE_INSTANCE_CREATE',discordStageInstanceField],['STAGE_INSTANCE_UPDATE',discordStageInstanceField],['STAGE_INSTANCE_DELETE',discordStageInstanceField],
 ['GUILD_MEMBER_REMOVE',ban],['PRESENCE_UPDATE',discordPresenceField],
 ['TYPING_START',struct(shape([['channel_id',id],['guild_id',option(id)],['member',option(discordMemberField)],['timestamp','u64'],['user_id',id]],['guild_id','member']))],
 ['THREAD_LIST_SYNC',struct(shape([['channel_ids',vector(id)],['guild_id',id],['members',vector(discordThreadMemberField)],['threads',vector(discordChannelField)]],[],{channel_ids:[]}))],
 ['MESSAGE_REACTION_ADD',reaction],['MESSAGE_REACTION_REMOVE',reaction],
 ['THREAD_CREATE',discordChannelField],['THREAD_UPDATE',discordChannelField],
 ['GUILD_ROLE_CREATE',role],['GUILD_ROLE_UPDATE',role],
 ['INTEGRATION_DELETE',struct(shape([['application_id',option(id)],['guild_id',id],['id',id]],['application_id']))],
 ['VOICE_SERVER_UPDATE',struct(shape([['endpoint','string?'],['guild_id',id],['token','string']],['endpoint']))],
 ['MESSAGE_REACTION_REMOVE_ALL',struct(shape([['channel_id',id],['message_id',id],['guild_id',option(id)]],['guild_id']))],
 ['MESSAGE_REACTION_REMOVE_EMOJI',struct(shape([['channel_id',id],['emoji',discordEmojiField],['guild_id',id],['message_id',id]]))],
 ['GUILD_SCHEDULED_EVENT_USER_ADD',scheduledUser],['GUILD_SCHEDULED_EVENT_USER_REMOVE',scheduledUser],
 ['CHANNEL_CREATE',discordChannelField],['CHANNEL_UPDATE',discordChannelField],['CHANNEL_DELETE',discordChannelField],
 ['CHANNEL_PINS_UPDATE',struct(shape([['channel_id',id],['guild_id',option(id)],['last_pin_timestamp',option(timestamp)]],['guild_id','last_pin_timestamp']))],
 ['ENTITLEMENT_CREATE',discordEntitlementField],['USER_UPDATE',discordCurrentUserField],
 ['GUILD_BAN_ADD',ban],['GUILD_BAN_REMOVE',ban],
 ['GUILD_DELETE',struct(shape([['id',id],['unavailable',option('bool')]],['unavailable']))],
 ['GUILD_INTEGRATIONS_UPDATE',struct(shape([['guild_id',id]]))],
 ['GUILD_ROLE_DELETE',struct(shape([['guild_id',id],['role_id',id]]))],
 ['INVITE_DELETE',struct(shape([['channel_id',id],['code','string'],['guild_id',id]]))],
 ['MESSAGE_DELETE',struct(shape([['channel_id',id],['guild_id',option(id)],['id',id]],['guild_id']))],
 ['MESSAGE_DELETE_BULK',struct(shape([['channel_id',id],['guild_id',option(id)],['ids',vector(id)]],['guild_id']))],
 ['MESSAGE_POLL_VOTE_ADD',vote],['MESSAGE_POLL_VOTE_REMOVE',vote],
 ['THREAD_DELETE',struct(shape([['guild_id',id],['id',id],['type',unsigned(8)],['parent_id',id]]))],
 ['WEBHOOKS_UPDATE',struct(shape([['channel_id',id],['guild_id',id]]))],
]);
/** Partial schema registry, not an all-event decoder. undefined means unimplemented
 * here, NEVER permission to silently discard a known source event. */
export function discordSimpleDispatchField(eventType:string):StructField|undefined{return fields.get(eventType);}
export function decodeDiscordSimpleDispatch(eventType:string,text:string):Record<string,unknown>{const field=fields.get(eventType);if(field===undefined)throw new SyntaxError('Unsupported simple dispatch model');return parseSerdeField(text,field) as Record<string,unknown>;}
