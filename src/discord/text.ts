export const DISCORD_MAX_LEN=1900;
const CHUNK_MARKER_BUDGET=32;
export const TRUNCATION_SUFFIX="\n\n[truncated for Discord]";
const start=/^\p{White_Space}+/u,end=/\p{White_Space}+$/u;
const trim=(s:string)=>s.replace(start,"").replace(end,"");
export function requireDiscordText(value:unknown):asserts value is string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed Discord text");}
function limitValue(limit:number,zero:boolean):void{if(!Number.isSafeInteger(limit)||limit<(zero?0:1))throw new RangeError("Discord message limit must be a valid positive integer");}
/** UTF-16 offset at a Unicode-scalar boundary, matching Rust char_byte_index slices. */
function scalarEnd(text:string,limit:number):number{let offset=0,count=0;for(const char of text){if(count++>=limit)break;offset+=char.length;}return offset;}
export function splitMessage(text:string,limit=DISCORD_MAX_LEN):string[]{
  requireDiscordText(text);limitValue(limit,false);let remaining=trim(text);if(remaining==="")return ["(no output)"];const chunks:string[]=[];
  while(true){const stop=scalarEnd(remaining,limit);if(stop===remaining.length)break;const newline=remaining.slice(0,stop).lastIndexOf("\n"),split=newline>0?newline:stop;
    chunks.push(trim(remaining.slice(0,split)));remaining=remaining.slice(split).replace(start,"");}
  if(remaining!=="")chunks.push(remaining);return chunks;
}
function mark(chunks:string[],enabled:boolean):string[]{return enabled&&chunks.length>1?chunks.map((chunk,index)=>`[${index+1}/${chunks.length}]\n${chunk}`):chunks;}
export function splitDeliveryChunks(text:string,markersEnabled:boolean):string[]{
  if(typeof markersEnabled!=="boolean")throw new TypeError("Expected chunk marker flag");return mark(splitMessage(text,DISCORD_MAX_LEN-(markersEnabled?CHUNK_MARKER_BUDGET:0)),markersEnabled);
}
/** Preserve every byte of a structured saved payload, including leading/trailing whitespace. */
export function splitExactDeliveryChunks(text:string,markersEnabled:boolean):string[]{
  requireDiscordText(text);if(typeof markersEnabled!=="boolean")throw new TypeError("Expected chunk marker flag");if(text==="")return ["(no output)"];
  const limit=DISCORD_MAX_LEN-(markersEnabled?CHUNK_MARKER_BUDGET:0),chunks:string[]=[];let offset=0;
  while(offset<text.length){const stop=offset+scalarEnd(text.slice(offset),limit);chunks.push(text.slice(offset,stop));offset=stop;}return mark(chunks,markersEnabled);
}
/** Source contract retains the full suffix even when limit is shorter than the suffix. */
export function fitSingleMessage(text:string,limit:number):string{
  requireDiscordText(text);limitValue(limit,true);text=trim(text);if(scalarEnd(text,limit)===text.length)return text;
  const available=Math.max(0,limit-TRUNCATION_SUFFIX.length);return text.slice(0,scalarEnd(text,available)).replace(end,"")+TRUNCATION_SUFFIX;
}
