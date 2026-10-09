import type {DatabaseSync} from 'node:sqlite';
import {selectJob} from './queue-read.ts';
import {captureStopOriginIn} from './stop-revision-read.ts';
import {ActiveTransactionError} from './owned-driver.ts';
import {PublicationConsentIntegrityError} from './schema-publication-consent.ts';
import {decodeI64, decodeTextField, textDecoderFor} from './sqlite-values.ts';
import {rustTrim} from '../app-server/value.ts';
import {requireDiscordText} from '../discord/text.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
const MAX_BYTES = 262144, MAX_ROWS = 128;
const invalid = (reason: string): never => {throw new PublicationConsentIntegrityError(reason);};
export class PublicationRowMissingError extends Error {readonly kind = 'QueryReturnedNoRows'; constructor() {super('Query returned no rows'); this.name = 'PublicationRowMissingError';}}
export interface PublicationSnapshot {readonly thread: string; readonly owner: bigint; readonly channel: bigint; readonly seal: unknown}
const queries = [
  ['queue','SELECT * FROM codex_turn_queue WHERE target_thread_id=? ORDER BY created_at,job_id LIMIT 129'],
  ['mapping','SELECT * FROM mirror_threads WHERE codex_thread_id=? LIMIT 2'],
  ['obligations','SELECT * FROM cdr_async_execution_obligations WHERE thread_id=? ORDER BY question_id LIMIT 129'],
  ['settlements','SELECT * FROM cdr_async_terminal_settlements WHERE question_id IN (SELECT question_id FROM cdr_async_execution_obligations WHERE thread_id=?) ORDER BY question_id LIMIT 129'],
  ['handoffs','SELECT * FROM cdr_async_execution_handoffs WHERE question_id IN (SELECT question_id FROM cdr_async_execution_obligations WHERE thread_id=?) ORDER BY question_id,revision LIMIT 129'],
  ['policy','SELECT * FROM cdr_async_recovery_policies WHERE thread_id=? LIMIT 2'],
] as const;
function quote(name: string): string {requireDiscordText(name); if (name.includes('\0')) return invalid('invalid evidence column'); return '"' + name.replaceAll('"','""') + '"';}
function realBits(value: number): string {const bits=Buffer.alloc(8);bits.writeDoubleBE(value);return bits.readBigUInt64BE().toString();}
function rows(db: DatabaseSync, sql: string, target: string, budget: {bytes:number}): unknown {
  const columns = db.prepare(sql).columns().map(column => column.name);
  const encoding = db.prepare('PRAGMA encoding').get()?.encoding, decoder = textDecoderFor(encoding);
  // Native Node eagerly materializes each returned row. Bound text/blob values
  // in SQL before that conversion; source logical UTF-8/JSON bounds still apply.
  const textRawBound = encoding === 'UTF-8' ? MAX_BYTES : MAX_BYTES * 2;
  const projection = columns.flatMap(name => {
    const col=quote(name),type=`typeof(${col})`,size=`length(CAST(${col} AS BLOB))`;
    return [`CASE WHEN ${type}='text' AND ${size}>${textRawBound} OR ${type}='blob' AND ${size}>${MAX_BYTES/2} THEN NULL ELSE ${col} END`,type,size,
      `CASE WHEN ${type}='text' AND ${size}<=${textRawBound} THEN CAST(${col} AS BLOB) END`];
  }).join(',');
  const statement=db.prepare('SELECT '+projection+sql.slice('SELECT *'.length));statement.setReadBigInts(true);statement.setReturnArrays(true);
  const result: unknown[][]=[];
  for (const native of statement.iterate(target)) {
    if (result.length>=MAX_ROWS) return invalid('local evidence page exceeds bound');
    const row=native as unknown;if(!Array.isArray(row)||row.length!==columns.length*4)throw new TypeError('Expected native evidence array');const cells:unknown[]=[];
    for(let index=0;index<columns.length;index++){
      const [value,type,size,raw]=row.slice(index*4,index*4+4);let cell:unknown;
      if(type==='null')cell=['null'];
      else if(type==='integer')cell=['integer',decodeI64(value,'evidence integer')];
      else if(type==='real'){if(typeof value!=='number')throw new TypeError('Expected native real');cell=['real_bits',realBits(value)];}
      else if(type==='text'){
        if(decodeI64(size,'evidence text size')>BigInt(textRawBound))return invalid('evidence cell exceeds bound');
        let text:string;try{text=decodeTextField(value,raw,columns[index]!,false,decoder)!;}catch{return invalid('non-UTF8 evidence');}
        if(Buffer.byteLength(text,'utf8')>MAX_BYTES)return invalid('evidence cell exceeds bound');cell=['text',text];
      }else if(type==='blob'){
        if(decodeI64(size,'evidence blob size')>BigInt(MAX_BYTES/2))return invalid('evidence blob exceeds bound');
        if(!(value instanceof Uint8Array))throw new TypeError('Expected native blob');cell=['blob_hex',Buffer.from(value).toString('hex')];
      }else throw new TypeError('Unknown SQLite storage class');
      budget.bytes+=Buffer.byteLength(serializeSerdeValue(cell),'utf8');if(budget.bytes>MAX_BYTES)return invalid('local evidence exceeds review bound');cells.push(cell);
    }
    result.push(cells);
  }
  return {columns,rows:result};
}
/** Borrowed active transaction only. This immutable local snapshot is evidence,
 * not proof of terminal state, publication exclusion or permission to dispatch. */
export function capturePublicationSnapshotIn(db: DatabaseSync, jobId: string): PublicationSnapshot {
  requireDiscordText(jobId);if(!db.isTransaction)throw new ActiveTransactionError();
  const length=db.prepare('SELECT length(CAST(prompt AS BLOB)) AS n FROM codex_turn_queue WHERE job_id=?');length.setReadBigInts(true);const row=length.get(jobId);if(row===undefined)throw new PublicationRowMissingError();
  if(decodeI64(row.n,'pending prompt bytes')>131072n)return invalid('pending input exceeds review bound');
  const job=selectJob(db,jobId),owner=job.ownerUserId;
  if(owner===null||owner<=0n)return invalid('pending has no exact original owner');
  if(job.state!=='Pending'||job.channelId<=0n||job.appServerGeneration<1n||rustTrim(job.targetThreadId)==='')return invalid('proposal does not name an owned Pending job');
  const mapping=db.prepare('SELECT count(*)=1 AND MAX(codex_thread_id=?1 AND discord_thread_id=?2) AS mapped FROM mirror_threads WHERE codex_thread_id=?1 OR discord_thread_id=?2');mapping.setReadBigInts(true);
  if(decodeI64(mapping.get(job.targetThreadId,job.channelId)?.mapped,'pending mapping')===0n)return invalid('pending mapping is missing or ambiguous');
  const stop=captureStopOriginIn(db,job.targetThreadId),budget={bytes:0},seal:Record<string,unknown>={};
  for(const [key,sql] of queries)seal[key]=rows(db,sql,job.targetThreadId,budget);
  seal.stop_origin=stop;if(Buffer.byteLength(serializeSerdeValue(seal),'utf8')>MAX_BYTES)return invalid('local evidence exceeds review bound');
  return Object.freeze({thread:job.targetThreadId,owner,channel:job.channelId,seal:cloneOwnedSerdeValue(seal)});
}
