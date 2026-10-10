import {parseSerdeField} from '../../core/serde-struct-json.ts';
import {modelUnsigned as unsigned,modelStruct as struct,modelShape as shape} from './fields.ts';
export interface DiscordGatewayBotInfo{readonly shards:bigint;readonly url:string;readonly session_start_limit:{readonly max_concurrency:bigint;readonly remaining:bigint;readonly reset_after:bigint;readonly total:bigint}}
const limits=struct(shape([['max_concurrency',unsigned(16)],['remaining',unsigned(32)],['reset_after','u64'],['total',unsigned(32)]]));
export const discordGatewayBotInfoField=struct(shape([['session_start_limit',limits],['shards',unsigned(32)],['url','string']]));
/** Complete source model, not permission to connect to its URL or allocate its
 * shard count. Zero values and full integer widths retain source acceptance. */
export function decodeDiscordGatewayBotInfo(text:string):DiscordGatewayBotInfo{const value=parseSerdeField(text,discordGatewayBotInfoField) as unknown as DiscordGatewayBotInfo;Object.freeze(value.session_start_limit);return Object.freeze(value);}
export function decodeDiscordGatewayBotInfoBytes(bytes:Uint8Array):DiscordGatewayBotInfo{return decodeDiscordGatewayBotInfo(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));}
const modelErrors=new WeakSet<object>();
/** Body read/JSON/model stage, kept distinct from pre-response HTTP failures. */
export class DiscordGatewayModelError extends Error{constructor(){super('Discord gateway discovery model could not be decoded');this.name='DiscordGatewayModelError';modelErrors.add(this);}}

export function isDiscordGatewayModelError(value:unknown):boolean{return value!==null&&(typeof value==='object'||typeof value==='function')&&modelErrors.has(value);}
