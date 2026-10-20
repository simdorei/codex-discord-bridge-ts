import {discordChannelField,discordMemberField,discordPresenceIntermediaryField} from './channel.ts';
import {discordStageInstanceField} from './gateway-dispatch-simple.ts';
import {discordUnavailableGuildField} from './gateway-ready.ts';
import {modelTimestamp as timestamp} from './timestamp.ts';
import {parseSerdeField,type StructField,type StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {modelOption as option,modelUnsigned as unsigned,modelSnowflake as id,modelImageHash as image,modelStruct as struct,modelVector as vector,modelShape as shape} from './fields.ts';
import {discordGuildEmojiField,discordScheduledEventField,discordVoiceStateField,discordStickerField} from './gateway-dispatch-related.ts';
import {discordRoleField} from './interaction-resolved.ts';
import {discordPermissionsField} from './message-parts.ts';
const u8=unsigned(8);
export const discordSystemChannelFlagsField:StructFieldDecoder=(_raw,_depth,context)=>(context.decode('u64') as bigint)&63n;
/** Pinned PartialGuild (the GUILD_UPDATE payload) is not an arbitrary partial
 * patch. Required fields are required despite the model name. */
const partialFields:readonly (readonly [string,StructField])[]=[
 ['afk_channel_id',option(id)],['afk_timeout',unsigned(16)],['application_id',option(id)],['banner',option(image)],['default_message_notifications',u8],['description','string?'],['discovery_splash',option(image)],['emojis',vector(discordGuildEmojiField)],['explicit_content_filter',u8],['features',vector('string')],['icon',option(image)],['id',id],['max_members',option('u64')],['max_presences',option('u64')],['member_count',option('u64')],['mfa_level',u8],['name','string'],['nsfw_level',u8],['owner_id',id],['owner',option('bool')],['permissions',option(discordPermissionsField)],['preferred_locale','string'],['premium_progress_bar_enabled','bool'],['premium_subscription_count',option('u64')],['premium_tier',u8],['public_updates_channel_id',option(id)],['roles',vector(discordRoleField)],['rules_channel_id',option(id)],['splash',option(image)],['system_channel_flags',discordSystemChannelFlagsField],['system_channel_id',option(id)],['verification_level',u8],['vanity_url_code','string?'],['widget_channel_id',option(id)],['widget_enabled',option('bool')],
];
const partialOptions=['afk_channel_id','application_id','banner','description','discovery_splash','icon','max_members','max_presences','member_count','owner','permissions','premium_subscription_count','public_updates_channel_id','rules_channel_id','splash','system_channel_id','vanity_url_code','widget_channel_id','widget_enabled'] as const;
export const discordPartialGuildField=struct(shape(partialFields,partialOptions));
export function decodeDiscordPartialGuild(text:string):Record<string,unknown>{return parseSerdeField(text,discordPartialGuildField) as Record<string,unknown>;}

const guildPresence:StructFieldDecoder=(raw,_depth,context)=>{if(raw.trim()[0]!=='{')throw new SyntaxError('Expected guild presence map');const {nick:_,...result}=context.decode(discordPresenceIntermediaryField) as Record<string,unknown>;return result;};
const guildFields:readonly (readonly [string,StructField])[]=[...partialFields,
 ['approximate_member_count',option('u64')],['approximate_presence_count',option('u64')],['channels',vector(discordChannelField)],['guild_scheduled_events',vector(discordScheduledEventField)],['joined_at',option(timestamp)],['large','bool'],['max_stage_video_channel_users',option('u64')],['max_video_channel_users',option('u64')],['members',vector(discordMemberField)],['presences',vector(guildPresence)],['safety_alerts_channel_id',option(id)],['stage_instances',vector(discordStageInstanceField)],['stickers',vector(discordStickerField)],['threads',vector(discordChannelField)],['unavailable','bool'],['voice_states',vector(discordVoiceStateField)],
];
const guildShape=shape(guildFields,[...partialOptions,'approximate_member_count','approximate_presence_count','joined_at','max_stage_video_channel_users','max_video_channel_users','safety_alerts_channel_id','unavailable'],{channels:[],emojis:[],guild_scheduled_events:[],large:false,members:[],premium_tier:0n,presences:[],stage_instances:[],stickers:[],threads:[],voice_states:[]});
/** Source Guild's custom map visitor defaults collections and later replaces
 * channel, presence, thread and voice-state guild identities with the parent ID. */
export const discordGuildField:StructFieldDecoder=(raw,_depth,context)=>{
 if(raw.trim()[0]!=='{')throw new SyntaxError('Expected Guild map');const value=context.struct(guildShape);
 for(const key of ['channels','presences','threads','voice_states'])for(const child of value[key] as Record<string,unknown>[])child.guild_id=value.id;
 return value;
};
/** Bounded untagged profile: validate all buffered content before trying the
 * Unavailable branch first. Retain original map traversal for duplicate fields.
 * These models contain no f64 or raw-vs-buffered anonymizable-ID fields. */
export const discordGuildCreateField:StructFieldDecoder=(_raw,_depth,context)=>{
 context.value();try{return {kind:'Unavailable',guild:context.decode(discordUnavailableGuildField)};}catch(error){if(!(error instanceof SyntaxError)&&!(error instanceof RangeError))throw error;}
 return {kind:'Available',guild:context.decode(discordGuildField)};
};
export function decodeDiscordGuild(text:string):Record<string,unknown>{return parseSerdeField(text,discordGuildField) as Record<string,unknown>;}
export function decodeDiscordGuildCreate(text:string):{kind:'Unavailable'|'Available';guild:Record<string,unknown>}{return parseSerdeField(text,discordGuildCreateField) as {kind:'Unavailable'|'Available';guild:Record<string,unknown>};}
