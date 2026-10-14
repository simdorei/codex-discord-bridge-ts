import type {DatabaseSync} from 'node:sqlite';
import {isAbsolute} from 'node:path';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {encodeMirrorCursorAnchor,decodeMirrorCursorAnchor} from '../core/mirror-cursor-anchor.ts';
import {snapshotMirrorStartupCutoffData,type MirrorStartupCutoffData} from '../runtime/session-mirror/startup-context-limits.ts';
import {withStoreTransaction,commitStore,rollbackStore} from './owned-scope.ts';
import {receiptText,receiptTextColumns} from './delivery-receipt-key.ts';
import {decodeTimestamp} from './sqlite-values.ts';
import {requireMirrorCursorJournalIn} from './mirror-cursor-journal.ts';
import {MIRROR_STARTUP_INTENT_TABLE as TABLE,requireMirrorStartupIntentJournalIn,MirrorStartupIntentConflictError} from './mirror-startup-intent-schema.ts';
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
function readIn(db:DatabaseSync,thread:string):PendingMirrorStartupIntent|null {
 const q=db.prepare(`SELECT cutoff_json,operation_id,created_at,${receiptTextColumns('cutoff_json','operation_id')} FROM (SELECT ${bounded('cutoff_json',MAX_CUTOFF_BYTES*2)},${bounded('operation_id',256)},CASE WHEN typeof(created_at) IN ('integer','real') THEN created_at END AS created_at FROM ${TABLE} WHERE thread_id=? AND CAST(thread_id AS BLOB)=CAST(? AS BLOB) LIMIT 2)`);q.setReadBigInts(true);const rows=q.all(thread,thread);
 if(rows.length===0)return null;if(rows.length!==1)throw new MirrorStartupIntentConflictError();const row=rows[0]!;
 const result=snapshotPendingMirrorStartupIntent({thread,cutoff:decode(receiptText(row,'cutoff_json')!),operationId:receiptText(row,'operation_id')!,createdAt:decodeTimestamp(row.created_at,'created_at')});
 absentCursor(db,thread);return result;
}
export function readPendingMirrorStartupIntent(db:DatabaseSync,thread:string):PendingMirrorStartupIntent|null {
 text(thread,16384);return withStoreTransaction(db,'DEFERRED',()=>{schema(db);return rollbackStore(readIn(db,thread));});
}
function same(a:PendingMirrorStartupIntent,b:PendingMirrorStartupIntent):boolean {return a.thread===b.thread&&a.operationId===b.operationId&&a.createdAt===b.createdAt&&encode(a.cutoff)===encode(b.cutoff);}
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
