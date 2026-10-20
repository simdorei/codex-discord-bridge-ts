import {parseSerdeField,type StructField,type StructFieldDecoder,type BufferedSerdeValue} from '../../core/serde-struct-json.ts';
import {modelOption as option,modelUnsigned as unsigned,modelSnowflake as id,modelStruct as struct,modelVector as vector,modelShape as shape} from './fields.ts';
import {discordUserField} from './user.ts';
import {discordChannelField} from './channel.ts';
import {discordMessageField,discordIntegrationOwnersField} from './message.ts';
import {discordPartialMemberField,discordPermissionsField,discordInteractionTypeField} from './message-parts.ts';
import {discordEntitlementField} from './interaction-resolved.ts';
import {discordCommandDataField} from './interaction-command.ts';
import {discordModalDataField,discordMessageComponentDataField} from './interaction-modal.ts';
const partialGuild=struct(shape([['id',option(id)],['features',option(vector('string'))],['locale','string?']],['id','features','locale']));
const bufferedData:StructFieldDecoder=(raw,_depth,context)=>raw.trim()==='null'?null:context.captureBuffered();
const requiredNames=new Set(['application_id','id','token','type']);
/** Full pinned Interaction envelope. The source custom visitor has nullable slots:
 * null leaves their duplicate guards open. Data first becomes serde_value::Value,
 * so all its tokens validate before selecting a variant, repeated map keys collapse,
 * and numeric values must not pass through a second JSON parse. Ping discards data
 * only after this buffer validation. This is a valid-JSON decoding projection. */
export const discordInteractionField:StructFieldDecoder=(_raw,_depth,context)=>{
 const fields=new Map<string,StructField>([
  ['app_permissions',option(discordPermissionsField)],['application_id',id],['authorizing_integration_owners',option(discordIntegrationOwnersField)],['channel',option(discordChannelField)],['channel_id',option(id)],['context',option(unsigned(8))],['data',bufferedData],['entitlements',option(vector(discordEntitlementField))],['guild',option(partialGuild)],['guild_id',option(id)],['guild_locale','string?'],['id',id],['type',discordInteractionTypeField],['locale','string?'],['member',option(discordPartialMemberField)],['message',option(discordMessageField)],['token','string'],['user',option(discordUserField)],
 ]);
 const result:Record<string,unknown>=Object.create(null);
 context.map((key,decode)=>{const field=fields.get(key);if(field===undefined)return;if(Object.hasOwn(result,key)&&(requiredNames.has(key)||result[key]!==null))throw new SyntaxError('Duplicate Interaction field: '+key);result[key]=decode(field);});
 for(const name of [...requiredNames,'authorizing_integration_owners'])if(!Object.hasOwn(result,name)||result[name]===null)throw new SyntaxError('Missing Interaction field: '+name);
 const type=result.type as bigint,data=result.data as BufferedSerdeValue|null|undefined;
 if(type===1n)result.data=null;
 else{if(data===null||data===undefined)throw new SyntaxError('Missing Interaction data');result.data=data.decode(type===2n||type===4n?discordCommandDataField:type===3n?discordMessageComponentDataField:discordModalDataField);}
 result.entitlements??=[];
 for(const name of fields.keys())if(!Object.hasOwn(result,name))result[name]=null;
 return result;
};
export function decodeDiscordInteraction(text:string):Record<string,unknown>{return parseSerdeField(text,discordInteractionField) as Record<string,unknown>;}
/** Source author() checks member.user first, then direct user; null is not authority. */
export function discordInteractionAuthor(interaction:Readonly<Record<string,unknown>>):unknown{const member=interaction.member as Record<string,unknown>|null;return member?.user??interaction.user??null;}
