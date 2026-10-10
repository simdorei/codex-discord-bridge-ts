import {parseSerdeField,type StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {rustIntegerToF32} from '../../core/rust-f32.ts';
import {modelSnowflake as id,modelStruct as struct,modelShape as shape,modelUnsigned as unsigned} from './fields.ts';
const codes=new Set([0n,1n,2n,3n,4n,6n,7n,8n,9n,10n,11n]);
const opcode:StructFieldDecoder=(_raw,_depth,context)=>{const value=context.decode(unsigned(8)) as bigint;if(!codes.has(value))throw new SyntaxError('Unknown Gateway opcode');return value;};
/** Pinned serde_json without float_roundtrip passes integer or f64 to Serde's
 * f32 visitor. Negative and overflowing-to-infinity f32 results are not filtered
 * by the source model. This decoder does not schedule retry policy. */
const f32:StructFieldDecoder=(_raw,_depth,context)=>{const value=context.value();if(typeof value==='bigint')return rustIntegerToF32(value);if(typeof value==='number')return Math.fround(value);throw new SyntaxError('Expected f32 number');};
const requestMembers=struct(shape([['guild_id',id],['nonce','string?']],['nonce']));
const metadata:StructFieldDecoder=(_raw,_depth,context)=>{let found=false,value:unknown;context.map((name,decode)=>{if(found||name!=='RequestGuildMembers')throw new SyntaxError('Unknown or duplicate rate-limit metadata variant');found=true;value=decode(requestMembers);});if(!found)throw new SyntaxError('Missing rate-limit metadata variant');return {RequestGuildMembers:value};};
export const discordRateLimitedField=struct(shape([['opcode',opcode],['retry_after',f32],['meta',metadata]]));
export function decodeDiscordRateLimited(text:string):Record<string,unknown>{return parseSerdeField(text,discordRateLimitedField) as Record<string,unknown>;}
