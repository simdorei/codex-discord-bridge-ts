import {MirrorFileWindow} from '../runtime/session-mirror/file-window.ts';
import type {DatabaseSync,SQLOutputValue} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {captureMirrorCursorAnchor,observeMirrorCursorContinuity} from '../runtime/session-mirror/continuity-observation.ts';
import {encodeMirrorCursorAnchor} from '../core/mirror-cursor-anchor.ts';
import {readBoundMirrorCursor,readBoundMirrorCursorInTransaction} from '../store/mirror-cursor-journal.ts';
import {requireNoPendingMirrorStartupIntentIn} from '../store/mirror-startup-intent-schema.ts';
import {WindowsFilePin} from '../runtime/windows/windows-file-pin.ts';
import {MigrationBudget,recoverLegacyMirrorTurn} from './legacy-mirror-turn.ts';
import {requireNoMirrorDeferralIn} from '../store/mirror-deferral.ts';
export type LegacyMirrorRow=Record<string,SQLOutputValue>;
const priorSql='SELECT anchor_json,revision FROM cdr_ts_mirror_cursor_anchors_v1 WHERE thread_id=?';
/** One row is atomic. Earlier committed rows remain committed if later rows hold. */
export async function migrateMirrorRow(db:DatabaseSync,row:LegacyMirrorRow,budget:MigrationBudget):Promise<'migrated'|'already'>{
 let source:WindowsFilePin|undefined;
 try{
  budget.check();const thread=row.codex_thread_id;
  if(typeof thread!=='string'||typeof row.rollout_path!=='string'||typeof row.cursor!=='bigint'||row.cursor<0n||
    (row.turn_context!==null&&typeof row.turn_context!=='string'))throw new Error('Invalid legacy cursor');
  requireNoMirrorDeferralIn(db,thread);
  const prior=db.prepare(priorSql).get(thread);
  if(row.turn_context===null&&prior!==undefined)throw new Error('Legacy NULL context conflicts with existing anchor');
  if(prior!==undefined){
   const bound=readBoundMirrorCursor(db,thread);if(bound===null)throw new Error('Missing bound cursor');
   await observeMirrorCursorContinuity(bound.anchor,budget.signal);budget.check();if(bound.anchor.version===3)return 'already';
  }
  source=process.platform==='win32'?WindowsFilePin.acquire(row.rollout_path,'file'):undefined;
  if(row.cursor>0n){const boundary=await MirrorFileWindow.read(row.rollout_path,row.cursor-1n,1,budget.signal);budget.check();if(boundary.byteLength!==1||boundary.copyBytes()[0]!==10)throw new Error('Legacy cursor is not a complete LF record boundary');}
  const observation=await captureMirrorCursorAnchor(row.rollout_path,row.cursor,budget.signal,true);budget.check();
  const turn=row.turn_context===null?await recoverLegacyMirrorTurn(observation.anchor,budget):row.turn_context;
  await observation.verifyCurrent(budget.signal);budget.check();
  db.exec('BEGIN IMMEDIATE');budget.check();requireNoPendingMirrorStartupIntentIn(db,thread);
  const exact=db.prepare('SELECT 1 FROM codex_session_mirror_offsets WHERE codex_thread_id=? AND rollout_path=? AND cursor=? AND turn_context IS ? AND updated_at IS ?').get(thread,row.rollout_path,row.cursor,row.turn_context,row.updated_at!);
  if(exact===undefined)throw new Error('Legacy cursor changed during migration');
  const current=db.prepare(priorSql).get(thread);
  if(prior===undefined?current!==undefined:current===undefined||current.anchor_json!==prior.anchor_json||current.revision!==prior.revision)throw new Error('Anchor changed during migration');
  await observation.verifyCurrent(budget.signal);budget.check();
  const operation='legacy-baseline-'+randomUUID(),anchor=encodeMirrorCursorAnchor(observation.anchor),hash=createHash('sha256').update('[]').digest('hex');
  if(row.turn_context===null&&db.prepare('UPDATE codex_session_mirror_offsets SET turn_context=? WHERE codex_thread_id=? AND rollout_path=? AND cursor=? AND turn_context IS NULL AND updated_at IS ?').run(turn,thread,row.rollout_path,row.cursor,row.updated_at!).changes!==1)throw new Error('Legacy cursor changed during migration');
  if(prior===undefined)db.prepare('INSERT INTO cdr_ts_mirror_cursor_anchors_v1 VALUES(?,?,?,?,?,?,?)').run(thread,anchor,turn,row.updated_at!,1,operation,hash);
  else if(db.prepare('UPDATE cdr_ts_mirror_cursor_anchors_v1 SET anchor_json=?,revision=revision+1,operation_id=? WHERE thread_id=? AND anchor_json=? AND revision=?').run(anchor,operation,thread,prior.anchor_json!,prior.revision!).changes!==1)throw new Error('Anchor changed during migration');
  const bound=readBoundMirrorCursorInTransaction(db,thread);
  if(bound===null||bound.turn!==turn||bound.anchor.offset!==row.cursor)throw new Error('Migrated cursor validation failed');
  await observation.verifyCurrent(budget.signal);budget.check();db.exec('COMMIT');return 'migrated';
 }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}finally{source?.close();}
}
