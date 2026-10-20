import {parseSerdeField,type StructField,type StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {modelOption as option,modelUnsigned as unsigned,modelSnowflake as id,modelImageHash as image,modelStruct as struct,modelVector as vector,modelShape as shape,unsignedText} from './fields.ts';
import {discordUserField,discordAvatarDecorationField} from './user.ts';
import {discordPermissionsField} from './message-parts.ts';
import {discordThreadMetadataField} from './channel.ts';
import {discordMessageField} from './message.ts';
import {discordAttachmentField} from './media.ts';
import {modelTimestamp as timestamp} from './timestamp.ts';
const u8=unsigned(8),u32=unsigned(32);
const nullBoolean:StructFieldDecoder=(raw)=>{if(raw.trim()!=='null')throw new SyntaxError('Expected null role tag');return true;};
const roleFlags:StructFieldDecoder=(_raw,_depth,context)=>(context.decode('u64') as bigint)&1n;
const memberFlags:StructFieldDecoder=(_raw,_depth,context)=>(context.decode('u64') as bigint)&15n;
export const discordRoleTagsField=struct(shape([
 ['available_for_purchase',nullBoolean],['bot_id',option(id)],['guild_connections',nullBoolean],['integration_id',option(id)],['subscription_listing_id',option(id)],['premium_subscriber',nullBoolean],
],['bot_id','integration_id','subscription_listing_id'],{available_for_purchase:false,guild_connections:false,premium_subscriber:false}));
export const discordRoleColorsField=struct(shape([['primary_color',u32],['secondary_color',option(u32)],['tertiary_color',option(u32)]],['secondary_color','tertiary_color']));
export const discordRoleField=struct(shape([
 ['color',u32],['colors',discordRoleColorsField],['hoist','bool'],['icon',option(image)],['id',id],['managed','bool'],['mentionable','bool'],['name','string'],['permissions',discordPermissionsField],['position','i64'],['flags',roleFlags],['tags',option(discordRoleTagsField)],['unicode_emoji','string?'],
],['icon','tags','unicode_emoji']));
export const discordInteractionChannelField=struct(shape([
 ['id',id],['type',u8],['name','string'],['parent_id',option(id)],['permissions',discordPermissionsField],['thread_metadata',option(discordThreadMetadataField)],
],['parent_id','thread_metadata']));
export const discordInteractionMemberField=struct(shape([
 ['avatar',option(image)],['avatar_decoration_data',option(discordAvatarDecorationField)],['banner',option(image)],['communication_disabled_until',option(timestamp)],['flags',memberFlags],['joined_at',option(timestamp)],['nick','string?'],['pending','bool'],['permissions',discordPermissionsField],['premium_since',option(timestamp)],['roles',vector(id)],
],['avatar','avatar_decoration_data','banner','communication_disabled_until','joined_at','nick','premium_since'],{roles:[]}));
/** HashMap<Id, T>: string keys normalize losslessly, zero is invalid, duplicate
 * normalized keys replace earlier values after each earlier value was validated.
 * Null-prototype records avoid prototype keys; this is not an order guarantee. */
export function discordIdMap(field:StructField):StructFieldDecoder{return (_raw,_depth,context)=>{const result=Object.create(null) as Record<string,unknown>;context.map((key,decode)=>{const keyId=unsignedText(key,64);if(keyId===0n)throw new SyntaxError('Expected nonzero resolved ID');result[keyId.toString()]=decode(field);});return result;};}
export const discordInteractionResolvedField=struct(shape([
 ['attachments',discordIdMap(discordAttachmentField)],['channels',discordIdMap(discordInteractionChannelField)],['members',discordIdMap(discordInteractionMemberField)],['messages',discordIdMap(discordMessageField)],['roles',discordIdMap(discordRoleField)],['users',discordIdMap(discordUserField)],
],[],{attachments:{},channels:{},members:{},messages:{},roles:{},users:{}}));
export const discordEntitlementField=struct(shape([
 ['application_id',id],['consumed',option('bool')],['deleted','bool'],['ends_at',option(timestamp)],['guild_id',option(id)],['id',id],['type',u8],['sku_id',id],['starts_at',option(timestamp)],['user_id',option(id)],
],['consumed','ends_at','guild_id','starts_at','user_id']));
/** Validation projection only; no live Gateway, authorization or serialization. */
export function decodeDiscordInteractionResolved(text:string):Record<string,unknown>{return parseSerdeField(text,discordInteractionResolvedField) as Record<string,unknown>;}
