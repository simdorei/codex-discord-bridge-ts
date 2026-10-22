import type {DatabaseSync} from 'node:sqlite';
import {decodeMirrorCursorAnchor} from '../core/mirror-cursor-anchor.ts';
import {requireMirrorCursorJournalIn,snapshotBoundMirrorCursor} from '../store/mirror-cursor-journal.ts';
import {decodeTimestamp} from '../store/sqlite-values.ts';
import {createHash} from 'node:crypto';
import type {LegacyMirrorRow} from './mirror-migration-row.ts';

export function legacyAnchorPresent(db:DatabaseSync,thread:string):boolean{
 const schema=db.prepare("SELECT type FROM sqlite_schema WHERE name='cdr_ts_mirror_cursor_anchors_v1' COLLATE NOCASE").get();
 if(schema===undefined)return false;requireMirrorCursorJournalIn(db);
 return db.prepare('SELECT 1 FROM cdr_ts_mirror_cursor_anchors_v1 WHERE thread_id=?').get(thread)!==undefined;
}
export function inspectLegacyAnchor(db:DatabaseSync,thread:string){
 if(!legacyAnchorPresent(db,thread))return null;
 const q=db.prepare('SELECT * FROM cdr_ts_mirror_cursor_anchors_v1 WHERE thread_id=?');q.setReadBigInts(true);const raw=q.get(thread)!;
 if(raw.thread_id!==thread)throw new Error('Legacy anchor target identity differs');
 const bound=snapshotBoundMirrorCursor({thread,anchor:decodeMirrorCursorAnchor(raw.anchor_json as string),turn:raw.turn_context as string,
  updatedAt:decodeTimestamp(raw.updated_at,'updated_at'),revision:raw.revision as bigint,operationId:raw.operation_id as string,receiptSetHash:raw.receipt_set_hash as string});
 const packet={thread,anchorJson:raw.anchor_json as string,turn:bound.turn,updatedAt:bound.updatedAt,revision:bound.revision.toString(),operationId:bound.operationId,receiptSetHash:bound.receiptSetHash};
 return {bound,packet};
}
/** These checks authorize only a durable block. They do not prove provenance,
 * absence of TS delivery, or permission to repair/rebase either cursor row. */
export function isDeferrableLegacyBinding(row:LegacyMirrorRow,prior:NonNullable<ReturnType<typeof inspectLegacyAnchor>>):boolean{
 const b=prior.bound;
 return b.anchor.version===3&&b.revision===1n&&/^legacy-baseline-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(b.operationId)&&
  b.receiptSetHash===createHash('sha256').update('[]').digest('hex')&&row.rollout_path===b.anchor.path&&typeof row.cursor==='bigint'&&row.cursor>=b.anchor.offset&&
  (row.cursor!==b.anchor.offset||row.turn_context!==b.turn||Number(row.updated_at)!==b.updatedAt);
}
