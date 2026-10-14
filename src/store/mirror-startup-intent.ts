import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {isAbsolute} from 'node:path';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {encodeMirrorCursorAnchor,decodeMirrorCursorAnchor} from '../core/mirror-cursor-anchor.ts';
import {snapshotMirrorStartupCutoffData,snapshotMirrorStartupContextResult,type MirrorStartupCutoffData,type MirrorStartupContextResult} from '../runtime/session-mirror/startup-context-limits.ts';
import {withStoreTransaction,commitStore,rollbackStore} from './owned-scope.ts';
import {receiptText,receiptTextColumns} from './delivery-receipt-key.ts';
import {decodeTimestamp} from './sqlite-values.ts';
import {requireMirrorCursorJournalIn,readBoundMirrorCursorInTransaction,snapshotBoundMirrorCursor,type BoundMirrorCursor} from './mirror-cursor-journal.ts';
import {MIRROR_STARTUP_INTENT_TABLE as TABLE,requireMirrorStartupIntentJournalIn,MirrorStartupIntentConflictError} from './mirror-startup-intent-schema.ts';
import {requireExactMirrorChannelIn} from './mirror-cursor-mapping.ts';
export {initializeMirrorStartupIntentJournal,MirrorStartupIntentConflictError,MirrorStartupIntentSchemaError} from './mirror-startup-intent-schema.ts';
const MAX_CUTOFF_BYTES=262144;
/** Immutable descriptive pending state only. Reading it grants no native cutoff,
 * context reconstruction, cursor initialization, delivery or retirement authority. */
export interface PendingMirrorStartupIntent {readonly thread:string;readonly cutoff:MirrorStartupCutoffData;readonly operationId:string;readonly createdAt:number;}
export interface PreparedMirrorStartupIntent {readonly thread:string;readonly operationId:string;}
const plans=new WeakMap<object,{readonly desired:PendingMirrorStartupIntent;readonly json:string}>();
function text(value:unknown,max:number):asserts value is string {
 if(typeof value!=='string'||value===''||value.length>max)throw new TypeError('Invalid mirror startup intent text');requireDiscordText(value);if(Buffer.byteLength(value)>max)throw new TypeError('Invalid mirror startup intent text');
}
function cutoff(input:unknown):MirrorStartupCutoffData {
 const value=snapshotMirrorStartupCutoffData(input);if(!isAbsolute(value.path))throw new TypeError('Expected absolute mirror startup path');return value;
}
function encode(input:MirrorStartupCutoffData):string {
 const c=cutoff(input),s=c.stamp;
 const value=serializeSerdeValue([1n,c.path,c.offset,s.dev,s.ino,s.birthtimeNs,s.mtimeNs,s.ctimeNs,s.size,c.anchor===null?null:encodeMirrorCursorAnchor(c.anchor)]);
 if(Buffer.byteLength(value)>MAX_CUTOFF_BYTES)throw new RangeError('Mirror startup cutoff encoding budget exceeded');return value;
}
function decode(value:string):MirrorStartupCutoffData {
 if(typeof value!=='string'||value.length>MAX_CUTOFF_BYTES||Buffer.byteLength(value)>MAX_CUTOFF_BYTES)throw new RangeError('Mirror startup cutoff encoding budget exceeded');
 const a=parseSerdeValue<unknown>(value);if(!Array.isArray(a)||a.length!==10||a[0]!==1n||(a[9]!==null&&typeof a[9]!=='string'))throw new TypeError('Invalid mirror startup cutoff encoding');
 const result=cutoff({path:a[1],offset:a[2],stamp:{dev:a[3],ino:a[4],birthtimeNs:a[5],mtimeNs:a[6],ctimeNs:a[7],size:a[8]},anchor:a[9]===null?null:decodeMirrorCursorAnchor(a[9])});
 if(encode(result)!==value)throw new TypeError('Noncanonical mirror startup cutoff encoding');return result;
}
export function snapshotPendingMirrorStartupIntent(input:PendingMirrorStartupIntent):PendingMirrorStartupIntent {
 const thread=own(input,'thread'),operationId=own(input,'operationId'),createdAt=own(input,'createdAt'),captured=cutoff(own(input,'cutoff'));
 text(thread,16384);text(operationId,128);if(typeof createdAt!=='number'||!Number.isFinite(createdAt)||createdAt<0)throw new TypeError('Invalid mirror startup timestamp in seconds');
 return Object.freeze({thread,operationId,createdAt,cutoff:captured});
}
/** Trusted storage preparation, not native evidence authentication. Deep copies
 * before transaction acquisition; only the opaque factory identity can apply.
 * Native callers must extract data from their authentic MirrorStartupCutoff. */
export function prepareMirrorStartupIntent(thread:string,input:MirrorStartupCutoffData,createdAt:number,operationId:string):PreparedMirrorStartupIntent {
 const desired=snapshotPendingMirrorStartupIntent({thread,cutoff:input,createdAt,operationId}),json=encode(desired.cutoff),plan=Object.freeze({thread:desired.thread,operationId:desired.operationId});
 plans.set(plan,{desired,json});return plan;
}
function schema(db:DatabaseSync):void {requireMirrorStartupIntentJournalIn(db);requireMirrorCursorJournalIn(db);}
function absentCursor(db:DatabaseSync,thread:string):void {
 for(const [table,key] of [['codex_session_mirror_offsets','codex_thread_id'],['cdr_ts_mirror_cursor_anchors_v1','thread_id']] as const)
  if(db.prepare(`SELECT 1 FROM ${table} WHERE ${key}=? LIMIT 1`).get(thread)!==undefined)throw new MirrorStartupIntentConflictError();
}
function bounded(column:string,max:number):string {return `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))<=${max} THEN ${column} END AS ${column}`;}
function readPacketIn(db:DatabaseSync,thread:string):PendingMirrorStartupIntent|null {
 const q=db.prepare(`SELECT cutoff_json,operation_id,created_at,${receiptTextColumns('cutoff_json','operation_id')} FROM (SELECT ${bounded('cutoff_json',MAX_CUTOFF_BYTES*2)},${bounded('operation_id',256)},CASE WHEN typeof(created_at) IN ('integer','real') THEN created_at END AS created_at FROM ${TABLE} WHERE thread_id=? AND CAST(thread_id AS BLOB)=CAST(? AS BLOB) LIMIT 2)`);q.setReadBigInts(true);const rows=q.all(thread,thread);
 if(rows.length===0)return null;if(rows.length!==1)throw new MirrorStartupIntentConflictError();const row=rows[0]!;
 const result=snapshotPendingMirrorStartupIntent({thread,cutoff:decode(receiptText(row,'cutoff_json')!),operationId:receiptText(row,'operation_id')!,createdAt:decodeTimestamp(row.created_at,'created_at')});
 return result;
}
function readIn(db:DatabaseSync,thread:string):PendingMirrorStartupIntent|null {
 const result=readPacketIn(db,thread);if(result!==null)absentCursor(db,thread);return result;
}
export function readPendingMirrorStartupIntent(db:DatabaseSync,thread:string):PendingMirrorStartupIntent|null {
 text(thread,16384);return withStoreTransaction(db,'DEFERRED',()=>{schema(db);return rollbackStore(readIn(db,thread));});
}
export type MirrorStartupTargetState={readonly kind:'Pending';readonly pending:PendingMirrorStartupIntent}|{readonly kind:'Bound';readonly cursor:BoundMirrorCursor}|{readonly kind:'Absent'};
/** One read-only target snapshot. Pending must be checked first: bound reads
 * deliberately reject a pending intent, while pending reads reject either
 * cursor row. Schema and exact channel mapping are required, never repaired.
 * Mapping is a point-in-time guard, not an application target/channel lock. */
export function readMirrorStartupTarget(db:DatabaseSync,thread:string,channel:bigint):MirrorStartupTargetState {
 text(thread,16384);return withStoreTransaction<MirrorStartupTargetState>(db,'DEFERRED',()=>{
  schema(db);requireExactMirrorChannelIn(db,thread,channel);
  const pending=readIn(db,thread);if(pending!==null)return rollbackStore(Object.freeze({kind:'Pending',pending}));
  const cursor=readBoundMirrorCursorInTransaction(db,thread);
  return rollbackStore(cursor===null?Object.freeze({kind:'Absent'}):Object.freeze({kind:'Bound',cursor}));
 });
}
function same(a:PendingMirrorStartupIntent,b:PendingMirrorStartupIntent):boolean {return a.thread===b.thread&&a.operationId===b.operationId&&a.createdAt===b.createdAt&&encode(a.cutoff)===encode(b.cutoff);}
/** Read-only exact-packet check. This descriptive input grants no native file or
 * write authority; comparison includes original time, operation and held cutoff. */
export function verifyPendingMirrorStartupIntent(db:DatabaseSync,input:PendingMirrorStartupIntent):void {
 const expected=snapshotPendingMirrorStartupIntent(input);
 withStoreTransaction(db,'DEFERRED',()=>{schema(db);const actual=readIn(db,expected.thread);if(actual===null||!same(actual,expected))throw new MirrorStartupIntentConflictError();return rollbackStore(undefined);});
}
/** Owns one short transaction. No replace/update/delete, automatic adoption or
 * EOF resampling. Even exact retry checks cursor absence. A crash/lost reply is
 * reconciled by read or the SAME prepared packet, never a later native EOF. */
export function retainPreparedMirrorStartupIntent(db:DatabaseSync,plan:PreparedMirrorStartupIntent):PendingMirrorStartupIntent {
 const owned=plan!==null&&typeof plan==='object'?plans.get(plan):undefined;if(owned===undefined)throw new TypeError('Expected factory-created mirror startup intent plan');
 const {desired,json}=owned;
 return withStoreTransaction(db,'IMMEDIATE',()=>{
  schema(db);absentCursor(db,desired.thread);const current=readIn(db,desired.thread);
  if(current!==null){if(!same(current,desired))throw new MirrorStartupIntentConflictError();return rollbackStore(current);}
  if(db.prepare(`SELECT 1 FROM ${TABLE} WHERE operation_id=? LIMIT 1`).get(desired.operationId)!==undefined)throw new MirrorStartupIntentConflictError();
  if(BigInt(db.prepare(`INSERT INTO ${TABLE}(thread_id,cutoff_json,operation_id,created_at) VALUES(?,?,?,?)`).run(desired.thread,json,desired.operationId,desired.createdAt).changes)!==1n)throw new MirrorStartupIntentConflictError();
  const actual=readIn(db,desired.thread);if(actual===null||!same(actual,desired))throw new MirrorStartupIntentConflictError();return commitStore(actual);
 });
}

/** Trusted storage preparation only, not file or recovery authentication. The
 * runtime must obtain these inputs from its privately owned recovery evidence.
 * No structural packet passed directly to apply can acquire write authority. */
export interface PreparedMirrorStartupCompletion {readonly thread:string;readonly operationId:string;}
export interface MirrorStartupCompletionResult {readonly kind:'Completed'|'Reconciled';readonly cursor:BoundMirrorCursor;}
const completionPlans=new WeakMap<object,{readonly pending:PendingMirrorStartupIntent;readonly cutoffJson:string;readonly anchorJson:string;readonly desired:BoundMirrorCursor}>();
export function prepareMirrorStartupIntentCompletion(input:PendingMirrorStartupIntent,context:MirrorStartupContextResult):PreparedMirrorStartupCompletion {
 const pending=snapshotPendingMirrorStartupIntent(input),captured=snapshotMirrorStartupContextResult(pending.cutoff,{maxBytes:67108864,maxRecords:1048576,maxRecordBytes:262144,maxWindowBytes:1048576,maxTurnBytes:16384,timeoutMs:10000},context);
 const desired=snapshotBoundMirrorCursor({thread:pending.thread,anchor:captured.anchor,turn:captured.currentTurn??'',updatedAt:pending.createdAt,revision:1n,operationId:pending.operationId,receiptSetHash:createHash('sha256').update(serializeSerdeValue([])).digest('hex')});
 const plan=Object.freeze({thread:pending.thread,operationId:pending.operationId});completionPlans.set(plan,{pending,cutoffJson:encode(pending.cutoff),anchorJson:encodeMirrorCursorAnchor(desired.anchor),desired});return plan;
}
function completion(plan:PreparedMirrorStartupCompletion){
 const owned=plan!==null&&typeof plan==='object'?completionPlans.get(plan):undefined;if(owned===undefined)throw new TypeError('Expected factory-created mirror startup completion plan');return owned;
}
function sameCursor(a:BoundMirrorCursor,b:BoundMirrorCursor):boolean {
 return a.thread===b.thread&&encodeMirrorCursorAnchor(a.anchor)===encodeMirrorCursorAnchor(b.anchor)&&a.turn===b.turn&&a.updatedAt===b.updatedAt&&a.revision===b.revision&&a.operationId===b.operationId&&a.receiptSetHash===b.receiptSetHash;
}
function connectionChanges(db:DatabaseSync):bigint {
 const query=db.prepare('SELECT total_changes() AS n');query.setReadBigInts(true);const value=query.get()?.n;
 if(typeof value!=='bigint'||value<0n)throw new MirrorStartupIntentConflictError();return value;
}
function noCompletionPendingIn(db:DatabaseSync,pending:PendingMirrorStartupIntent):void {
 if(db.prepare(`SELECT 1 FROM ${TABLE} WHERE thread_id=? OR operation_id=? LIMIT 1`).get(pending.thread,pending.operationId)!==undefined)throw new MirrorStartupIntentConflictError();
}
function completedIn(db:DatabaseSync,owned:ReturnType<typeof completion>):BoundMirrorCursor {
 noCompletionPendingIn(db,owned.pending);const actual=readBoundMirrorCursorInTransaction(db,owned.pending.thread);
 if(actual===null||!sameCursor(actual,owned.desired))throw new MirrorStartupIntentConflictError();return actual;
}
/** null means the exact original pending packet still owns the absent cursor.
 * Otherwise reconcile only the exact completed cursor, never a later revision.
 * Owns a read-only transaction, and refuses an existing caller transaction. */
export function readPreparedMirrorStartupCompletion(db:DatabaseSync,plan:PreparedMirrorStartupCompletion):BoundMirrorCursor|null {
 const owned=completion(plan);return withStoreTransaction(db,'DEFERRED',()=>{
  schema(db);const pending=readIn(db,owned.pending.thread);
  if(pending===null)return rollbackStore(completedIn(db,owned));
  if(!same(pending,owned.pending))throw new MirrorStartupIntentConflictError();return rollbackStore(null);
 });
}
/** One owned SQLite transaction, no filesystem/network or caller callbacks.
 * Both cursor rows install before exact pending retirement. Every postcondition
 * is checked before commit, including triggers recreating/moving the intent.
 * This atomic DB transition does not assert atomic filesystem continuity. */
export function completePreparedMirrorStartupIntent(db:DatabaseSync,plan:PreparedMirrorStartupCompletion):MirrorStartupCompletionResult {
 const owned=completion(plan),{pending,desired,cutoffJson,anchorJson}=owned;
 return withStoreTransaction<MirrorStartupCompletionResult>(db,'IMMEDIATE',()=>{
  schema(db);const actual=readIn(db,pending.thread);
  if(actual===null)return rollbackStore(Object.freeze({kind:'Reconciled',cursor:completedIn(db,owned)}));
  if(!same(actual,pending))throw new MirrorStartupIntentConflictError();
  const before=connectionChanges(db);
  if(BigInt(db.prepare('INSERT INTO codex_session_mirror_offsets(codex_thread_id,rollout_path,cursor,updated_at,turn_context) VALUES(?,?,?,?,?)').run(desired.thread,desired.anchor.path,desired.anchor.offset,desired.updatedAt,desired.turn).changes)!==1n)throw new MirrorStartupIntentConflictError();
  if(BigInt(db.prepare('INSERT INTO cdr_ts_mirror_cursor_anchors_v1(thread_id,anchor_json,turn_context,updated_at,revision,operation_id,receipt_set_hash) VALUES(?,?,?,?,?,?,?)').run(desired.thread,anchorJson,desired.turn,desired.updatedAt,desired.revision,desired.operationId,desired.receiptSetHash).changes)!==1n)throw new MirrorStartupIntentConflictError();
  const retained=readPacketIn(db,pending.thread);if(retained===null||!same(retained,pending))throw new MirrorStartupIntentConflictError();
  if(BigInt(db.prepare(`DELETE FROM ${TABLE} WHERE thread_id=? AND CAST(thread_id AS BLOB)=CAST(? AS BLOB) AND cutoff_json=? AND CAST(cutoff_json AS BLOB)=CAST(? AS BLOB) AND operation_id=? AND CAST(operation_id AS BLOB)=CAST(? AS BLOB) AND created_at=?`).run(pending.thread,pending.thread,cutoffJson,cutoffJson,pending.operationId,pending.operationId,pending.createdAt).changes)!==1n)throw new MirrorStartupIntentConflictError();
  const cursor=completedIn(db,owned);
  // DELETE WHERE/RETURNING observes pre-trigger values. Count every connection
  // write as well, so BEFORE DELETE cannot rewrite/reinsert the packet and
  // disappear unnoticed. Extra trigger writes conservatively hold the operation.
  if(connectionChanges(db)-before!==3n)throw new MirrorStartupIntentConflictError();
  return commitStore(Object.freeze({kind:'Completed',cursor}));
 });
}
