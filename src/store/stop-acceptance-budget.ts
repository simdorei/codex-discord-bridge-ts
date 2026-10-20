import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {getOwn} from './async-resolution-json-helpers.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
import {serializeStoredQueueJob,type StoredQueueJob} from './queue-read.ts';
import {decodeI64,textDecoderFor} from './sqlite-values.ts';

/** Explicit fail-closed TS capacity policy, not a Rust parity/performance claim.
 * Raw SQLite storage is measured before native text/BLOB conversion or JSON.
 * UTF-16 text is conservatively charged twice its stored bytes. Generated JSON
 * may escape and duplicate bounded originals, so it has a separate allowance.
 * Each actual repeated read is charged; preflights do not grant future custody. */
export const STOP_ACCEPTANCE_MAX_ROWS=128;
export const STOP_ACCEPTANCE_MAX_FIELD_BYTES=64*1024;
export const STOP_ACCEPTANCE_MAX_SOURCE_BYTES=1024*1024;
export const STOP_ACCEPTANCE_MAX_EVIDENCE_BYTES=4*1024*1024;
export const STOP_ACCEPTANCE_MAX_READ_BYTES=8*1024*1024;
export const STOP_ACCEPTANCE_MAX_SCAN_ROWS=1024;
const QUEUE='job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,app_server_generation,execution_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,last_error,created_at,updated_at,goal_waiting,turn_observation_generation';
const INTAKE='job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,raw_prompt,auto_queue_when_busy,require_current_mirror,attempt_count,last_error,retry_after,claim_token,claim_expires_at,created_at,updated_at';
const INGRESS='ingress_id,kind,event_id,application_id,channel_id,owner_user_id,source_message_id,payload_json,runtime_id,state,phase,target_thread_id,canonical_owner,owner_kind,owner_id,outcome_json,confirmation_delivered,hold_reason,created_at,updated_at';
const HOLD='job_id,target_thread_id,reason,evidence_json';
const CONTROL='operation_id,target_thread_id,resident_owner,generation,turn_id,record_json';
export const STOP_UNOWNED_CANDIDATE="target_thread_id=? AND owner_id IS NULL AND state IN ('staged','acknowledged','executing','held')";
const UNOWNED_JSON=`json_type(payload_json,'$.version')='integer' AND json_extract(payload_json,'$.version')=1 AND (
 (kind='message' AND (json_type(payload_json,'$.plan.Execute.Ask.prompt')='text' OR json_type(payload_json,'$.plan.Execute.Interview.prompt')='text')) OR
 (kind='interaction' AND json_extract(payload_json,'$.work.Slash.name') IN ('ask','interview') AND json_type(payload_json,'$.work.Slash.values.prompt.String')='text'))`;
/** CASE guarantees unrelated targets/owned/terminal rows never enter JSON,
 * independently of WHERE predicate reordering. Call scan() before this SQL. */
export const STOP_UNOWNED_MATCH=`CASE WHEN ${STOP_UNOWNED_CANDIDATE} THEN (${UNOWNED_JSON}) ELSE 0 END`;
interface Size {rows:number;bytes:number;sourceBytes:number;}
const TEXT_COLUMNS=new Set('job_id,target_thread_id,prompt,state,turn_id,baseline_turn_ids,last_error,raw_prompt,claim_token,ingress_id,kind,payload_json,runtime_id,phase,canonical_owner,owner_kind,owner_id,outcome_json,hold_reason,reason,evidence_json,operation_id,resident_owner,record_json,codex_thread_id,scope_json'.split(','));
const REAL_COLUMNS=new Set('created_at,updated_at,retry_after,claim_expires_at'.split(','));
const contexts=new WeakMap<DatabaseSync,StopAcceptanceBudget>();
function refused(reason:string):never{throw new StoreIntegrityError(`stop acceptance ${reason} budget exceeded; durable originals retained`);}
export function boundedStopEvidenceJson(value:unknown):string{
 if(boundedSerdeByteCount(value,STOP_ACCEPTANCE_MAX_EVIDENCE_BYTES)===null)refused('generated JSON');
 return serializeSerdeValue(value);
}
/** Pre-count the decoded job before its exact legacy serializer allocates. The
 * snake_case wire keys add fewer than 1 KiB; reserve that overhead explicitly. */
export function boundedStopQueueJson(job:StoredQueueJob):string{
 if(boundedSerdeByteCount({...job,createdAt:Number.isFinite(job.createdAt)?job.createdAt:null,updatedAt:Number.isFinite(job.updatedAt)?job.updatedAt:null},STOP_ACCEPTANCE_MAX_EVIDENCE_BYTES-1024)===null)refused('generated queue JSON');
 return serializeStoredQueueJob(job);
}
/** Bound the escaped nested job strings while constructing the control array. */
export function boundedStopQueueRecords(jobs:readonly StoredQueueJob[]):string[]{
 const result:string[]=[];let bytes=2;
 for(const job of jobs){const raw=boundedStopQueueJson(job),size=boundedSerdeByteCount(raw,STOP_ACCEPTANCE_MAX_EVIDENCE_BYTES-bytes);if(size===null)refused('generated control JSON');bytes+=size+(result.length?1:0);if(bytes>STOP_ACCEPTANCE_MAX_EVIDENCE_BYTES)refused('generated control JSON');result.push(raw);}
 return result;
}
export function stopAcceptanceBudgetIn(db:DatabaseSync):StopAcceptanceBudget|undefined{return contexts.get(db);}
export function withStopAcceptanceBudgetIn<T>(db:DatabaseSync,target:string,channel:bigint,binding:unknown,expected:string|null,work:()=>T):T{
 if(!db.isTransaction||contexts.has(db))throw new StoreIntegrityError('Stop acceptance budget requires its own active transaction');
 const budget=new StopAcceptanceBudget(db,target,channel,getOwn(binding,'route'),expected);contexts.set(db,budget);
 try{return work();}finally{contexts.delete(db);}
}
export class StopAcceptanceBudget{
 readonly #db:DatabaseSync;readonly #target:string;readonly #channel:bigint;readonly #route:unknown;readonly #expected:string|null;
 readonly #multiplier:number;readonly #tables=new Set<string>();readonly #generatedIngress=new Set<string>();#readBytes=0;
 constructor(db:DatabaseSync,target:string,channel:bigint,route:unknown,expected:string|null){
  if(!db.isTransaction)throw new StoreIntegrityError('Stop acceptance budget requires an active transaction');
  this.#db=db;this.#target=target;this.#channel=channel;this.#route=route;this.#expected=expected;
  const encoding=db.prepare('PRAGMA encoding').get()?.encoding;textDecoderFor(encoding);this.#multiplier=encoding==='UTF-8'?1:2;
 }
 #ordinary(table:string):void{
  if(this.#tables.has(table))return;
  const q=this.#db.prepare("SELECT count(*) AS n FROM pragma_table_list WHERE schema='main' AND name=? AND type='table'");q.setReadBigInts(true);
  if(decodeI64(q.get(table)?.n,'ordinary table')!==1n)throw new StoreIntegrityError('Stop acceptance requires existing ordinary main tables; no schema repair');
  this.#tables.add(table);
 }
 #measure(table:string,columns:string,where:string,args:readonly SQLInputValue[],maxRows=STOP_ACCEPTANCE_MAX_ROWS,charge=false,evidence:readonly string[]=[]):Size{
  this.#ordinary(table);
  const names=columns.split(','),size=(name:string)=>`CASE typeof(${name}) WHEN 'null' THEN 0 WHEN 'text' THEN ${this.#multiplier}*length(CAST(${name} AS BLOB)) WHEN 'blob' THEN length(${name}) ELSE 8 END`;
  const storage=(name:string)=>`typeof(${name}) NOT IN (${TEXT_COLUMNS.has(name)?"'null','text'":REAL_COLUMNS.has(name)?"'null','integer','real'":"'null','integer'"})`;
  const q=this.#db.prepare(`SELECT count(*) AS n,COALESCE(sum(bytes),0) AS bytes,COALESCE(sum(source_bytes),0) AS source_bytes,COALESCE(max(invalid),0) AS invalid,COALESCE(max(oversized),0) AS oversized FROM (
   SELECT ${names.map(size).join('+')} AS bytes,${names.filter(n=>!evidence.includes(n)).map(size).join('+')||'0'} AS source_bytes,CASE WHEN ${names.map(storage).join(' OR ')} THEN 1 ELSE 0 END AS invalid,CASE WHEN ${names.map(name=>`${size(name)}>${evidence.includes(name)?STOP_ACCEPTANCE_MAX_EVIDENCE_BYTES:STOP_ACCEPTANCE_MAX_FIELD_BYTES}`).join(' OR ')} THEN 1 ELSE 0 END AS oversized
   FROM (SELECT ${columns} FROM main.${table} ${where}) LIMIT ${maxRows+1})`);q.setReadBigInts(true);const row=q.get(...args);
  const rows=decodeI64(row?.n,'row count'),bytes=decodeI64(row?.bytes,'storage bytes'),sourceBytes=decodeI64(row?.source_bytes,'source storage bytes');
  if(decodeI64(row?.invalid,'storage type')!==0n)throw new StoreIntegrityError('Stop acceptance invalid SQLite storage class before decode');
  if(rows>BigInt(maxRows))refused('row');
  if(decodeI64(row?.oversized,'field size')!==0n)refused('field byte');
  const limit=evidence.length?STOP_ACCEPTANCE_MAX_READ_BYTES:STOP_ACCEPTANCE_MAX_SOURCE_BYTES;
  if(sourceBytes>BigInt(STOP_ACCEPTANCE_MAX_SOURCE_BYTES)||bytes>BigInt(limit))refused('cumulative byte');
  if(charge){this.#readBytes+=Number(bytes);if(this.#readBytes>STOP_ACCEPTANCE_MAX_READ_BYTES)refused('cumulative repeated-read byte');}
  return {rows:Number(rows),bytes:Number(bytes),sourceBytes:Number(sourceBytes)};
 }
 #mapping(charge:boolean):Size{
  if(this.#route!=='Mapped'&&this.#route!=='Selected')return {rows:0,bytes:0,sourceBytes:0};
  this.#ordinary('mirror_threads');
  // Match mirroredThreadIdIn: exact room first, otherwise only two newest
  // parent-channel rows. Unread titles and unrelated mappings are irrelevant.
  const exact=this.#measure('mirror_threads','codex_thread_id','WHERE discord_thread_id=?',[this.#channel],2,charge);
  if(exact.rows!==0)return exact;
  return this.#measure('mirror_threads','codex_thread_id','WHERE discord_channel_id=? ORDER BY updated_at DESC LIMIT 2',[this.#channel],2,charge);
 }
 observed():void{this.#ordinary('codex_observed_completions');}
 binding(expected:string|null):void{this.#mapping(true);if(expected!==null)this.ingress(expected);}
 job(id:string):void{this.#measure('codex_turn_queue',QUEUE,'WHERE job_id=?',[id],1,true);}
 intake(id:string):void{this.#measure('codex_prompt_intakes',INTAKE,'WHERE job_id=?',[id],1,true);}
 generatedIngress(id:string):void{this.#generatedIngress.add(id);}
 ingress(id:string):void{this.#measure('discord_ingress_journal',INGRESS,'WHERE ingress_id=?',[id],1,true,this.#generatedIngress.has(id)?['outcome_json']:[]);}
 hold(id:string):void{this.#measure('cdr_execution_holds',HOLD,'WHERE job_id=?',[id],1,true,['evidence_json']);}
 control(operation:string,charge=true):Size{return this.#measure('cdr_stop_controls',CONTROL,'WHERE operation_id=?',[operation],1,charge,['record_json']);}
 scan(charge=true):Size{
  // No JSON function occurs in this statement. Fail before parsing even one
  // candidate when the scanned payload bytes or candidate count exceed capacity.
  return this.#measure('discord_ingress_journal','payload_json',`WHERE ${STOP_UNOWNED_CANDIDATE}`,[this.#target],STOP_ACCEPTANCE_MAX_SCAN_ROWS,charge);
 }
 ids(table:string,column:string,unowned=false):void{
  if(unowned)this.scan();
  this.#measure(table,column,`WHERE ${unowned?STOP_UNOWNED_MATCH:'target_thread_id=?'}`,[this.#target],STOP_ACCEPTANCE_MAX_ROWS,true);
 }
 revision(charge=true):Size{
  this.#ordinary('cdr_stop_clock');this.#ordinary('cdr_stop_revision_receipts');this.#ordinary('cdr_stop_revisions');
  // currentStopRevisionIn returns global max(revision), which could otherwise
  // materialize an oversized BLOB from a corrupt numeric column. Check only its
  // aggregate storage type, not unrelated receipt payloads/history identities.
  const q=this.#db.prepare("SELECT typeof(max(revision)) AS storage FROM main.cdr_stop_revision_receipts");
  const storage=q.get()?.storage;if(storage!=='null'&&storage!=='integer')throw new StoreIntegrityError('Invalid stop revision SQLite storage class');
  const clock=this.#measure('cdr_stop_clock','singleton,revision','WHERE singleton=1',[],1,charge);
  const latest=this.#measure('cdr_stop_revisions','target_thread_id,revision,operation_id','WHERE target_thread_id=?',[this.#target],1,charge);
  const receipt=this.#measure('cdr_stop_revision_receipts','operation_id,target_thread_id,revision,scope_json','WHERE target_thread_id=? ORDER BY revision DESC LIMIT 1',[this.#target],1,charge,['scope_json']);
  return {rows:clock.rows+latest.rows+receipt.rows,bytes:clock.bytes+latest.bytes+receipt.bytes,sourceBytes:clock.sourceBytes+latest.sourceBytes+receipt.sourceBytes};
 }
 /** Initial/post-mutation complete snapshot proof, before any full decoder.
  * Running first uses queue-only mode, preserving its no-Running early return.
  * Later exact guards cover trigger changes between this check and each read. */
 preflight(includeOriginals:boolean,operation?:string):void{
  const queue=this.#measure('codex_turn_queue',QUEUE,'WHERE target_thread_id=?',[this.#target]);
  let rows=queue.rows,sourceBytes=queue.bytes+this.#mapping(false).bytes,evidenceBytes=0;
  if(this.#expected!==null){const size=this.#measure('discord_ingress_journal',INGRESS,'WHERE ingress_id=?',[this.#expected],1,false,this.#generatedIngress.has(this.#expected)?['outcome_json']:[]);sourceBytes+=size.sourceBytes;evidenceBytes+=size.bytes-size.sourceBytes;}
  if(includeOriginals){
   const intake=this.#measure('codex_prompt_intakes',INTAKE,'WHERE target_thread_id=?',[this.#target]);
   this.scan();const ingress=this.#measure('discord_ingress_journal',INGRESS,`WHERE ${STOP_UNOWNED_MATCH}`,[this.#target],STOP_ACCEPTANCE_MAX_ROWS,false,this.#generatedIngress.size?['outcome_json']:[]);
   rows+=intake.rows+ingress.rows;sourceBytes+=intake.bytes+ingress.sourceBytes;evidenceBytes+=ingress.bytes-ingress.sourceBytes;
   this.#ordinary('cdr_execution_holds');
   const holds=this.#measure('cdr_execution_holds',HOLD,'WHERE job_id IN (SELECT job_id FROM main.codex_turn_queue WHERE target_thread_id=? UNION SELECT job_id FROM main.codex_prompt_intakes WHERE target_thread_id=?)',[this.#target,this.#target],STOP_ACCEPTANCE_MAX_ROWS,false,['evidence_json']);
   evidenceBytes+=holds.bytes+this.revision(false).bytes;
   if(operation!==undefined)evidenceBytes+=this.control(operation,false).bytes;
  }
  if(rows>STOP_ACCEPTANCE_MAX_ROWS)refused('row');
  if(sourceBytes>STOP_ACCEPTANCE_MAX_SOURCE_BYTES||sourceBytes+evidenceBytes>STOP_ACCEPTANCE_MAX_READ_BYTES)refused('cumulative byte');
 }
}
