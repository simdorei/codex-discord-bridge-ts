import {types} from 'node:util';
import {resolve,isAbsolute} from 'node:path';
import {parseSerdeValue} from './serde-json-parse.ts';
import {serializeSerdeValue} from './serde-json.ts';
export interface MirrorFileStamp {readonly dev:bigint;readonly ino:bigint;readonly birthtimeNs:bigint;readonly mtimeNs:bigint;readonly ctimeNs:bigint;readonly size:bigint;}
export interface MirrorCursorAnchor {readonly version:1|2|3;readonly historyHash?:string;readonly path:string;readonly offset:bigint;readonly stamp:MirrorFileStamp;readonly prefixHash:string;readonly tailHash:string;}
const keys=['dev','ino','birthtimeNs','mtimeNs','ctimeNs','size'] as const;
const u64=1n<<64n,i64=1n<<63n;
export const MIRROR_ANCHOR_MAX_BYTES=65536;
function own(input:unknown,key:string):unknown{
 if(input===null||typeof input!=='object'||types.isProxy(input))throw new TypeError('Expected mirror anchor data');
 const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Expected own mirror anchor field');return d.value;
}
/** Shared bounded data validation for native observations and persisted decoding.
 * Well-formed data is not proof of provenance, delivery or unchanged history. */
export function snapshotMirrorCursorAnchor(input:MirrorCursorAnchor):MirrorCursorAnchor{
 const version=own(input,'version'),path=own(input,'path'),offset=own(input,'offset'),raw=own(input,'stamp'),prefixHash=own(input,'prefixHash'),tailHash=own(input,'tailHash');
 if((version!==1&&version!==2&&version!==3)||typeof path!=='string'||path.length>32768||/[\uD800-\uDFFF]/u.test(path)||path.includes('\0')||Buffer.byteLength(path)>32768||!isAbsolute(path)||(version===1?resolve(path)!==path:version===2?resolve(path)===path:false)||typeof offset!=='bigint'||offset<0n||offset>=u64)throw new TypeError('Invalid persisted mirror anchor');
 const fields=Object.create(null) as Record<typeof keys[number],bigint>;
 for(const k of keys){const value=own(raw,k);if(typeof value!=='bigint')throw new TypeError('Invalid mirror file stamp');fields[k]=value;}
 for(const k of ['dev','ino','birthtimeNs','size'] as const)if(fields[k]<0n||fields[k]>=u64)throw new TypeError('Mirror stamp outside u64');
 for(const k of ['mtimeNs','ctimeNs'] as const)if(fields[k]<-i64||fields[k]>=i64)throw new TypeError('Mirror timestamp outside i64');
 if(fields.ino===0n||fields.birthtimeNs===0n||fields.size<offset)throw new TypeError('Unusable mirror file identity');
 for(const value of [prefixHash,tailHash])if(typeof value!=='string'||value.length!==64||!/^[0-9a-f]{64}$/.test(value))throw new TypeError('Invalid mirror anchor hash');
 const historyHash=version===3?own(input,'historyHash'):undefined;if(version===3&&(typeof historyHash!=='string'||!/^[0-9a-f]{64}$/.test(historyHash)))throw new TypeError('Invalid full mirror history hash');
 return Object.freeze({...(version===3?{historyHash:historyHash as string}:{}),version,path,offset,stamp:Object.freeze({...fields}),prefixHash:prefixHash as string,tailHash:tailHash as string});
}
/** Canonical versioned tuple; normalized v1 bytes remain unchanged. All integers use the existing lossless serde codec. */
export function encodeMirrorCursorAnchor(input:MirrorCursorAnchor):string{
 const a=snapshotMirrorCursorAnchor(input),s=a.stamp;
 const result=serializeSerdeValue([BigInt(a.version),a.path,a.offset,s.dev,s.ino,s.birthtimeNs,s.mtimeNs,s.ctimeNs,s.size,a.prefixHash,a.tailHash,...(a.version===3?[a.historyHash]:[])]);
 if(Buffer.byteLength(result)>MIRROR_ANCHOR_MAX_BYTES)throw new RangeError('Encoded mirror anchor budget exceeded');
 return result;
}
export function decodeMirrorCursorAnchor(text:string):MirrorCursorAnchor{
 if(typeof text!=='string'||text.length>MIRROR_ANCHOR_MAX_BYTES||Buffer.byteLength(text)>MIRROR_ANCHOR_MAX_BYTES)throw new RangeError('Encoded mirror anchor budget exceeded');
 const a=parseSerdeValue<unknown>(text);
 if(!Array.isArray(a)||(a[0]===3n?a.length!==12:a.length!==11)||(a[0]!==1n&&a[0]!==2n&&a[0]!==3n))throw new TypeError('Invalid mirror anchor tuple');
 const value=snapshotMirrorCursorAnchor({...(a[0]===3n?{historyHash:a[11]}:{}),version:a[0]===1n?1:a[0]===2n?2:3,path:a[1],offset:a[2],stamp:{dev:a[3],ino:a[4],birthtimeNs:a[5],mtimeNs:a[6],ctimeNs:a[7],size:a[8]},prefixHash:a[9],tailHash:a[10]});
 if(encodeMirrorCursorAnchor(value)!==text)throw new TypeError('Noncanonical mirror anchor encoding');
 return value;
}

/** v1 keeps the historical normalized spelling contract. v2 preserves an
 * absolute native spelling that would otherwise select a different path. */
export function mirrorCursorAnchorVersionForPath(path:string):1|2{return resolve(path)===path?1:2;}
