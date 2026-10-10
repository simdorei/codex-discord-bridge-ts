import {createHash} from 'node:crypto';
import {types} from 'node:util';
import type {DatabaseSync} from 'node:sqlite';
import {encodeMirrorCursorAnchor,decodeMirrorCursorAnchor,type MirrorCursorAnchor} from '../core/mirror-cursor-anchor.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {withStoreTransaction,commitStore,rollbackStore} from './owned-scope.ts';
import {receiptText,receiptTextColumns} from './delivery-receipt-key.ts';
import {decodeI64,decodeTimestamp} from './sqlite-values.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
import {snapshotExpectedReceiptBatch,requireConfirmedReceiptBatchIn,type ExpectedReceipt} from './confirmed-receipt-batch.ts';
const TABLE='cdr_ts_mirror_cursor_anchors_v1';
const DDL=`CREATE TABLE cdr_ts_mirror_cursor_anchors_v1 (
 thread_id TEXT PRIMARY KEY NOT NULL, anchor_json TEXT NOT NULL,
 turn_context TEXT NOT NULL, updated_at REAL NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 operation_id TEXT NOT NULL, receipt_set_hash TEXT NOT NULL,
 CHECK(length(CAST(anchor_json AS BLOB))<=131072),
 CHECK(length(CAST(turn_context AS BLOB))<=32768),
 CHECK(length(CAST(operation_id AS BLOB)) BETWEEN 1 AND 256),
 CHECK(length(receipt_set_hash)=64)
)`;
export interface BoundMirrorCursor{
 readonly thread:string;readonly anchor:MirrorCursorAnchor;readonly turn:string;
 readonly updatedAt:number;readonly revision:bigint;readonly operationId:string;readonly receiptSetHash:string;
}
export class MirrorCursorConflictError extends Error{constructor(){super('Mirror cursor binding changed or operation identity conflicts');this.name='MirrorCursorConflictError';}}
export class LegacyMirrorCursorUnboundError extends Error{constructor(){super('Legacy mirror cursor has no generation binding; explicit reconciliation is required');this.name='LegacyMirrorCursorUnboundError';}}
const own=(value:unknown,key:string):unknown=>{
 if(value===null||typeof value!=='object'||types.isProxy(value))throw new TypeError('Expected mirror cursor data');
 const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Expected own mirror cursor data');return d.value;
};
function text(v:unknown,max:number,nonempty=false):asserts v is string{
 if(typeof v!=='string'||v.length>max||/[\uD800-\uDFFF]/u.test(v)||Buffer.byteLength(v)>max||(nonempty&&v===''))throw new TypeError('Invalid bounded mirror cursor text');
}
function time(v:unknown):asserts v is number{if(typeof v!=='number'||!Number.isFinite(v)||v<0)throw new TypeError('Invalid mirror cursor timestamp');}
function anchor(input:MirrorCursorAnchor):{value:MirrorCursorAnchor;json:string}{
 const json=encodeMirrorCursorAnchor(input),value=decodeMirrorCursorAnchor(json);
 if(value.offset>=(1n<<63n))throw new RangeError('Mirror cursor exceeds legacy signed i64 range');return {value,json};
}
function receiptSet(input:readonly ExpectedReceipt[]):{receipts:readonly ExpectedReceipt[];hash:string}{
 const receipts=snapshotExpectedReceiptBatch(input),hash=createHash('sha256').update(serializeSerdeValue(receipts.map(r=>[r.key,r.contentHash]))).digest('hex');return {receipts,hash};
}
export function snapshotBoundMirrorCursor(input:BoundMirrorCursor):BoundMirrorCursor{
 const thread=own(input,'thread'),a=anchor(own(input,'anchor') as MirrorCursorAnchor),turn=own(input,'turn'),updatedAt=own(input,'updatedAt'),revision=own(input,'revision'),operationId=own(input,'operationId'),receiptSetHash=own(input,'receiptSetHash');
 text(thread,16384);text(turn,16384);text(operationId,128,true);time(updatedAt);
 if(typeof revision!=='bigint'||revision<1n||revision>=(1n<<63n)||typeof receiptSetHash!=='string'||receiptSetHash.length!==64||!/^[0-9a-f]{64}$/.test(receiptSetHash))throw new TypeError('Invalid mirror cursor revision/proof');
 return Object.freeze({thread,anchor:a.value,turn,updatedAt,revision,operationId,receiptSetHash});
}
/** Explicit opt-in TS extension only. Not wired into Rust-parity schema assembly,
 * never called by reads. Owns a short transaction; existing incompatible table is held. */
export function initializeMirrorCursorJournal(db:DatabaseSync):void{
 withStoreTransaction(db,'IMMEDIATE',()=>{
  const row=db.prepare("SELECT type,CASE WHEN length(CAST(sql AS BLOB))<=4096 THEN sql END AS sql FROM sqlite_schema WHERE name=?").get(TABLE);
  if(row===undefined)db.exec(DDL);else if(row.type!=='table'||row.sql!==DDL)throw new StoreIntegrityError('Incompatible mirror cursor anchor schema');
  return commitStore(undefined);
 });
}
function rows(db:DatabaseSync,sql:string,thread:string):Record<string,unknown>[]{
 const q=db.prepare(sql);q.setReadBigInts(true);return q.all(thread,thread);
}
function bounded(column:string,max:number):string{return `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))<=${max} THEN ${column} END AS ${column}`;}
function readIn(db:DatabaseSync,thread:string):BoundMirrorCursor|null{
 const records=rows(db,`SELECT anchor_json,turn_context,operation_id,receipt_set_hash,updated_at,revision,${receiptTextColumns('anchor_json','turn_context','operation_id','receipt_set_hash')} FROM (
  SELECT ${bounded('anchor_json',131072)},${bounded('turn_context',32768)},${bounded('operation_id',256)},${bounded('receipt_set_hash',128)},updated_at,revision FROM ${TABLE}
  WHERE thread_id=? AND CAST(thread_id AS BLOB)=CAST(? AS BLOB) LIMIT 2)`,thread);
 const legacy=rows(db,`SELECT rollout_path,turn_context,cursor,updated_at,${receiptTextColumns('rollout_path','turn_context')} FROM (
  SELECT ${bounded('rollout_path',65536)},${bounded('turn_context',32768)},cursor,updated_at FROM codex_session_mirror_offsets
  WHERE codex_thread_id=? AND CAST(codex_thread_id AS BLOB)=CAST(? AS BLOB) LIMIT 2)`,thread);
 if(records.length===0){if(legacy.length===0)return null;throw new LegacyMirrorCursorUnboundError();}
 if(records.length!==1||legacy.length!==1)throw new MirrorCursorConflictError();
 const row=records[0]!,old=legacy[0]!,a=decodeMirrorCursorAnchor(receiptText(row,'anchor_json')!);
 const result=snapshotBoundMirrorCursor({thread,anchor:a,turn:receiptText(row,'turn_context')!,operationId:receiptText(row,'operation_id')!,receiptSetHash:receiptText(row,'receipt_set_hash')!,updatedAt:decodeTimestamp(row.updated_at,'updated_at'),revision:decodeI64(row.revision,'revision')});
 if(receiptText(old,'rollout_path')!==a.path||decodeI64(old.cursor,'cursor')!==a.offset||receiptText(old,'turn_context')!==result.turn||decodeTimestamp(old.updated_at,'updated_at')!==result.updatedAt)throw new MirrorCursorConflictError();
 return result;
}
function same(a:BoundMirrorCursor,b:BoundMirrorCursor):boolean{
 return a.thread===b.thread&&encodeMirrorCursorAnchor(a.anchor)===encodeMirrorCursorAnchor(b.anchor)&&a.turn===b.turn&&a.updatedAt===b.updatedAt&&a.revision===b.revision&&a.operationId===b.operationId&&a.receiptSetHash===b.receiptSetHash;
}
export function readBoundMirrorCursor(db:DatabaseSync,thread:string):BoundMirrorCursor|null{
 text(thread,16384);return withStoreTransaction(db,'DEFERRED',()=>rollbackStore(readIn(db,thread)));
}
/** Fresh absent target only, never automatic legacy adoption. Caller must provide
 * an independently observed initialization boundary and explicit startup policy. */
export function initializeFreshMirrorCursor(db:DatabaseSync,thread:string,input:MirrorCursorAnchor,turn:string,updatedAt:number,operationId:string):BoundMirrorCursor{
 text(thread,16384);text(turn,16384);text(operationId,128,true);time(updatedAt);const a=anchor(input),proof=receiptSet([]);
 const desired=snapshotBoundMirrorCursor({thread,anchor:a.value,turn,updatedAt,revision:1n,operationId,receiptSetHash:proof.hash});
 return withStoreTransaction(db,'IMMEDIATE',()=>{
  const current=readIn(db,thread);if(current!==null){if(same(current,desired))return rollbackStore(current);throw new MirrorCursorConflictError();}
  if(BigInt(db.prepare('INSERT INTO codex_session_mirror_offsets(codex_thread_id,rollout_path,cursor,updated_at,turn_context) VALUES(?,?,?,?,?)').run(thread,a.value.path,a.value.offset,updatedAt,turn).changes)!==1n)throw new MirrorCursorConflictError();
  if(BigInt(db.prepare(`INSERT INTO ${TABLE} VALUES(?,?,?,?,?,?,?)`).run(thread,a.json,turn,updatedAt,1n,operationId,proof.hash).changes)!==1n)throw new MirrorCursorConflictError();
  const actual=readIn(db,thread);if(actual===null||!same(actual,desired))throw new MirrorCursorConflictError();return commitStore(actual);
 });
}
/** Trusted low-level DB commit only. The caller must derive ALL receipt keys from
 * the authentic complete batch and validate ownership/file continuity separately.
 * No network/FS is run inside this transaction; no cursor reset/path switch.
 * Retry with the SAME operation ID and exact packet reconciles a lost commit reply. */
export function advanceBoundMirrorCursor(db:DatabaseSync,input:BoundMirrorCursor,nextInput:MirrorCursorAnchor,turn:string,updatedAt:number,operationId:string,expectedReceipts:readonly ExpectedReceipt[]):BoundMirrorCursor{
 const expected=snapshotBoundMirrorCursor(input),next=anchor(nextInput),proof=receiptSet(expectedReceipts);text(turn,16384);text(operationId,128,true);time(updatedAt);
 if(expected.revision===(1n<<63n)-1n||operationId===expected.operationId||next.value.path!==expected.anchor.path||next.value.offset<expected.anchor.offset||next.value.stamp.size<expected.anchor.stamp.size||(['dev','ino','birthtimeNs'] as const).some(k=>next.value.stamp[k]!==expected.anchor.stamp[k]))throw new MirrorCursorConflictError();
 const desired=snapshotBoundMirrorCursor({thread:expected.thread,anchor:next.value,turn,updatedAt,revision:expected.revision+1n,operationId,receiptSetHash:proof.hash});
 return withStoreTransaction(db,'IMMEDIATE',()=>{
  const current=readIn(db,expected.thread);
  if(current!==null&&same(current,desired))return rollbackStore(current);
  if(current===null||!same(current,expected))throw new MirrorCursorConflictError();
  requireConfirmedReceiptBatchIn(db,proof.receipts);
  if(BigInt(db.prepare('UPDATE codex_session_mirror_offsets SET cursor=?,updated_at=?,turn_context=? WHERE codex_thread_id=?').run(next.value.offset,updatedAt,turn,expected.thread).changes)!==1n)throw new MirrorCursorConflictError();
  if(BigInt(db.prepare(`UPDATE ${TABLE} SET anchor_json=?,turn_context=?,updated_at=?,revision=?,operation_id=?,receipt_set_hash=? WHERE thread_id=? AND revision=?`).run(next.json,turn,updatedAt,desired.revision,operationId,proof.hash,expected.thread,expected.revision).changes)!==1n)throw new MirrorCursorConflictError();
  const actual=readIn(db,expected.thread);if(actual===null||!same(actual,desired))throw new MirrorCursorConflictError();return commitStore(actual);
 });
}
