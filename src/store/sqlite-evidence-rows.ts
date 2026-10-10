import type {DatabaseSync, SQLInputValue} from 'node:sqlite';
import {decodeI64,decodeTextField,textDecoderFor} from './sqlite-values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
export type EvidenceFailure = 'column'|'page'|'cell'|'encoding'|'blob'|'budget';
export interface EvidenceProfile {readonly maxBytes:number;readonly maxRows:number;readonly reject:(failure:EvidenceFailure)=>never}
/** Typed cell evidence shared by source-backed publication/abandonment snapshots.
 * It bounds returned text/blob conversion, not SQLite's internal memory use. */
function quote(name: string, invalid: EvidenceProfile['reject']): string {requireDiscordText(name); if (name.includes('\0')) return invalid('column'); return '"' + name.replaceAll('"','""') + '"';}
function realBits(value: number): string {const bits=Buffer.alloc(8);bits.writeDoubleBE(value);return bits.readBigUInt64BE().toString();}
export function captureSqliteEvidenceRows(db: DatabaseSync, sql: string, parameters: readonly SQLInputValue[], budget: {bytes:number}, profile: EvidenceProfile): unknown {
  const MAX_BYTES=profile.maxBytes, MAX_ROWS=profile.maxRows, invalid=profile.reject;
  if(!Number.isSafeInteger(MAX_BYTES)||MAX_BYTES<1||!Number.isSafeInteger(MAX_ROWS)||MAX_ROWS<1||!sql.startsWith('SELECT *'))throw new TypeError('Expected fixed bounded evidence SELECT');
  const columns = db.prepare(sql).columns().map(column => column.name);
  const encoding = db.prepare('PRAGMA encoding').get()?.encoding, decoder = textDecoderFor(encoding);
  // Native Node eagerly materializes each returned row. Bound text/blob values
  // in SQL before that conversion; source logical UTF-8/JSON bounds still apply.
  const textRawBound = encoding === 'UTF-8' ? MAX_BYTES : MAX_BYTES * 2;
  const projection = columns.flatMap(name => {
    const col=quote(name,invalid),type=`typeof(${col})`,size=`length(CAST(${col} AS BLOB))`;
    return [`CASE WHEN ${type}='text' AND ${size}>${textRawBound} OR ${type}='blob' AND ${size}>${MAX_BYTES/2} THEN NULL ELSE ${col} END`,type,size,
      `CASE WHEN ${type}='text' AND ${size}<=${textRawBound} THEN CAST(${col} AS BLOB) END`];
  }).join(',');
  const statement=db.prepare('SELECT '+projection+sql.slice('SELECT *'.length));statement.setReadBigInts(true);statement.setReturnArrays(true);
  const result: unknown[][]=[];
  for (const native of statement.iterate(...parameters)) {
    if (result.length>=MAX_ROWS) return invalid('page');
    const row=native as unknown;if(!Array.isArray(row)||row.length!==columns.length*4)throw new TypeError('Expected native evidence array');const cells:unknown[]=[];
    for(let index=0;index<columns.length;index++){
      const [value,type,size,raw]=row.slice(index*4,index*4+4);let cell:unknown;
      if(type==='null')cell=['null'];
      else if(type==='integer')cell=['integer',decodeI64(value,'evidence integer')];
      else if(type==='real'){if(typeof value!=='number')throw new TypeError('Expected native real');cell=['real_bits',realBits(value)];}
      else if(type==='text'){
        if(decodeI64(size,'evidence text size')>BigInt(textRawBound))return invalid('cell');
        let text:string;try{text=decodeTextField(value,raw,columns[index]!,false,decoder)!;}catch{return invalid('encoding');}
        if(Buffer.byteLength(text,'utf8')>MAX_BYTES)return invalid('cell');cell=['text',text];
      }else if(type==='blob'){
        if(decodeI64(size,'evidence blob size')>BigInt(MAX_BYTES/2))return invalid('blob');
        if(!(value instanceof Uint8Array))throw new TypeError('Expected native blob');cell=['blob_hex',Buffer.from(value).toString('hex')];
      }else throw new TypeError('Unknown SQLite storage class');
      budget.bytes+=Buffer.byteLength(serializeSerdeValue(cell),'utf8');if(budget.bytes>MAX_BYTES)return invalid('budget');cells.push(cell);
    }
    result.push(cells);
  }
  return {columns,rows:result};
}
