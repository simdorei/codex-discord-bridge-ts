import {parseSerdeField,type StructField,type StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {modelOption as option,modelUnsigned as unsigned,modelSnowflake as id,modelImageHash as image,modelStruct as struct,modelVector as vector,modelShape as shape} from './fields.ts';
import {discordUserField,discordAvatarDecorationField} from './user.ts';
import {discordPermissionsField} from './message-parts.ts';
import {modelTimestamp as timestamp} from './timestamp.ts';
const u8=unsigned(8),u16=unsigned(16),u32=unsigned(32);
const signed=(bits:number):StructFieldDecoder=>(_raw,_depth,context)=>{const n=context.decode('i64') as bigint,bound=1n<<BigInt(bits-1);if(n< -bound||n>=bound)throw new SyntaxError(`Expected i${bits}`);return n;};
const memberFlags:StructFieldDecoder=(_raw,_depth,context)=>(context.decode('u64') as bigint)&15n;
export const discordMemberField=struct(shape([
 ['avatar',option(image)],['avatar_decoration_data',option(discordAvatarDecorationField)],['banner',option(image)],['communication_disabled_until',option(timestamp)],['deaf','bool'],['flags',memberFlags],['joined_at',option(timestamp)],['mute','bool'],['nick','string?'],['pending','bool'],['premium_since',option(timestamp)],['roles',vector(id)],['user',discordUserField],
],['avatar','avatar_decoration_data','banner','communication_disabled_until','joined_at','nick','premium_since'],{pending:false}));
const statusNames=new Set(['dnd','idle','invisible','offline','online']);
const status:StructFieldDecoder=(_raw,_depth,context)=>{
 const value=context.value();if(typeof value==='string'&&statusNames.has(value))return value;
 if(value===null||typeof value!=='object'||Array.isArray(value))throw new SyntaxError('Invalid presence status');
 const names=Object.keys(value);if(names.length!==1||!statusNames.has(names[0]!))throw new SyntaxError('Unknown presence status');
 const name=names[0]!,result=context.struct(shape([[name,'value']]));if(result[name]!==null)throw new SyntaxError('Expected unit presence status');return name;
};
const clientStatus=struct(shape([['desktop',option(status)],['mobile',option(status)],['web',option(status)]],['desktop','mobile','web']));
const userOrId:StructFieldDecoder=(raw,_depth,context)=>{
 context.value();try{return {kind:'User',value:context.decode(discordUserField)};}catch(error){if(!(error instanceof SyntaxError))throw error;}
 if(raw.trim()[0]!=='{')throw new SyntaxError('Expected presence UserId map');
 return {kind:'UserId',...context.struct(shape([['id',id]]))};
};
const activityAssets=struct(shape([['large_image','string?'],['large_text','string?'],['small_image','string?'],['small_text','string?']],['large_image','large_text','small_image','small_text']));
const button:StructFieldDecoder=(raw,_depth,context)=>{
 if(raw.trim()[0]==='"')return {kind:'Text',label:context.decode('string')};
 if(raw.trim()[0]!=='{')throw new SyntaxError('Expected activity button map or string');
 return {kind:'Link',...context.struct(shape([['label','string'],['url','string']]))};
};
const activityEmoji=struct(shape([['animated',option('bool')],['name','string'],['id','string?']],['animated','id']));
const activityFlags:StructFieldDecoder=(_raw,_depth,context)=>(context.decode('u64') as bigint)&511n;
const partySize:StructFieldDecoder=(_raw,_depth,context)=>{const values=context.array('u64');if(values.length!==2)throw new SyntaxError('Expected activity party size tuple');return values;};
const activityParty=struct(shape([['id','string?'],['size',option(partySize)]],['id','size']));
const activitySecrets=struct(shape([['join','string?'],['match','string?'],['spectate','string?']],['join','match','spectate']));
const activityTimestamps=struct(shape([['end',option('u64')],['start',option('u64')]],['end','start']));
export const discordPresenceActivityField=struct(shape([
 ['application_id',option(id)],['assets',option(activityAssets)],['buttons',vector(button)],['created_at',option('u64')],['details','string?'],['emoji',option(activityEmoji)],['flags',option(activityFlags)],['id','string?'],['instance',option('bool')],['type',u8],['name','string'],['party',option(activityParty)],['secrets',option(activitySecrets)],['state','string?'],['timestamps',option(activityTimestamps)],['url','string?'],
],['application_id','assets','created_at','details','emoji','flags','id','instance','party','secrets','state','timestamps','url'],{buttons:[],type:0n}));
export const discordPresenceField=struct(shape([['activities',vector(discordPresenceActivityField)],['client_status',clientStatus],['guild_id',id],['status',status],['user',userOrId]],[],{activities:[]}));
export const discordThreadMemberField=struct(shape([['flags','u64'],['id',option(id)],['join_timestamp',timestamp],['member',option(discordMemberField)],['presence',option(discordPresenceField)],['user_id',option(id)]],['id','member','presence','user_id']));
export const discordThreadMetadataField=struct(shape([['archived','bool'],['auto_archive_duration',u16],['archive_timestamp',timestamp],['create_timestamp',option(timestamp)],['invitable',option('bool')],['locked','bool']],['create_timestamp','invitable'],{locked:false}));
/** Pinned zeroable_id custom visitor accepts numeric zero/null. Its string arm
 * calls nonzero Id::from_str, so the string "0" is rejected despite its doc text. */
const zeroableId:StructFieldDecoder=(raw,_depth,context)=>{
 const value=context.value();if(value===null||value===0n)return null;return context.decode(id);
};
const forumTag=struct(shape([['emoji_id',zeroableId],['emoji_name','string?'],['id',id],['moderated','bool'],['name','string']],['emoji_name']));
const defaultReaction=struct(shape([['emoji_id',option(id)],['emoji_name','string?']],['emoji_id','emoji_name']));
const permissionOverwrite=struct(shape([['allow',discordPermissionsField],['deny',discordPermissionsField],['id',id],['type',u8]]));
const channelFlags:StructFieldDecoder=(_raw,_depth,context)=>(context.decode('u64') as bigint)&18n;
const channelFields:readonly (readonly [string,StructField])[]=[
 ['application_id',option(id)],['applied_tags',option(vector(id))],['available_tags',option(vector(forumTag))],['bitrate',option(u32)],['default_auto_archive_duration',option(u16)],['default_forum_layout',option(u8)],['default_reaction_emoji',option(defaultReaction)],['default_sort_order',option(u8)],['default_thread_rate_limit_per_user',option(u16)],['flags',option(channelFlags)],['guild_id',option(id)],['icon',option(image)],['id',id],['invitable',option('bool')],['type',u8],['last_message_id',option(id)],['last_pin_timestamp',option(timestamp)],['managed',option('bool')],['member',option(discordThreadMemberField)],['member_count',option(signed(8))],['message_count',option(u32)],['name','string?'],['newly_created',option('bool')],['nsfw',option('bool')],['owner_id',option(id)],['parent_id',option(id)],['permission_overwrites',option(vector(permissionOverwrite))],['position',option(signed(32))],['rate_limit_per_user',option(u16)],['recipients',option(vector(discordUserField))],['rtc_region','string?'],['thread_metadata',option(discordThreadMetadataField)],['topic','string?'],['user_limit',option(u32)],['video_quality_mode',option(u8)],
];
export const discordChannelField=struct(shape(channelFields,channelFields.map(([name])=>name).filter(name=>name!=='id'&&name!=='type')));
/** Validation projection only; does not open a channel, subscribe to Gateway, or serialize. */
export function decodeDiscordChannel(text:string):Record<string,unknown>{return parseSerdeField(text,discordChannelField) as Record<string,unknown>;}
