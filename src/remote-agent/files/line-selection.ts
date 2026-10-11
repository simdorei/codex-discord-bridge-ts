import {requireDiscordText} from '../../discord/text.ts';
export interface UnredactedRemoteLineSelection{readonly selectedText:string;readonly startLine:bigint;readonly endLine:bigint;readonly totalLines:bigint;readonly truncated:boolean;}
/** Internal text selection only: not a read_file output or an authorization.
 * Caller must strictly decode owned file bytes, hash the original bytes, and
 * redact this selected text before creating any remotely visible response. */
export function selectRemoteTextLines(text:string,start:bigint,maxLines:number):UnredactedRemoteLineSelection{
 requireDiscordText(text);if(text.length>1048576||Buffer.byteLength(text)>1048576)throw new RangeError('Remote file text exceeds1MiB');
 if(typeof start!=='bigint'||start<0n||start>18446744073709551615n)throw new RangeError('Expected u64 start line');
 if(!Number.isInteger(maxLines)||maxLines<0||maxLines>65535)throw new RangeError('Expected u16 line count');
 const first=start<1n?1n:start,count=Math.max(1,Math.min(maxLines,500)),selected:string[]=[];let total=0n,cursor=0;
 const line=(end:number)=>{total++;if(total>=first&&selected.length<count)selected.push(text.slice(cursor,end));};
 for(let i=0;i<text.length;i++)if(text.charCodeAt(i)===10){line(i>cursor&&text.charCodeAt(i-1)===13?i-1:i);cursor=i+1;}
 if(cursor<text.length)line(text.length);
 const end=first-1n+BigInt(selected.length);return Object.freeze({selectedText:selected.join('\n'),startLine:first,endLine:end,totalLines:total,truncated:end<total});
}
