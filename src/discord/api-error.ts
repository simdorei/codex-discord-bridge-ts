import {parseSerdeValue} from "../core/serde-json-parse.ts";
import {parseSerdeStruct,type StructShape} from "../core/serde-struct-json.ts";
export type DiscordApiError=
 |{readonly kind:'General';readonly code:bigint;readonly message:string}
 |{readonly kind:'Ratelimited';readonly global:boolean;readonly message:string;readonly retryAfter:number}
 |{readonly kind:'Message';readonly embed:readonly ('fields'|'timestamp')[]|null};
const general:StructShape={fields:[['code','u64'],['message','string']]};
const ratelimited:StructShape={fields:[['global','bool'],['message','string'],['retry_after','f64']]};
/** Unit enum accepts a string or a single externally tagged null value. The second
 * typed parse catches duplicate recognized keys that JSON.parse would overwrite. */
function unit(raw:string):'fields'|'timestamp'{
 const value:unknown=parseSerdeValue(raw);if(value==='fields'||value==='timestamp')return value;
 if(value===null||typeof value!=='object'||Array.isArray(value))throw new SyntaxError('Invalid message embed field');
 const keys=Object.keys(value);if(keys.length!==1||(keys[0]!=='fields'&&keys[0]!=='timestamp'))throw new SyntaxError('Invalid message embed field');
 const name=keys[0],decoded=parseSerdeStruct(raw,{fields:[[name,'value']]});if(decoded[name]!==null)throw new SyntaxError('Expected unit embed field');return name;
}
function embed(raw:string):readonly ('fields'|'timestamp')[]|null{
 if(parseSerdeValue(raw)===null)return null;
 // Decode the Vec as the single field of a sequence struct, preserving every raw
 // unit value through a trusted field decoder. No numeric/string coercions.
 const text=raw.trim();if(text[0]!=='[')throw new SyntaxError('Expected embed vector');
 const lexical=JSON.parse(text) as unknown[];
 const shape:StructShape={fields:lexical.map((_v,i)=>[String(i),unit] as const)};
 const decoded=parseSerdeStruct(text,shape);return Object.freeze(lexical.map((_v,i)=>decoded[String(i)] as 'fields'|'timestamp'));
}
const message:StructShape={fields:[['embed',embed]],defaults:{embed:null}};
/** Pinned twilight-http 0.17.1 ApiError's untagged General -> Ratelimited -> Message
 * order. Content buffering validates the whole JSON before variant attempts. General
 * failures may fall through to Message; {} is a valid Message error, not malformed JSON.
 * This is error-model parsing only, not HTTP retries or a successful Message receipt. */
export function parseDiscordApiError(text:string):DiscordApiError{
 parseSerdeValue(text); // Untagged Serde Content validates even fields ignored by variants.
 try{const v=parseSerdeStruct(text,general);return Object.freeze({kind:'General',code:v.code as bigint,message:v.message as string});}catch(error){if(!(error instanceof SyntaxError))throw error;}
 try{const v=parseSerdeStruct(text,ratelimited);return Object.freeze({kind:'Ratelimited',global:v.global as boolean,message:v.message as string,retryAfter:v.retry_after as number});}catch(error){if(!(error instanceof SyntaxError))throw error;}
 const lexical:unknown=JSON.parse(text);if(Array.isArray(lexical)&&lexical.length!==1)throw new SyntaxError('Invalid Message error sequence');
 const v=parseSerdeStruct(text,message);return Object.freeze({kind:'Message',embed:v.embed as readonly ('fields'|'timestamp')[]|null});
}
