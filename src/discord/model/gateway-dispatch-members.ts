import {parseSerdeField,type StructField,type StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {modelOption as option,modelUnsigned as unsigned,modelSnowflake as id,modelStruct as struct,modelVector as vector,modelShape as shape} from './fields.ts';
import {discordMemberField,discordThreadMemberField,discordPresenceIntermediaryField} from './channel.ts';
import {modelTimestamp as timestamp} from './timestamp.ts';
function intoPresence(value:Record<string,unknown>,fallback:bigint):Record<string,unknown>{const {nick:_,...result}=value;result.guild_id??=fallback;return result;}
const presenceMap:StructFieldDecoder=(raw,_depth,context)=>{if(raw.trim()[0]!=='{')throw new SyntaxError('Expected Presence map');return context.decode(discordPresenceIntermediaryField);};
const chunkFields=new Map<string,StructField>([['chunk_count',unsigned(32)],['chunk_index',unsigned(32)],['guild_id',id],['members',vector(discordMemberField)],['nonce','string'],['not_found',vector(id)],['presences',vector(presenceMap)]]);
/** Source handwritten visitor: nonce may be absent, but present null is NOT
 * accepted despite the public Option<String> member. All supplied duplicates reject. */
export const discordMemberChunkField:StructFieldDecoder=(_raw,_depth,context)=>{
 const values:Record<string,unknown>=Object.create(null);
 context.map((key,decode)=>{const field=chunkFields.get(key);if(field===undefined)return;if(Object.hasOwn(values,key))throw new SyntaxError('Duplicate member chunk field');values[key]=decode(field);});
 for(const key of ['chunk_count','chunk_index','guild_id','members'])if(!Object.hasOwn(values,key))throw new SyntaxError('Missing member chunk field: '+key);
 values.nonce??=null;values.not_found??=[];values.presences??=[];
 values.presences=(values.presences as Record<string,unknown>[]).map(p=>{const result=intoPresence(p,1n);result.guild_id=values.guild_id;return result;});
 return values;
};
const threadIntermediary=struct(shape([['flags','u64'],['id',option(id)],['join_timestamp',timestamp],['member',option(discordMemberField)],['presence',option(discordPresenceIntermediaryField)],['user_id',option(id)]],['id','member','presence','user_id']));
const i32:StructFieldDecoder=(_raw,_depth,context)=>{const n=context.decode('i64') as bigint;if(n<-(1n<<31n)||n>=(1n<<31n))throw new SyntaxError('Expected i32 member count');return n;};
const threadUpdateShape=shape([['added_members',vector(threadIntermediary)],['guild_id',id],['id',id],['member_count',i32],['removed_member_ids',vector(id)]],[],{added_members:[],removed_member_ids:[]});
export const discordThreadMembersUpdateField:StructFieldDecoder=(raw,_depth,context)=>{
 if(raw.trim()[0]!=='{')throw new SyntaxError('Expected ThreadMembersUpdate map');const result=context.struct(threadUpdateShape),guild=result.guild_id as bigint;
 for(const member of result.added_members as Record<string,unknown>[])if(member.presence!==null)member.presence=intoPresence(member.presence as Record<string,unknown>,guild);
 return result;
};
/** Bounded flatten profile for these two schemas only. Serde first buffers every
 * non-guild field (including otherwise ignored children), then decodes the member.
 * Validate those original fragments as generic values but retain original map
 * traversal for typed decoding, so duplicate member keys cannot collapse. These
 * member schemas have no f64 or raw-vs-buffered anonymizable-ID fields. No generic
 * serde Content/flatten implementation or error-text identity is claimed here. */
function guildFlatten(member:StructField):StructFieldDecoder{return (_raw,_depth,context)=>{
 let guild:bigint|undefined;
 context.map((key,decode)=>{if(key==='guild_id'){if(guild!==undefined)throw new SyntaxError('Duplicate flattened guild');guild=decode(id) as bigint;}else decode('value');});
 if(guild===undefined)throw new SyntaxError('Missing flattened guild');
 const result=context.decode(member) as Record<string,unknown>;result.guild_id=guild;return result;
};}
const fields=new Map<string,StructField>([['GUILD_MEMBER_ADD',guildFlatten(discordMemberField)],['THREAD_MEMBER_UPDATE',guildFlatten(discordThreadMemberField)],['GUILD_MEMBERS_CHUNK',discordMemberChunkField],['THREAD_MEMBERS_UPDATE',discordThreadMembersUpdateField]]);
export function discordMemberDispatchField(name:string):StructField|undefined{return fields.get(name);}
export function decodeDiscordMemberDispatch(name:string,text:string):Record<string,unknown>{const field=fields.get(name);if(field===undefined)throw new SyntaxError('Unsupported member dispatch model');return parseSerdeField(text,field) as Record<string,unknown>;}
