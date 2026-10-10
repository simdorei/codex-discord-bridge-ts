import {types} from 'node:util';
import {parseSerdeValue} from '../../core/serde-json-parse.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {rustTrim,serdeObject} from '../../app-server/value.ts';
export type MirrorWindowStop='WindowEnd'|'IncompleteRecord'|'RecordLimit'|'OversizedRecord'|'InvalidUtf8'|'InvalidJson';
export interface MirrorWindowEvent {readonly startOffset:bigint;readonly endOffset:bigint;readonly value:Readonly<Record<string,unknown>>;}
export interface MirrorRecordWindow {readonly events:readonly MirrorWindowEvent[];readonly nextOffset:bigint;readonly scannedRecords:number;readonly stop:MirrorWindowStop;}
const typedArray=Object.getPrototypeOf(Uint8Array.prototype) as object;
const getLength=Object.getOwnPropertyDescriptor(typedArray,'byteLength')!.get!;
const getBuffer=Object.getOwnPropertyDescriptor(typedArray,'buffer')!.get!;
const getResizable=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'resizable')!.get!;
const U64_MAX=(1n<<64n)-1n;
/** Pure bounded decode of one already-owned file window. Does not authorize cursor
 * persistence or establish file generation. Caller must verify generation, deliver
 * or durably hand off every event, and only then persist a complete-record offset.
 * Unlike legacy Rust read_line, an unterminated JSON value is never consumed. */
export function decodeMirrorRecordWindow(input:Uint8Array,startOffset:bigint,maxWindowBytes:number,maxRecordBytes:number,maxRecords:number):MirrorRecordWindow{
 for(const [value,maximum] of [[maxWindowBytes,1048576],[maxRecordBytes,262144],[maxRecords,1024]] as const)if(!Number.isSafeInteger(value)||value<1||value>maximum)throw new RangeError('Expected bounded mirror decode limit');
 if(maxRecordBytes>maxWindowBytes)throw new RangeError('Record budget exceeds window budget');
 if(typeof startOffset!=='bigint'||startOffset<0n||startOffset>U64_MAX)throw new RangeError('Expected u64 mirror offset');
 if(!types.isUint8Array(input))throw new TypeError('Expected byte window');
 const length=getLength.call(input) as number,buffer=getBuffer.call(input) as ArrayBuffer;
 if(types.isSharedArrayBuffer(buffer)||getResizable.call(buffer))throw new TypeError('Expected fixed unshared byte window');
 if(length>maxWindowBytes||startOffset+BigInt(length)>U64_MAX)throw new RangeError('Mirror window exceeds bounds');
 const bytes=new Uint8Array(length);bytes.set(input);
 const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
 const events:MirrorWindowEvent[]=[];let cursor=0,records=0;
 const finish=(stop:MirrorWindowStop):MirrorRecordWindow=>Object.freeze({events:Object.freeze(events),nextOffset:startOffset+BigInt(cursor),scannedRecords:records,stop});
 while(cursor<length){
  if(records===maxRecords)return finish('RecordLimit');
  let end=cursor;while(end<length&&end-cursor<=maxRecordBytes&&bytes[end]!==10)end++;
  if(end-cursor>maxRecordBytes)return finish('OversizedRecord');
  if(end===length)return finish(end-cursor>=maxRecordBytes?'OversizedRecord':'IncompleteRecord');
  // The wire record budget includes LF (and CR for CRLF).
  if(end-cursor+1>maxRecordBytes)return finish('OversizedRecord');
  let line:string;try{line=rustTrim(decoder.decode(bytes.subarray(cursor,end)));}catch{return finish('InvalidUtf8');}
  let value:unknown;if(line!==''){try{value=parseSerdeValue(line);}catch{return finish('InvalidJson');}}
  const next=end+1;
  if(serdeObject(value))events.push(Object.freeze({startOffset:startOffset+BigInt(cursor),endOffset:startOffset+BigInt(next),value:cloneOwnedSerdeValue(value) as Readonly<Record<string,unknown>>}));
  cursor=next;records++;
 }
 return finish('WindowEnd');
}
