import type {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual} from 'node:util';
import {requireNoPendingMirrorStartupIntentIn} from '../store/mirror-startup-intent-schema.ts';
import type {LegacyMirrorRow} from './mirror-migration-row.ts';
import type {LegacyMirrorPolicy} from './legacy-mirror-policy.ts';
import {legacyMirrorWork} from './legacy-mirror-work.ts';
import {inspectLegacyFile as file,inspectLegacyCompressed} from './legacy-mirror-source.ts';
import {legacyAnchorPresent,inspectLegacyAnchor,isDeferrableLegacyBinding} from './legacy-mirror-anchor.ts';
import {readMirrorDeferralIn} from '../store/mirror-deferral.ts';
export type LegacyDisposition='Migrate'|'InactivePreserved'|'DeferredLegacyBoundary'|'DeferredCompressedSource'|'DeferredLegacyBindingConflict'|'DeferredStoredHold'|'Held';
const json=(value:unknown)=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?{integer:v.toString()}:v);
export function legacyMirrorRows(db:DatabaseSync,thread?:string):LegacyMirrorRow[]{
 const invalid=db.prepare(`SELECT 1 FROM codex_session_mirror_offsets WHERE
  typeof(codex_thread_id)!='text' OR length(CAST(codex_thread_id AS BLOB)) NOT BETWEEN 1 AND 16384 OR
  typeof(rollout_path)!='text' OR length(CAST(rollout_path AS BLOB)) NOT BETWEEN 1 AND 32768 OR
  (turn_context IS NOT NULL AND (typeof(turn_context)!='text' OR length(CAST(turn_context AS BLOB))>16384)) LIMIT 1`).get();
 if(invalid)throw new Error('Legacy mirror source value budget/type exceeded');
 const q=db.prepare('SELECT codex_thread_id,rollout_path,cursor,turn_context,updated_at FROM codex_session_mirror_offsets WHERE (? IS NULL OR codex_thread_id=?) ORDER BY codex_thread_id LIMIT 4097');q.setReadBigInts(true);
 const rows=q.all(thread??null,thread??null);if(rows.length>4096)throw new Error('Legacy mirror row budget exceeded');return rows;
}
export function inspectLegacyMirrorRow(db:DatabaseSync,state:DatabaseSync,row:LegacyMirrorRow,policy:LegacyMirrorPolicy,check:()=>void){
 check();const id=row.codex_thread_id,path=row.rollout_path,cursor=row.cursor;
 if(typeof id!=='string'||typeof path!=='string'||typeof cursor!=='bigint'||cursor<0n||
  (row.turn_context!==null&&typeof row.turn_context!=='string')||
  !['number','bigint'].includes(typeof row.updated_at)||!Number.isFinite(Number(row.updated_at))||Number(row.updated_at)<0)throw new Error('Invalid legacy cursor metadata');
 const matches=state.prepare("SELECT CASE WHEN typeof(rollout_path)='text' AND length(CAST(rollout_path AS BLOB)) BETWEEN 1 AND 32768 THEN rollout_path END AS rollout_path,archived FROM threads WHERE id=? LIMIT 2").all(id);
 if(matches.length>1)throw new Error('Reconciliation state identity ambiguous');const match=matches[0];
 if(match&&(typeof match.rollout_path!=='string'||![0,1].includes(match.archived as number)))throw new Error('Reconciliation state metadata invalid');
 const stateStatus=match===undefined?'MissingState':match.archived===1?'Archived':'Active',statePath=match?.rollout_path as string|undefined;
 const priorDeferral=readMirrorDeferralIn(db,id);
 let mapped:boolean|undefined,mapping:string|null=null;
 if(policy==='rust-preserve'){
  const q=db.prepare('SELECT * FROM mirror_threads WHERE codex_thread_id=? LIMIT 2');q.setReadBigInts(true);const mappings=q.all(id);
  if(mappings.length>1||mappings.some(v=>typeof v.discord_thread_id!=='bigint'||v.discord_thread_id<=0n))throw new Error('Invalid legacy mirror mapping');
  mapped=mappings.length===1;mapping=json(mappings);
 }
 if(priorDeferral!==null){
  requireNoPendingMirrorStartupIntentIn(db,id);const anchor=inspectLegacyAnchor(db,id),work=policy==='rust-preserve'?legacyMirrorWork(db,id):null;
  const inactive=policy==='rust-preserve'&&!mapped&&stateStatus!=='Active'&&work?.reason===null;
  check();return {thread:id,originalPath:path,cursor:cursor.toString(),stateStatus,sourceStatus:'DeferredNotRead',classification:'DurableDeferral',retargetAuthorized:false,
   disposition:(policy==='strict'?'Held':inactive?'InactivePreserved':'DeferredStoredHold') as LegacyDisposition,reason:priorDeferral.reason,dormantHeld:inactive?work!.dormantHeld:0,
   ...(mapped===undefined?{}:{mapped}),requiresDurableHold:true,evidence:{sourceStamp:null,candidateStamp:null,statePath:statePath??null,compressed:null,anchor:anchor?.packet??null,mapping,work,priorDeferral:{reason:priorDeferral.reason,operationId:priorDeferral.operationId,evidenceSha256:priorDeferral.evidenceSha256}}};
 }
 const source=file(path,cursor,check);
 const candidate=source.status==='Missing'&&stateStatus==='Archived'&&statePath!==path&&statePath!==undefined?file(statePath,undefined,check):undefined;
 const compressed=source.status==='Missing'&&(statePath===path||candidate?.status==='Missing')?inspectLegacyCompressed(candidate?.status==='Missing'?statePath!:path,check):null;
 const isCompressed=compressed?.status==='CompressedCandidate';
 const classification=candidate?.status==='Exists'?'ArchivedRelocatedCandidate':stateStatus==='MissingState'?'MissingState':
  candidate?.status==='Missing'&&isCompressed?'ArchivedRelocatedCompressedCandidate':statePath!==path?'StatePathMismatch':compressed!==null&&compressed.status!=='Missing'?compressed.status:source.status;
 let disposition:LegacyDisposition=classification==='LFAligned'?'Migrate':'Held',reason=classification,dormantHeld=0;
 let anchor:ReturnType<typeof inspectLegacyAnchor>=null,work:ReturnType<typeof legacyMirrorWork>|null=null,requiresDurableHold=false;
 if(policy==='rust-preserve'){
  const inactive=!mapped&&(classification==='ArchivedRelocatedCandidate'||stateStatus==='MissingState'&&source.status==='Missing'||stateStatus==='Archived'&&isCompressed&&['CompressedCandidate','ArchivedRelocatedCompressedCandidate'].includes(classification));
  const deferred=mapped&&stateStatus==='Active'&&classification==='NonRecordBoundary';
  const compressedActive=mapped&&stateStatus==='Active'&&classification==='CompressedCandidate';
  if(inactive||deferred||compressedActive||classification==='LFAligned'){
   requireNoPendingMirrorStartupIntentIn(db,id);
   if((inactive&&!isCompressed||deferred)&&legacyAnchorPresent(db,id))throw new Error('Existing TS anchor prevents legacy preservation');
   anchor=inspectLegacyAnchor(db,id);
   if(isCompressed&&anchor!==null&&anchor.bound.anchor.path!==path)throw new Error('Compressed legacy anchor path differs');
   if(inactive||compressedActive){work=legacyMirrorWork(db,id);dormantHeld=work.dormantHeld;
    if(inactive&&work.reason!==null)reason='Inactive legacy row has '+work.reason;
    else{disposition=inactive?'InactivePreserved':'DeferredCompressedSource';requiresDurableHold=isCompressed;}
   }else if(deferred)disposition='DeferredLegacyBoundary';
   else if(mapped&&stateStatus==='Active'&&anchor!==null&&isDeferrableLegacyBinding(row,anchor)){
    work=legacyMirrorWork(db,id);disposition='DeferredLegacyBindingConflict';reason='LegacyBaselineBindingConflict';requiresDurableHold=true;
   }
  }
 }
 check();return {thread:id,originalPath:path,cursor:cursor.toString(),stateStatus,sourceStatus:source.status,classification,
  ...(candidate!==undefined?{candidatePath:statePath}:{}),retargetAuthorized:false,disposition,reason,dormantHeld,requiresDurableHold,
  ...(mapped===undefined?{}:{mapped}),evidence:{sourceStamp:source.stamp??null,candidateStamp:candidate?.stamp??null,statePath:statePath??null,compressed,anchor:anchor?.packet??null,mapping,work,priorDeferral:null}};
}
export type LegacyMirrorInspection=ReturnType<typeof inspectLegacyMirrorRow>;
/** Read-only transactional recheck. A preserved row gets no anchor and no write. */
export function preserveLegacyMirrorRow(db:DatabaseSync,state:DatabaseSync,row:LegacyMirrorRow,expected:LegacyMirrorInspection,check:()=>void):void{
 if(expected.requiresDurableHold||!['InactivePreserved','DeferredLegacyBoundary'].includes(expected.disposition))throw new Error('Legacy row is not eligible for read-only preservation');
 db.exec('BEGIN IMMEDIATE');
 try{
  check();const q=db.prepare('SELECT codex_thread_id,rollout_path,cursor,turn_context,updated_at FROM codex_session_mirror_offsets WHERE codex_thread_id=?');q.setReadBigInts(true);
  if(!isDeepStrictEqual(q.get(row.codex_thread_id!),row))throw new Error('Legacy cursor changed before preservation');
  const current=inspectLegacyMirrorRow(db,state,row,'rust-preserve',check);
  if(!isDeepStrictEqual(current,expected))throw new Error('Legacy preservation eligibility changed');
  check();
 }finally{db.exec('ROLLBACK');}
}
