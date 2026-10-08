import {parseSerdeField,type StructField,type StructFieldDecoder,type StructShape} from '../../core/serde-struct-json.ts';
import {modelOption,modelStruct,modelUnsigned,modelSnowflake,modelImageHash,unsignedText} from "./fields.ts";
export * from "./fields.ts";
export const discordDiscriminatorField:StructFieldDecoder=(_raw,_depth,context)=>{const value=context.value();if(typeof value==='string')return unsignedText(value,16);if(typeof value==='bigint'&&value>=0n&&value<=65535n)return value;throw new SyntaxError('Expected string or integer discriminator');};
const USER_FLAGS=[0,1,2,3,6,7,8,9,10,14,16,17,18,19,22].reduce((mask,bit)=>mask|(1n<<BigInt(bit)),0n);
export const discordUserFlagsField:StructFieldDecoder=(_raw,_depth,context)=>(context.decode(modelUnsigned(64)) as bigint)&USER_FLAGS;
export const discordAvatarDecorationField=modelStruct({fields:[['asset',modelImageHash],['sku_id',modelSnowflake]]});
const primaryFields:readonly (readonly [string,StructField])[]=[['identity_guild_id',modelOption(modelSnowflake)],['identity_enabled',modelOption('bool')],['tag','string?'],['badge',modelOption(modelImageHash)]];
const primaryGuild=modelStruct({fields:primaryFields,mapDefaults:Object.fromEntries(primaryFields.map(([name])=>[name,null]))});
const optional:readonly (readonly [string,StructField])[]=[
 ['accent_color',modelOption(modelUnsigned(32))],['avatar',modelOption(modelImageHash)],['avatar_decoration',modelOption(modelImageHash)],['avatar_decoration_data',modelOption(discordAvatarDecorationField)],['banner',modelOption(modelImageHash)],
 ['email','string?'],['flags',modelOption(discordUserFlagsField)],['global_name','string?'],['locale','string?'],['mfa_enabled',modelOption('bool')],['premium_type',modelOption(modelUnsigned(8))],['primary_guild',modelOption(primaryGuild)],['public_flags',modelOption(discordUserFlagsField)],['system',modelOption('bool')],['verified',modelOption('bool')],
];
const option=new Map(optional);
/** Complete pinned twilight User field order; map Option defaults are not sequence defaults. */
const userFields:readonly (readonly [string,StructField])[]=[
 ...optional.slice(0,5),['bot','bool'],['discriminator',discordDiscriminatorField],['email',option.get('email')!],['flags',option.get('flags')!],['global_name',option.get('global_name')!],['id',modelSnowflake],['locale',option.get('locale')!],['mfa_enabled',option.get('mfa_enabled')!],['username','string'],['premium_type',option.get('premium_type')!],['primary_guild',option.get('primary_guild')!],['public_flags',option.get('public_flags')!],['system',option.get('system')!],['verified',option.get('verified')!],
];
export const discordUserShape:StructShape=Object.freeze({fields:Object.freeze(userFields.map(pair=>Object.freeze([...pair] as const))),defaults:Object.freeze({bot:false}),mapDefaults:Object.freeze(Object.fromEntries(optional.map(([name])=>[name,null])))});
export const discordUserField=modelStruct(discordUserShape);
/** Author/User validation leaf only. Message, timestamp, attachments, components and
 * other transitive response models are not certified by this function. */
export function decodeDiscordUser(text:string):Record<string,unknown>{return parseSerdeField(text,discordUserField) as Record<string,unknown>;}
