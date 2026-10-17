import {types} from 'node:util';
import {requireDiscordText} from '../../discord/text.ts';
import {rustTrim} from '../../app-server/value.ts';
import {parseSerdeValue} from '../../core/serde-json-parse.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
export const ARCHIVE_METADATA_INPUT_LIMIT=1048576;
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const field=(value:Record<string,unknown>,key:string):unknown=>Object.hasOwn(value,key)?value[key]:undefined;
const typedArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLengthGetter=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteLength')!.get!;
const byteOffsetGetter=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteOffset')!.get!;
const bufferGetter=Object.getOwnPropertyDescriptor(typedArrayPrototype,'buffer')!.get!;
function snapshot(input:Uint8Array,maxBytes:number):Buffer{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>ARCHIVE_METADATA_INPUT_LIMIT)throw new RangeError('Invalid archive metadata byte budget');
 if(types.isProxy(input)||!types.isUint8Array(input))throw new TypeError('Expected archive metadata bytes');
 const byteLength=Reflect.apply(byteLengthGetter,input,[]) as number,byteOffset=Reflect.apply(byteOffsetGetter,input,[]) as number,buffer=Reflect.apply(bufferGetter,input,[]) as ArrayBuffer;
 if(byteLength>maxBytes)throw new RangeError('Archive metadata exceeds byte budget');
 if(types.isSharedArrayBuffer(buffer))throw new TypeError('Shared metadata bytes cannot be captured coherently');
 const view=new Uint8Array(buffer,byteOffset,byteLength);return Buffer.from(view);
}
function decode(bytes:Uint8Array):string{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
export interface ArchiveJsonScrubPlan{readonly changed:readonly string[];readonly value:Readonly<Record<string,unknown>>;}
/** Pure bounded transformation only. Input must later be proven identical to a
 * verified backup under the platform write lock. This plan is not deletion or
 * write authority. No file is opened, replaced, truncated, or deleted here. */
export function planArchiveJsonScrub(input:Uint8Array,threadId:string,bridge:boolean,maxBytes:number):ArchiveJsonScrubPlan{
 requireDiscordText(threadId);if(typeof bridge!=='boolean')throw new TypeError('Expected metadata kind');const original=snapshot(input,maxBytes),bytes=original.length>=3&&original[0]===239&&original[1]===187&&original[2]===191?original.subarray(3):original;
 const value=parseSerdeValue(decode(bytes));if(!object(value))throw new TypeError('Expected archive metadata JSON object');const changed:string[]=[];
 const removeKey=(key:string)=>{const nested=field(value,key);if(!object(nested)||!Object.hasOwn(nested,threadId))return false;delete nested[threadId];if(Object.keys(nested).length===0)delete value[key];return true;};
 if(bridge){
  if(field(value,'selected_thread_id')===threadId){delete value.selected_thread_id;changed.push('selected_thread_id');}
  if(removeKey('recent_live_approval_requests'))changed.push('recent_live_approval_requests');
  const recent=field(value,'recent_ui_thread');if(object(recent)&&field(recent,'thread_id')===threadId){delete value.recent_ui_thread;changed.push('recent_ui_thread');}
 }else{
  if(removeKey('queued-follow-ups'))changed.push('queued-follow-ups');const pinned=field(value,'pinned-thread-ids');if(Array.isArray(pinned)){const kept=pinned.filter(v=>v!==threadId);if(kept.length!==pinned.length){value['pinned-thread-ids']=kept;changed.push('pinned-thread-ids');}}
 }
 return Object.freeze({changed:Object.freeze(changed),value:cloneOwnedSerdeValue(value) as Readonly<Record<string,unknown>>});
}
export interface ArchiveIndexScrubPlan{readonly removed:number;readonly replacement:string|null;}
/** Rust str::lines/trim behavior: LF/CRLF delimiters only, bare final CR retained
 * as content. Invalid JSON lines and non-string IDs survive; invalid UTF-8 fails.
 * Null replacement means preserve original bytes without a formatting rewrite. */
export function planArchiveIndexScrub(input:Uint8Array,threadId:string,maxBytes:number):ArchiveIndexScrubPlan{
 requireDiscordText(threadId);const original=decode(snapshot(input,maxBytes)),kept:string[]=[];let removed=0,start=0;
 const accept=(line:string)=>{let matches=false;try{const value=parseSerdeValue(rustTrim(line));matches=object(value)&&field(value,'id')===threadId;}catch{/* Invalid source line is retained, never treated as an exact target. */}if(matches)removed++;else kept.push(line);};
 for(let i=0;i<original.length;i++)if(original[i]==='\n'){let end=i;if(end>start&&original[end-1]==='\r')end--;accept(original.slice(start,end));start=i+1;}
 if(start<original.length)accept(original.slice(start));
 if(removed===0)return Object.freeze({removed:0,replacement:null});let replacement=kept.join('\n');if(replacement!==''&&(original.endsWith('\n')||original.endsWith('\r')))replacement+='\n';return Object.freeze({removed,replacement});
}
