import type {StructFieldDecoder} from '../../core/serde-struct-json.ts';
/** Exact naive wall-time nanoseconds retained by Twilight's PrimitiveDateTime wrapper.
 * Input offsets participate in leap-second validation, then are discarded by source.
 * This representation is not an ISO serializer. */
export interface DiscordModelTimestamp{readonly unixNanoseconds:bigint}
const days=(year:number,month:number)=>[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31][month-1]!;
export function parseDiscordTimestamp(value:string):DiscordModelTimestamp{
 if(typeof value!=='string'||Buffer.byteLength(value)<25)throw new SyntaxError('Invalid Discord timestamp length');
 // Pinned time 0.3.55 consumes ANY single separator byte, not only T/space.
 const match=/^([0-9]{4})-([0-9]{2})-([0-9]{2})[\x00-\x7f]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?([zZ]|([+-])([0-9]{2}):([0-9]{2}))$/u.exec(value);
 if(match===null||match[0]!==value)throw new SyntaxError('Invalid Discord timestamp format');
 const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),hour=Number(match[4]),minute=Number(match[5]),originalSecond=Number(match[6]),offsetHours=Number(match[10]??0),offsetMinutes=Number(match[11]??0);
 if(month<1||month>12||day<1||day>days(year,month)||hour>23||minute>59||originalSecond>60||offsetHours>23||offsetMinutes>59)throw new SyntaxError('Discord timestamp component out of range');
 const leap=originalSecond===60,second=leap?59:originalSecond,nanosecond=leap?999999999:Number((match[7]??'').padEnd(9,'0').slice(0,9));
 const local=new Date(0);local.setUTCFullYear(year,month-1,day);local.setUTCHours(hour,minute,second,0);
 if(leap){const offset=(offsetHours*60+offsetMinutes)*(match[9]==='-'?-1:1),utc=new Date(local.getTime()-offset*60000),uy=utc.getUTCFullYear(),um=utc.getUTCMonth()+1;if(uy< -9999||uy>9999||utc.getUTCHours()!==23||utc.getUTCMinutes()!==59||utc.getUTCSeconds()!==59||utc.getUTCDate()!==days(uy,um))throw new SyntaxError('Invalid UTC month-end leap second');}
 return Object.freeze({unixNanoseconds:BigInt(local.getTime())*1000000n+BigInt(nanosecond)});
}
export const modelTimestamp:StructFieldDecoder=(_raw,_depth,context)=>{const value=context.value();if(typeof value!=='string')throw new SyntaxError('Expected timestamp string');return parseDiscordTimestamp(value);};
