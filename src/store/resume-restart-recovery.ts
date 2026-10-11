import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {getOwn as field} from './async-resolution-json-helpers.ts';
import {ownerIsCurrent} from './mutation-attempt.ts';
import {EXECUTION_HOLD_PREFIX} from './execution-hold.ts';
import {requireStopControlUnheldIn} from './runtime-fence-reads.ts';
import {requireResponseUnheldIn} from './response-custody.ts';
import {usingExistingStore,withStoreTransaction,commitStore} from './owned-scope.ts';
import {decodeTextField,textDecoderFor,decodeBool} from './sqlite-values.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
import {pinNativeRuntimePath} from '../runtime/runtime-paths/path-text.ts';
const RECORD=`SELECT json_object(
    'sequence',sequence,'attempt_id',attempt_id,'runtime_id',runtime_id,
    'owner_id',owner_id,'generation',generation,'wire_id',wire_id,'method',method,
    'target_thread_id',target_thread_id,'scoped',scoped,'request_sha256',request_sha256,
    'state',state,'created_at',created_at,'updated_at',updated_at) AS value
    FROM codex_mutation_attempts WHERE attempt_id=?`;
export interface ResumeRecoveryCandidate{readonly attemptId:string;readonly target:string}
const originals=new WeakMap<object,{path:string;original:string}>();
function refused(detail:string):never{throw new StoreIntegrityError(detail);}
function text(v:unknown):asserts v is string{if(typeof v!=='string'||/[\uD800-\uDFFF]/u.test(v))throw new TypeError('Expected well-formed recovery identity');}
function decoder(db:DatabaseSync){return textDecoderFor(db.prepare('PRAGMA encoding').get()!.encoding);}
function record(db:DatabaseSync,id:string):string|null{const q=db.prepare(`SELECT value,CAST(value AS BLOB) AS bytes FROM (${RECORD})`);q.setReadBigInts(true);const row=q.get(id);return row===undefined?null:decodeTextField(row.value,row.bytes,'original resume attempt',false,decoder(db));}
function scalar(db:DatabaseSync,sql:string,...args:SQLInputValue[]):boolean{const q=db.prepare(sql);q.setReadBigInts(true);return decodeBool(q.get(...args)?.value,'resume recovery occupancy');}
/** Existing-only, at most 64 prior-runtime scoped resume attempts. Candidates are
 * opaque local snapshots, not permission; caller must observe the new resident.
 * Pins a pathname for cross-store custody, not a native inode lifetime guarantee. */
export function scanResumeRecoveryCandidates(path:string,runtime:string):readonly ResumeRecoveryCandidate[]{
 text(path);text(runtime);const pinned=pinNativeRuntimePath(path);
 return usingExistingStore(pinned,db=>{ownerIsCurrent(db,runtime);const q=db.prepare(`SELECT attempt_id,target_thread_id,CAST(attempt_id AS BLOB) AS attempt_bytes,CAST(target_thread_id AS BLOB) AS target_bytes FROM codex_mutation_attempts
 WHERE state='prepared' AND method='thread/resume' AND scoped=1 AND runtime_id<>? ORDER BY sequence LIMIT 64`);q.setReadBigInts(true);const rows=q.all(runtime),d=decoder(db);
 return Object.freeze(rows.map(row=>{const attemptId=decodeTextField(row.attempt_id,row.attempt_bytes,'attempt_id',false,d)!,target=decodeTextField(row.target_thread_id,row.target_bytes,'target_thread_id',false,d)!;const original=record(db,attemptId);if(original===null)refused('resume restart attempt disappeared during scan');const candidate=Object.freeze({attemptId,target});originals.set(candidate,{path:pinned,original});return candidate;}));});
}
function idle(target:string,metadata:unknown,latest:unknown):boolean{
 if(field(field(metadata,'thread'),'id')!==target||!['idle','notLoaded'].includes(field(field(field(metadata,'thread'),'status'),'type') as string)||(field(latest,'truncated')!==undefined&&field(latest,'truncated')!==false))return false;
 const turns=field(latest,'data');if(!Array.isArray(turns))return false;
 if(turns.length===0)return field(latest,'nextCursor')===null;
 if(turns.length!==1)return false;const id=field(turns[0],'id');return typeof id==='string'&&id!==''&&['completed','interrupted','failed'].includes(field(turns[0],'status') as string);
}
export function isIdleResumeRecoveryObservation(target:string,metadata:unknown,latest:unknown):boolean{text(target);return idle(target,cloneOwnedSerdeValue(metadata),cloneOwnedSerdeValue(latest));}
function matchingPreflight(error:string,attempt:string):boolean{
 if(!error.startsWith(EXECUTION_HOLD_PREFIX))return false;error=error.slice(EXECUTION_HOLD_PREFIX.length);
 return error.startsWith('app-server mutation thread/resume outcome remains unknown:')&&error.endsWith(`; durable attempt ${attempt} retained; no automatic replay`)||error===`mutation execution held: SQLite integrity check failed: unresolved mutation ${attempt} (thread/resume); dispatch held without replay`;
}
/** Must run before worker dispatch/admission. Archives exact original evidence and
 * retires only a prior-runtime idle resume. It never settles a turn/start or grants
 * replay permission. New requests still pass all normal durable and writer gates. */
export function recoverIdleResume(path:string,runtime:string,resident:string,generation:bigint,candidate:ResumeRecoveryCandidate,metadataInput:unknown,latestInput:unknown):number{
 text(path);text(runtime);text(resident);const saved=candidate!==null&&typeof candidate==='object'?originals.get(candidate):undefined;
 if(saved===undefined||saved.path!==pinNativeRuntimePath(path))refused('resume restart recovery requires an owned candidate from this store');
 const metadata=cloneOwnedSerdeValue(metadataInput),latest=cloneOwnedSerdeValue(latestInput);
 if(resident===''||typeof generation!=='bigint'||generation<1n||generation>9223372036854775807n||!idle(candidate.target,metadata,latest))refused('resume restart recovery lacks an idle observation');
 const old=parseSerdeValue(saved.original);
 if(field(old,'runtime_id')===runtime||field(old,'owner_id')===resident||field(old,'method')!=='thread/resume'||field(old,'state')!=='prepared'||field(old,'scoped')!==1n||field(old,'target_thread_id')!==candidate.target||field(old,'attempt_id')!==candidate.attemptId)refused('resume restart recovery requires an exact prior runtime attempt');
 return usingExistingStore(saved.path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{
  ownerIsCurrent(db,runtime);if(record(db,candidate.attemptId)!==saved.original)refused('resume restart attempt changed during observation');requireStopControlUnheldIn(db,candidate.target);requireResponseUnheldIn(db,candidate.target);
  if(scalar(db,`SELECT EXISTS(SELECT 1 FROM codex_turn_queue WHERE target_thread_id=?1 AND state<>'pending') OR EXISTS(SELECT 1 FROM codex_mutation_attempts WHERE state='prepared' AND attempt_id<>?2 AND (scoped=0 OR target_thread_id=?1)) AS value`,candidate.target,candidate.attemptId))refused('resume restart target still has unresolved execution');
  const q=db.prepare(`SELECT job_id,last_error,CAST(job_id AS BLOB) AS job_bytes,CAST(last_error AS BLOB) AS error_bytes FROM codex_turn_queue WHERE target_thread_id=? AND state='pending' AND turn_id IS NULL AND execution_generation IS NULL AND baseline_turn_ids='[]' AND NOT EXISTS(SELECT 1 FROM cdr_execution_holds h WHERE h.job_id=codex_turn_queue.job_id)`);q.setReadBigInts(true);const d=decoder(db),jobs=q.all(candidate.target).map(row=>[decodeTextField(row.job_id,row.job_bytes,'job_id',false,d)!,decodeTextField(row.last_error,row.error_bytes,'last_error',false,d)!] as const).filter(([,error])=>matchingPreflight(error,candidate.attemptId));
  const now=Date.now()/1000;if(!Number.isFinite(now)||now<0)refused('invalid system wall clock timestamp');
  const proof=serializeSerdeValue({resident,generation,metadata,latest,preflight_errors:jobs,resolution:'prior runtime idle resume retired; original reply remains unknown'});
  if(db.prepare('INSERT INTO cdr_resume_restart_recoveries VALUES(?,?,?,?,?)').run(candidate.attemptId,saved.original,proof,runtime,now).changes!==1||db.prepare("DELETE FROM codex_mutation_attempts WHERE attempt_id=? AND state='prepared'").run(candidate.attemptId).changes!==1)refused('resume restart recovery lost its exact attempt');
  for(const [job,error] of jobs)if(db.prepare("UPDATE codex_turn_queue SET last_error='',updated_at=? WHERE job_id=? AND state='pending' AND turn_id IS NULL AND last_error=?").run(now,job,error).changes!==1)refused('resume restart recovery lost a pending preflight');
  ownerIsCurrent(db,runtime);return commitStore(jobs.length);
 }));
}
