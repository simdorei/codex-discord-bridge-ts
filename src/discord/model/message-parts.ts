import type {StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {modelOption as option,modelUnsigned as unsigned,modelSnowflake as id,modelImageHash as image,modelStruct as struct,modelVector as vector,modelShape as shape,unsignedText} from './fields.ts';
import {discordUserField,discordUserFlagsField,discordDiscriminatorField,discordAvatarDecorationField} from './user.ts';
import {modelTimestamp as timestamp} from './timestamp.ts';
import {discordEmojiField,discordComponentField} from './component.ts';
import {discordAttachmentField,discordEmbedField} from './media.ts';
const u8=unsigned(8),u16=unsigned(16);
const permissionsMask=((1n<<47n)-1n)|(15n<<49n);
export const discordPermissionsField:StructFieldDecoder=(_raw,_depth,context)=>{
 const value=context.value(),n=typeof value==='string'?unsignedText(value,64):value;
 if(typeof n!=='bigint'||n<0n||n>=(1n<<64n))throw new SyntaxError('Expected permissions string or unsigned integer');
 return n&permissionsMask;
};
const memberFlags:StructFieldDecoder=(_raw,_depth,context)=>(context.decode('u64') as bigint)&15n;
export const discordPartialMemberField=struct(shape([
 ['avatar',option(image)],['avatar_decoration_data',option(discordAvatarDecorationField)],['banner',option(image)],
 ['communication_disabled_until',option(timestamp)],['deaf','bool'],['flags',memberFlags],['joined_at',option(timestamp)],
 ['mute','bool'],['nick','string?'],['permissions',option(discordPermissionsField)],['premium_since',option(timestamp)],['roles',vector(id)],['user',option(discordUserField)],
],['avatar','avatar_decoration_data','banner','communication_disabled_until','joined_at','nick','permissions','premium_since','user']));
export const discordMentionField=struct(shape([
 ['avatar',option(image)],['bot','bool'],['discriminator',discordDiscriminatorField],['id',id],['member',option(discordPartialMemberField)],['username','string'],['public_flags',discordUserFlagsField],
],['avatar','member'],{bot:false}));
export const discordChannelMentionField=struct(shape([['guild_id',id],['id',id],['type',u8],['name','string']]));
export const discordMessageActivityField=struct(shape([['type',u8],['party_id','string?']],['party_id']));
export const discordMessageApplicationField=struct(shape([['cover_image',option(image)],['description','string'],['icon',option(image)],['id',id],['name','string']],['cover_image','icon']));
export const discordMessageCallField=struct(shape([['ended_timestamp',option(timestamp)],['participants',vector(id)]],['ended_timestamp'],{participants:[]}));
export const discordInteractionTypeField:StructFieldDecoder=(_raw,_depth,context)=>{const value=context.decode(u8) as bigint;if(value<1n||value>5n)throw new SyntaxError('Unknown interaction type');return value;};
export const discordMessageInteractionField=struct(shape([['id',id],['type',discordInteractionTypeField],['member',option(discordPartialMemberField)],['name','string'],['user',discordUserField]],['member']));
export const discordMessageReferenceField=struct(shape([['channel_id',option(id)],['guild_id',option(id)],['type',u8],['message_id',option(id)],['fail_if_not_exists',option('bool')]],['channel_id','guild_id','message_id','fail_if_not_exists'],{type:0n}));
export const discordRoleSubscriptionField=struct(shape([['is_renewal','bool'],['role_subscription_listing_id',id],['tier_name','string'],['total_months_subscribed',u16]]));
export const discordMessageStickerField=struct(shape([['format_type',u8],['id',id],['name','string']]));
const messageMask=511n|(1n<<12n)|(1n<<13n)|(1n<<15n);
export const discordMessageFlagsField:StructFieldDecoder=(_raw,_depth,context)=>(context.decode('u64') as bigint)&messageMask;
export const discordMessageSnapshotField=struct(shape([
 ['message',struct(shape([
  ['attachments',vector(discordAttachmentField)],['components',vector(discordComponentField)],['content','string'],['edited_timestamp',option(timestamp)],['embeds',vector(discordEmbedField)],['flags',option(discordMessageFlagsField)],['type',u8],['mentions',vector(discordMentionField)],['mention_roles',vector(id)],['sticker_items',vector(discordMessageStickerField)],['timestamp',timestamp],
 ],['edited_timestamp','flags'],{components:[],mentions:[],mention_roles:[],sticker_items:[]}))],['guild_id',option(id)],
],['guild_id']));
/** Twilight HexColor parses each short digit as 0..15, not CSS's nibble repeat.
 * It removes every initial '#'; radix parsing also accepts '+' in a two-byte pair.
 * Non-ASCII values are rejected; Rust's invalid UTF-8 slice panic is not reproduced. */
export const discordHexColorField:StructFieldDecoder=(_raw,_depth,context)=>{
 const text=context.decode('string') as string;if(!text.startsWith('#'))throw new SyntaxError('Expected hex color');
 const body=text.replace(/^#+/u,''),length=Buffer.byteLength(body);if((length!==3&&length!==6)||/[^\x00-\x7f]/u.test(body))throw new SyntaxError('Invalid hex color');
 const width=length/3,parts=[body.slice(0,width),body.slice(width,width*2),body.slice(width*2)];
 return parts.map(part=>{const m=/^\+?[0-9a-fA-F]+$/u.exec(part);if(m===null||m[0]!==part)throw new SyntaxError('Invalid hex color');return Number.parseInt(part.replace(/^\+/u,''),16);});
};
const reactionCounts=struct(shape([['burst','u64'],['normal','u64']]));
export const discordReactionField=struct(shape([['burst_colors',vector(discordHexColorField)],['count','u64'],['count_details',reactionCounts],['emoji',discordEmojiField],['me','bool'],['me_burst','bool']]));
const pollEmoji=struct(shape([['animated','bool'],['id',option(id)],['name','string?']],['id','name'],{animated:false}));
const pollMedia=struct(shape([['emoji',option(pollEmoji)],['text','string?']],['emoji','text']));
const pollAnswer=struct(shape([['answer_id',u8],['poll_media',pollMedia]]));
const pollAnswerCount=struct(shape([['id',u8],['count','u64'],['me_voted','bool']]));
const pollResults=struct(shape([['answer_counts',vector(pollAnswerCount)],['is_finalized','bool']]));
export const discordPollField=struct(shape([['answers',vector(pollAnswer)],['allow_multiselect','bool'],['expiry',option(timestamp)],['layout_type',u8],['question',pollMedia],['results',option(pollResults)]],['expiry','results']));
