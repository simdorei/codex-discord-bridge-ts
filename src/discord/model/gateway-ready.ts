import {parseSerdeField,type StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {modelOption as option,modelUnsigned as unsigned,modelSnowflake as id,modelImageHash as image,modelStruct as struct,modelVector as vector,modelShape as shape} from './fields.ts';
import {discordDiscriminatorField,discordUserFlagsField} from './user.ts';
const u8=unsigned(8),u32=unsigned(32);
const appFlags:StructFieldDecoder=(_raw,_depth,context)=>(context.decode('u64') as bigint)&((255n<<12n)|(1n<<23n));
const mustTrue:StructFieldDecoder=(_raw,_depth,context)=>{if(context.decode('bool')!==true)throw new SyntaxError('Expected unavailable guild true');return true;};
export const discordCurrentUserField=struct(shape([
 ['accent_color',option(u32)],['avatar',option(image)],['banner',option(image)],['bot','bool'],['discriminator',discordDiscriminatorField],['email','string?'],['flags',option(discordUserFlagsField)],['global_name','string?'],['id',id],['locale','string?'],['mfa_enabled','bool'],['username','string'],['premium_type',option(u8)],['public_flags',option(discordUserFlagsField)],['verified',option('bool')],
],['accent_color','avatar','banner','email','flags','global_name','locale','premium_type','public_flags','verified'],{bot:false}));
export const discordShardIdField:StructFieldDecoder=(_raw,_depth,context)=>{const values=context.array(u32) as bigint[];if(values.length!==2||values[0]!>=values[1]!)throw new SyntaxError('Invalid shard number/total');return values;};
export const discordUnavailableGuildField=struct(shape([['id',id],['unavailable',mustTrue]]));
export const discordPartialApplicationField=struct(shape([['flags',appFlags],['id',id]]));
export const discordReadyField=struct(shape([['application',discordPartialApplicationField],['guilds',vector(discordUnavailableGuildField)],['resume_gateway_url','string'],['session_id','string'],['shard',option(discordShardIdField)],['user',discordCurrentUserField],['v','u64']],['shard']));
export const discordHelloField=struct(shape([['heartbeat_interval','u64']]));
/** Models only: a syntactically valid resume URL is not network authorization. */
export function decodeDiscordReady(text:string):Record<string,unknown>{return parseSerdeField(text,discordReadyField) as Record<string,unknown>;}
