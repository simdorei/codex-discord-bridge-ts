import {parseSerdeField,type StructField,type StructFieldDecoder,type StructShape} from '../../core/serde-struct-json.ts';
import {modelOption as option,modelUnsigned as unsigned,modelSnowflake as id,modelImageHash as image,modelStruct as struct,modelVector as vector,modelShape as shape} from './fields.ts';
import {discordPermissionsField} from './message-parts.ts';
import {discordRelatedDispatchField} from './gateway-dispatch-related.ts';
import {modelTimestamp as timestamp} from './timestamp.ts';
const commandPermissions=discordRelatedDispatchField('APPLICATION_COMMAND_PERMISSIONS_UPDATE');
if(commandPermissions===undefined)throw new Error('Missing pinned command permission schema');
const overwrite=struct(shape([['allow',discordPermissionsField],['deny',discordPermissionsField],['id',id],['type',unsigned(8)]]));
const affectedRole=struct(shape([['id',id],['name','string']]));
const privacy:StructFieldDecoder=(_raw,_depth,context)=>{const value=context.decode(unsigned(8));if(value!==2n)throw new SyntaxError('Unknown audit stage privacy');return value;};
const typeValue:StructFieldDecoder=(_raw,_depth,context)=>{const value=context.value();if(typeof value==='string'||typeof value==='bigint'&&value>=0n&&value<(1n<<64n))return value;throw new SyntaxError('Expected unsigned integer or string change type');};
// Reviewed against all73 variants of the pinned source, including both explicit
// dollar-prefixed renames. No unknown variant is promoted to a known schema.
const definitions:readonly (readonly [string,StructField,'optional'|'required'|'vector'])[]=[
 ["afk_channel_id",id,"optional"],
 ["afk_timeout",'u64',"required"],
 ["allow",discordPermissionsField,"optional"],
 ["application_id",id,"optional"],
 ["archived",'bool',"optional"],
 ["asset",'string',"optional"],
 ["auto_archive_duration",unsigned(16),"optional"],
 ["available",'bool',"optional"],
 ["avatar_hash",image,"optional"],
 ["banner_hash",image,"optional"],
 ["bitrate",'u64',"optional"],
 ["channel_id",id,"optional"],
 ["code",'string',"optional"],
 ["color",'u64',"optional"],
 ["command_id",commandPermissions,"optional"],
 ["communication_disabled_until",timestamp,"optional"],
 ["deaf",'bool',"optional"],
 ["default_auto_archive_duration",unsigned(16),"optional"],
 ["default_message_notifications",unsigned(8),"optional"],
 ["deny",discordPermissionsField,"optional"],
 ["description",'string',"optional"],
 ["discovery_splash_hash",image,"optional"],
 ["enable_emoticons",'bool',"optional"],
 ["entity_type",'u64',"optional"],
 ["expire_behavior",'u64',"optional"],
 ["expire_grace_period",'u64',"optional"],
 ["explicit_content_filter",unsigned(8),"optional"],
 ["format_type",unsigned(8),"optional"],
 ["guild_id",id,"optional"],
 ["hoist",'bool',"optional"],
 ["icon_hash",image,"optional"],
 ["id",id,"optional"],
 ["image_hash",image,"optional"],
 ["invitable",'bool',"optional"],
 ["inviter_id",id,"optional"],
 ["location",'string',"optional"],
 ["locked",'bool',"optional"],
 ["max_age",'u64',"optional"],
 ["max_uses",'u64',"optional"],
 ["mentionable",'bool',"optional"],
 ["mfa_level",unsigned(8),"optional"],
 ["mute",'bool',"optional"],
 ["name",'string',"optional"],
 ["nick",'string',"optional"],
 ["nsfw",'bool',"optional"],
 ["nsfw_level",unsigned(8),"optional"],
 ["owner_id",id,"optional"],
 ["permission_overwrites",vector(overwrite),"optional"],
 ["permissions",discordPermissionsField,"optional"],
 ["position",'u64',"optional"],
 ["preferred_locale",'string',"optional"],
 ["privacy_level",privacy,"optional"],
 ["prune_delete_days",'u64',"optional"],
 ["public_updates_channel_id",id,"optional"],
 ["rate_limit_per_user",'u64',"optional"],
 ["region",'string',"optional"],
 ["$add",vector(affectedRole),"vector"],
 ["$remove",vector(affectedRole),"vector"],
 ["rules_channel_id",id,"optional"],
 ["splash_hash",image,"optional"],
 ["status",'u64',"optional"],
 ["system_channel_id",id,"optional"],
 ["tags",'string',"optional"],
 ["temporary",'bool',"optional"],
 ["topic",'string',"optional"],
 ["type",typeValue,"optional"],
 ["unicode_emoji",'string',"optional"],
 ["user_limit",'u64',"optional"],
 ["uses",'u64',"optional"],
 ["vanity_url_code",'string',"optional"],
 ["verification_level",unsigned(8),"optional"],
 ["widget_channel_id",id,"optional"],
 ["widget_enabled",'bool',"optional"],
];
const variants=new Map<string,StructShape>();
for(const [key,field,mode] of definitions)variants.set(key,shape([['key','string'],['new_value',mode==='optional'?option(field):field],['old_value',mode==='optional'?option(field):field]],mode==='optional'?['new_value','old_value']:[],mode==='vector'?{new_value:[],old_value:[]}:{}));
/** Internally tagged source enum buffers non-tag fields before variant selection.
 * Validate all content but retain original traversal for duplicate keys. Known
 * child schemas here contain no f64 or anonymizable-ID context differences. */
export const discordAuditLogChangeField:StructFieldDecoder=(raw,_depth,context)=>{
 const buffered=context.value();let key:string|undefined;
 if(Array.isArray(buffered)){if(typeof buffered[0]!=='string')throw new SyntaxError('Missing audit change tag');key=buffered[0];}
 else context.map((name,decode)=>{if(name==='key'){if(key!==undefined)throw new SyntaxError('Duplicate audit change tag');key=decode('string') as string;}});
 if(key===undefined)throw new SyntaxError('Missing audit change tag');const variant=variants.get(key);
 if(variant===undefined){if(Array.isArray(buffered)&&buffered.length!==1)throw new SyntaxError('Unconsumed Other change sequence');return {kind:'Other'};}
 return context.struct(variant);
};
const optionFields:readonly (readonly [string,StructField])[]=[['auto_moderation_rule_name','string?'],['auto_moderation_rule_trigger_type','string?'],['channel_id',option(id)],['count','string?'],['delete_member_days','string?'],['id',option(id)],['integration_type','string?'],['type','string?'],['members_removed','string?'],['message_id',option(id)],['role_name','string?']];
const info=struct(shape(optionFields,optionFields.map(([name])=>name)));
export const discordAuditLogEntryField=struct(shape([['action_type',unsigned(16)],['changes',vector(discordAuditLogChangeField)],['guild_id',option(id)],['id',id],['options',option(info)],['reason','string?'],['target_id',option(id)],['user_id',option(id)]],['guild_id','options','reason','target_id','user_id'],{changes:[]}));
export function decodeDiscordAuditLogEntry(text:string):Record<string,unknown>{return parseSerdeField(text,discordAuditLogEntryField) as Record<string,unknown>;}
export function decodeDiscordAuditLogChange(text:string):Record<string,unknown>{return parseSerdeField(text,discordAuditLogChangeField) as Record<string,unknown>;}
