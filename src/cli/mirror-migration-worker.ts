import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {captureMirrorCursorAnchor,observeMirrorCursorContinuity} from '../runtime/session-mirror/continuity-observation.ts';
import {encodeMirrorCursorAnchor,decodeMirrorCursorAnchor} from '../core/mirror-cursor-anchor.ts';
import {initializeMirrorCursorJournal,readBoundMirrorCursor} from '../store/mirror-cursor-journal.ts';
import {requireNoPendingMirrorStartupIntentIn} from '../store/mirror-startup-intent-schema.ts';
import {WindowsFilePin} from '../runtime/windows/windows-file-pin.ts';
if(parentPort===null)throw new Error('Mirror cutover requires owned worker');
let db:DatabaseSync|undefined,pin:WindowsFilePin|undefined,result:unknown;
try{
 pin=process.platform==='win32'?WindowsFilePin.acquire(workerData.path,'file'):undefined;
 db=new DatabaseSync(workerData.path);db.exec('PRAGMA busy_timeout=3000');initializeMirrorCursorJournal(db);
 const query=db.prepare('SELECT codex_thread_id,rollout_path,cursor,turn_context,updated_at FROM codex_session_mirror_offsets WHERE (? IS NULL OR codex_thread_id=?) ORDER BY codex_thread_id LIMIT 4097');query.setReadBigInts(true);
 const rows=query.all(workerData.thread??null,workerData.thread??null);if(rows.length>4096)throw new Error('Mirror migration exceeds 4096 cursor budget');
 const migrated:string[]=[],already:string[]=[],held:{thread:string;reason:string}[]=[];
 for(const row of rows){let source:WindowsFilePin|undefined;const thread=row.codex_thread_id as string;
  try{
   if(typeof row.rollout_path!=='string'||typeof row.cursor!=='bigint'||row.cursor<0n||typeof row.turn_context!=='string')throw new Error('Invalid legacy cursor');
   const prior=db.prepare('SELECT anchor_json,revision FROM cdr_ts_mirror_cursor_anchors_v1 WHERE thread_id=?').get(thread);
   if(prior!==undefined){const bound=readBoundMirrorCursor(db,thread);if(bound===null)throw new Error('Missing bound cursor');await observeMirrorCursorContinuity(bound.anchor);if(bound.anchor.version===3){already.push(thread);continue;}}
   source=process.platform==='win32'?WindowsFilePin.acquire(row.rollout_path,'file'):undefined;
   const observation=await captureMirrorCursorAnchor(row.rollout_path,row.cursor,undefined,true);
   // Every consumed byte must still be identical immediately before the CAS.
   await observation.verifyCurrent();db.exec('BEGIN IMMEDIATE');requireNoPendingMirrorStartupIntentIn(db,thread);
   const exact=db.prepare('SELECT 1 FROM codex_session_mirror_offsets WHERE codex_thread_id=? AND rollout_path=? AND cursor=? AND turn_context=? AND updated_at=?').get(thread,row.rollout_path,row.cursor,row.turn_context,row.updated_at!);
   if(exact===undefined)throw new Error('Legacy cursor changed during migration');
   const operation='legacy-baseline-'+randomUUID(),anchor=encodeMirrorCursorAnchor(observation.anchor),hash=createHash('sha256').update('[]').digest('hex');
   if(prior===undefined)db.prepare('INSERT INTO cdr_ts_mirror_cursor_anchors_v1 VALUES(?,?,?,?,?,?,?)').run(thread,anchor,row.turn_context,row.updated_at!,1,operation,hash);
   else if(db.prepare('UPDATE cdr_ts_mirror_cursor_anchors_v1 SET anchor_json=?,revision=revision+1,operation_id=? WHERE thread_id=? AND anchor_json=? AND revision=?').run(anchor,operation,thread,prior.anchor_json!,prior.revision!).changes!==1)throw new Error('Anchor changed during migration');
   db.exec('COMMIT');migrated.push(thread);
  }catch(e){if(db.isTransaction)db.exec('ROLLBACK');held.push({thread,reason:e instanceof Error?e.message:'Cursor migration held'});}finally{source?.close();}
 }
 result={ok:true,value:{migrated,already,held,cursorsPreserved:true,replayAuthorized:false,historicalDeliveryVerified:false}};
}catch(e){result={ok:false,error:e instanceof Error?e.message:'Mirror migration failed'};}
finally{try{if(db?.isTransaction)db.exec('ROLLBACK');db?.close();pin?.close();}catch{result={ok:false,error:'Mirror migration cleanup unconfirmed'};}parentPort.postMessage(result);parentPort.close();}
