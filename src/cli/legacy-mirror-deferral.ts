import type {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {insertMirrorDeferralIn,readMirrorDeferralIn} from '../store/mirror-deferral.ts';
import {inspectLegacyMirrorRow,type LegacyMirrorInspection} from './legacy-mirror-inspection.ts';
import type {LegacyMirrorRow} from './mirror-migration-row.ts';

/** Source exclusion belongs to the administrative caller. The transaction
 * changes only the new hold/evidence record, never either existing cursor. */
export function deferLegacyMirrorRow(db:DatabaseSync,state:DatabaseSync,row:LegacyMirrorRow,expected:LegacyMirrorInspection,check:()=>void):void{
 if(!expected.requiresDurableHold||!['InactivePreserved','DeferredCompressedSource','DeferredLegacyBindingConflict','DeferredStoredHold'].includes(expected.disposition))throw new Error('Legacy row is not eligible for durable deferral');
 const evidenceJson=JSON.stringify({version:1,thread:expected.thread,policy:'rust-preserve',legacy:row,observation:expected},(_,v)=>typeof v==='bigint'?{integer:v.toString()}:v);
 const packet={thread:expected.thread,reason:expected.disposition==='DeferredLegacyBindingConflict'?'LegacyBindingConflict' as const:'CompressedSource' as const,
  operationId:'legacy-deferral-'+randomUUID(),createdAt:Date.now()/1000,evidenceJson,evidenceSha256:createHash('sha256').update(evidenceJson).digest('hex')};
 db.exec('BEGIN IMMEDIATE');
 try{
  check();const q=db.prepare('SELECT codex_thread_id,rollout_path,cursor,turn_context,updated_at FROM codex_session_mirror_offsets WHERE codex_thread_id=?');q.setReadBigInts(true);
  if(!isDeepStrictEqual(q.get(row.codex_thread_id!),row))throw new Error('Legacy cursor changed before durable deferral');
  const current=inspectLegacyMirrorRow(db,state,row,'rust-preserve',check);
  if(!isDeepStrictEqual(current,expected))throw new Error('Legacy durable deferral eligibility changed');
  const prior=readMirrorDeferralIn(db,expected.thread);
  const changes=Number(db.prepare('SELECT total_changes() AS n').get()!.n);
  if(prior===null)insertMirrorDeferralIn(db,packet);
  else if(expected.evidence.priorDeferral===null||prior.operationId!==expected.evidence.priorDeferral.operationId||prior.evidenceSha256!==expected.evidence.priorDeferral.evidenceSha256)throw new Error('Existing durable deferral changed');
  check();if(!isDeepStrictEqual(q.get(row.codex_thread_id!),row))throw new Error('Legacy cursor changed during durable deferral');
  // Re-observe every DB/file input before commit; existing holds already gate IO.
  const after=inspectLegacyMirrorRow(db,state,row,'rust-preserve',check);
  if(JSON.stringify(after.evidence.anchor)!==JSON.stringify(expected.evidence.anchor)||after.stateStatus!==expected.stateStatus||after.evidence.statePath!==expected.evidence.statePath||
    after.evidence.mapping!==expected.evidence.mapping||JSON.stringify(after.evidence.work)!==JSON.stringify(expected.evidence.work))throw new Error('Legacy evidence changed during durable deferral');
  if(Number(db.prepare('SELECT total_changes() AS n').get()!.n)-changes!==(prior===null?1:0))throw new Error('Unexpected writes during durable deferral');
  db.exec('COMMIT');
 }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
