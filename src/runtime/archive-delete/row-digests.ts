import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {requireDiscordText} from '../../discord/text.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
export type ArchiveRows='thread'|'edges'|'logs';
export interface ArchiveRowLimits{readonly maxRows:number;readonly maxBytes:number;}
const queries={
 thread:'SELECT * FROM threads WHERE id=?1',
 edges:'SELECT * FROM thread_spawn_edges WHERE child_thread_id=?1 OR parent_thread_id=?1',
 logs:'SELECT * FROM logs WHERE thread_id=?1',
} as const;
export class ArchiveEvidenceLimitError extends Error{constructor(reason:string){super('Archive row evidence: '+reason);this.name='ArchiveEvidenceLimitError';}}
const fail=(reason:string):never=>{throw new ArchiveEvidenceLimitError(reason);};
const le=(value:bigint,signed=false):Buffer=>{const b=Buffer.alloc(8);if(signed)b.writeBigInt64LE(value);else b.writeBigUInt64LE(value);return b;};
/** Bounded read-only evidence on a borrowed connection, matching 64-bit Rust row
 * digests. No deletion, transaction or backup authority. UTF-8 databases only:
 * other encodings are rejected before row conversion, not silently normalized.
 * Caller must execute in a native owner and retain its original write fence.
 * SQL CASE caps returned row bytes; not SQLite internal memory or CPU time. */
export function archiveRowDigestsIn(db:DatabaseSync,kind:ArchiveRows,id:string,limits:ArchiveRowLimits):readonly string[]{
 requireDiscordText(id);
 const maxRows=own(limits,'maxRows'),maxBytes=own(limits,'maxBytes');
 if(typeof maxRows!=='number'||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>4096||typeof maxBytes!=='number'||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4194304)throw new RangeError('Invalid archive evidence limits');
 if(kind!=='thread'&&kind!=='edges'&&kind!=='logs')throw new TypeError('Unknown archive evidence query');
 if(db.prepare('PRAGMA encoding').get()?.encoding!=='UTF-8')fail('unsupported database encoding');
 const sql=queries[kind],columns=db.prepare(sql).columns().map(c=>c.name);
 if(columns.length===0||columns.length>128||columns.some(c=>Buffer.byteLength(c)>4096||c.includes('\0')))fail('column budget exceeded');
 const names=Buffer.from(columns.join('\0'));if(names.length>maxBytes)fail('column name budget exceeded');
 const quoted=columns.map(c=>'"'+c.replaceAll('"','""')+'"');
 // Include scalar/type overhead and every variable cell before any value enters JS.
 const rowSize=quoted.map(c=>`CASE typeof(${c}) WHEN 'text' THEN 9+length(CAST(${c} AS BLOB)) WHEN 'blob' THEN 9+length(${c}) WHEN 'null' THEN 1 ELSE 9 END`).join('+');
 const allowed=`(${rowSize})<=${maxBytes}`;
 const projection=quoted.flatMap(c=>[`typeof(${c})`,`CASE WHEN ${allowed} THEN CASE WHEN typeof(${c})='text' THEN CAST(${c} AS BLOB) ELSE ${c} END END`]).join(',');
 const statement=db.prepare('SELECT '+projection+sql.slice('SELECT *'.length)+` LIMIT ${maxRows+1}`);statement.setReadBigInts(true);statement.setReturnArrays(true);
 const digests:string[]=[];let consumed=0;
 for(const native of statement.iterate(id)){
  if(digests.length>=maxRows)fail('complete row budget exceeded');
  const row=native as unknown;if(!Array.isArray(row)||row.length!==columns.length*2)throw new TypeError('Invalid native archive row');
  const hash=createHash('sha256');hash.update(names);consumed+=names.length;
  for(let i=0;i<columns.length;i++){
   const type=row[i*2],value=row[i*2+1];let encoded:Buffer;
   if(type==='null')encoded=Buffer.from([0]);
   else if(type==='integer'){if(typeof value!=='bigint')fail('row bytes exceeded or invalid integer');encoded=Buffer.concat([Buffer.from([1]),le(value,true)]);}
   else if(type==='real'){if(typeof value!=='number')fail('row bytes exceeded or invalid real');const bytes=Buffer.alloc(9);bytes[0]=2;bytes.writeDoubleLE(value,1);encoded=bytes;}
   else if(type==='text'||type==='blob'){if(!(value instanceof Uint8Array))fail('row bytes exceeded or invalid byte cell');const bytes=Buffer.from(value);encoded=Buffer.concat([Buffer.from([type==='text'?3:4]),le(BigInt(bytes.length)),bytes]);}
   else throw new TypeError('Invalid SQLite storage class');
   consumed+=encoded.length;if(consumed>maxBytes)fail('complete byte budget exceeded');hash.update(encoded);
  }
  digests.push(hash.digest('hex'));
 }
 return Object.freeze(digests.sort());
}
