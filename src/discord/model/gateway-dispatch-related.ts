import {parseSerdeField,type StructField,type StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {modelOption as option,modelUnsigned as unsigned,modelSnowflake as id,modelImageHash as image,modelStruct as struct,modelVector as vector,modelShape as shape} from './fields.ts';
import {discordMessageField} from './message.ts';
import {discordUserField,discordDiscriminatorField} from './user.ts';
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
const actionMetadata=struct(shape([['channel_id',option(id)],['custom_message','string?'],['duration_seconds',option(unsigned(32))]],['channel_id','custom_message','duration_seconds']));
export const discordAutoModerationActionField=struct(shape([['type',u8],['metadata',option(actionMetadata)]],['metadata']));
const triggerMetadata=struct(shape([['allow_list',option(vector('string'))],['keyword_filter',option(vector('string'))],['presets',option(vector(u8))],['mention_raid_protection_enabled',option('bool')],['mention_total_limit',option(u8)],['regex_patterns',option(vector('string'))]],['allow_list','keyword_filter','presets','mention_raid_protection_enabled','mention_total_limit','regex_patterns']));
export const discordAutoModerationRuleField=struct(shape([['actions',vector(discordAutoModerationActionField)],['creator_id',id],['enabled','bool'],['event_type',u8],['exempt_channels',vector(id)],['exempt_roles',vector(id)],['guild_id',id],['id',id],['name','string'],['trigger_metadata',triggerMetadata],['trigger_type',u8]]));
const memberFlags:StructFieldDecoder=(_raw,_depth,context)=>(context.decode('u64') as bigint)&15n;
const memberUpdate=struct(shape([['avatar',option(image)],['communication_disabled_until',option(timestamp)],['guild_id',id],['flags',option(memberFlags)],['deaf',option('bool')],['joined_at',option(timestamp)],['mute',option('bool')],['nick','string?'],['pending','bool'],['premium_since',option(timestamp)],['roles',vector(id)],['user',discordUserField]],['avatar','communication_disabled_until','flags','deaf','joined_at','mute','nick','premium_since'],{pending:false}));
const integrationAccount=struct(shape([['id','string'],['name','string']]));
const integrationApplication=struct(shape([['bot',option(discordUserField)],['description','string'],['icon',option(image)],['id',id],['name','string']],['bot','icon']));
export const discordGuildIntegrationField=struct(shape([['account',integrationAccount],['application',option(integrationApplication)],['enable_emoticons',option('bool')],['enabled',option('bool')],['expire_behavior',option(u8)],['expire_grace_period',option('u64')],['guild_id',option(id)],['id',id],['type','string'],['name','string'],['revoked',option('bool')],['role_id',option(id)],['scopes',option(vector('string'))],['subscriber_count',option('u64')],['synced_at',option(timestamp)],['syncing',option('bool')],['user',option(discordUserField)]],['application','enable_emoticons','enabled','expire_behavior','expire_grace_period','guild_id','revoked','role_id','scopes','subscriber_count','synced_at','syncing','user']));
const invitePartialUser=struct(shape([['avatar',option(image)],['discriminator',discordDiscriminatorField],['id',id],['username','string']],['avatar']));
const inviteCreate=struct(shape([['channel_id',id],['code','string'],['created_at',timestamp],['guild_id',id],['inviter',option(discordUserField)],['max_age','u64'],['max_uses','u64'],['target_user_type',option(u8)],['target_user',option(invitePartialUser)],['temporary','bool'],['uses',u8]],['inviter','target_user_type','target_user']));
const fields=new Map<string,StructField>([
 ['INTEGRATION_CREATE',discordGuildIntegrationField],['INTEGRATION_UPDATE',discordGuildIntegrationField],['INVITE_CREATE',inviteCreate],['MESSAGE_UPDATE',discordMessageField],
 ['AUTO_MODERATION_RULE_CREATE',discordAutoModerationRuleField],['AUTO_MODERATION_RULE_DELETE',discordAutoModerationRuleField],['AUTO_MODERATION_RULE_UPDATE',discordAutoModerationRuleField],
 ['AUTO_MODERATION_ACTION_EXECUTION',struct(shape([['action',discordAutoModerationActionField],['alert_system_message_id',option(id)],['channel_id',option(id)],['content','string'],['guild_id',id],['matched_content','string?'],['matched_keyword','string?'],['message_id',option(id)],['rule_id',id],['rule_trigger_type',u8],['user_id',id]],['alert_system_message_id','channel_id','matched_content','matched_keyword','message_id']))],
 ['GUILD_MEMBER_UPDATE',memberUpdate],
 ['APPLICATION_COMMAND_PERMISSIONS_UPDATE',struct(shape([['application_id',id],['guild_id',id],['id',id],['permissions',vector(permission)]]))],
 ['VOICE_STATE_UPDATE',discordVoiceStateField],
 ['GUILD_EMOJIS_UPDATE',struct(shape([['emojis',vector(discordGuildEmojiField)],['guild_id',id]]))],
 ['GUILD_STICKERS_UPDATE',struct(shape([['guild_id',id],['stickers',vector(discordStickerField)]]))],
 ['GUILD_SCHEDULED_EVENT_CREATE',discordScheduledEventField],['GUILD_SCHEDULED_EVENT_DELETE',discordScheduledEventField],['GUILD_SCHEDULED_EVENT_UPDATE',discordScheduledEventField],
]);
/** Partial related-model registry, with source-shaped validation projections. */
export function discordRelatedDispatchField(name:string):StructField|undefined{return fields.get(name);}
export function decodeDiscordRelatedDispatch(name:string,text:string):Record<string,unknown>{const field=fields.get(name);if(field===undefined)throw new SyntaxError('Unsupported related dispatch model');return parseSerdeField(text,field) as Record<string,unknown>;}
