import type {DatabaseSync, SQLInputValue} from 'node:sqlite';
import {requireDiscordText} from '../discord/text.ts';
import {usingExistingReadOnlyStore, withStoreTransaction, rollbackStore} from './owned-scope.ts';
import {schemaVersion, schemaExtensionsCurrent, LATEST_STORE_SCHEMA_VERSION, StoreIntegrityError} from './schema-assembly.ts';
import {ReadOnlySchemaVersionError, ingressRowsIn, type StoredIngress} from './ingress-read.ts';
import {allJobs, type StoredQueueJob} from './queue-read.ts';
import {listPromptIntakesIn, type StoredPromptIntake} from './prompt-intake.ts';
import {listPendingDeliveriesIn} from './delivery.ts';
import {runnerTargetCountsIn} from './runner-target-counts.ts';
import {reasonIn} from './execution-hold.ts';
import {decodeI64, textDecoderFor} from './sqlite-values.ts';

const MAX_ROWS = 10_000, MAX_IDENTIFIER_BYTES = 16 * 1024, MAX_PATH_BYTES = 32 * 1024;
const MAX_ROW_BYTES = 1024 * 1024, MAX_TOTAL_BYTES = 4 * 1024 * 1024;
type Storage = 'text' | 'integer' | 'number';
interface Column {readonly name:string; readonly storage:Storage; readonly optional:boolean; readonly identifier:boolean;}
interface Budget {rows:number; bytes:number;}
const text = (name:string, optional=false, identifier=false):Column => ({name, storage:'text', optional, identifier});
const integer = (name:string, optional=false):Column => ({name, storage:'integer', optional, identifier:false});
const timestamp = (name:string):Column => ({name, storage:'number', optional:false, identifier:false});
const id = (name:string, optional=false):Column => text(name, optional, true);
const INGRESS = [id('ingress_id'),id('kind'),integer('event_id',true),integer('application_id',true),integer('channel_id'),integer('owner_user_id'),integer('source_message_id',true),text('payload_json'),id('runtime_id',true),id('state'),id('phase'),id('target_thread_id',true),id('canonical_owner',true),id('owner_kind',true),id('owner_id',true),text('outcome_json',true),integer('confirmation_delivered'),text('hold_reason'),timestamp('created_at'),timestamp('updated_at')];
const QUEUE = [id('job_id'),id('target_thread_id'),integer('channel_id'),integer('owner_user_id',true),integer('discord_message_id',true),integer('app_server_generation'),integer('execution_generation',true),text('prompt'),integer('queued'),integer('ack_sent'),id('state'),integer('attempt_count'),id('turn_id',true),text('baseline_turn_ids'),text('last_error'),timestamp('created_at'),timestamp('updated_at'),integer('goal_waiting'),integer('turn_observation_generation',true)];
const INTAKE = [id('job_id'),id('target_thread_id'),integer('channel_id'),integer('owner_user_id',true),integer('discord_message_id',true),text('raw_prompt'),integer('auto_queue_when_busy'),integer('require_current_mirror'),integer('attempt_count'),text('last_error'),timestamp('retry_after'),id('claim_token',true),timestamp('claim_expires_at'),timestamp('created_at'),timestamp('updated_at')];
const DELIVERY = [id('delivery_id'),id('job_id'),id('target_thread_id'),id('turn_id'),integer('channel_id'),text('content'),integer('attempt_count'),text('last_error'),timestamp('created_at'),timestamp('updated_at')];
const HOLD = [id('job_id'),text('reason')];
const SUMMARY_SCOPE = "WHERE channel_id=? AND owner_user_id=? AND (state='held' OR (state='completed' AND confirmation_delivered=0)) ORDER BY created_at DESC,ingress_id LIMIT 20";
const DETAIL_SCOPE = 'WHERE ingress_id=? AND channel_id=? AND owner_user_id=?';
const HOLD_SCOPE = 'WHERE job_id IN (SELECT job_id FROM codex_turn_queue UNION SELECT job_id FROM codex_prompt_intakes)';

export interface RunnerInspectionGlobalSnapshot {
 readonly jobs:readonly StoredQueueJob[];
 readonly pending:bigint;
 readonly unknown:bigint;
 readonly blocked:bigint;
 readonly intakes:readonly StoredPromptIntake[];
 readonly held:readonly string[];
}

function inputText(value:string):void {
 requireDiscordText(value);
 if(Buffer.byteLength(value,'utf8')>MAX_IDENTIFIER_BYTES)throw new RangeError('Runner inspection identifier byte budget exceeded');
}
function identity(value:bigint):void {
 if(typeof value!=='bigint'||value<-(1n<<63n)||value>=(1n<<63n))throw new TypeError('Expected i64 runner inspection identity');
}
function query(db:DatabaseSync,sql:string,parameters:readonly SQLInputValue[]=[]):Record<string,unknown>|undefined {
 const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.get(...parameters);
}
function source(table:string,columns:readonly Column[],scope:string):string {
 return `SELECT ${columns.map(c=>c.name).join(',')} FROM ${table} ${scope}`;
}
/** SQL returns only fixed-size scalar evidence here. In particular a BLOB in a
 * numeric column cannot make it into Node before its storage class is rejected.
 * UTF-16 is conservatively charged at twice its stored bytes, bounding its
 * UTF-8 conversion too. These budgets bound native result conversion, not
 * SQLite's internal query/sort work; the owning worker supplies the deadline. */
function preflight(db:DatabaseSync,table:string,columns:readonly Column[],scope:string,parameters:readonly SQLInputValue[],budget:Budget,encoding:unknown):number {
 const multiplier=encoding==='UTF-8'?1:2;
 const bytes=(c:Column)=>`CASE typeof(${c.name}) WHEN 'null' THEN 0 WHEN 'text' THEN ${multiplier}*length(CAST(${c.name} AS BLOB)) WHEN 'blob' THEN length(${c.name}) ELSE 8 END`;
 const valid=(c:Column)=>`typeof(${c.name}) IN (${(c.storage==='number'?['integer','real']:[c.storage]).concat(c.optional?['null']:[]).map(t=>`'${t}'`).join(',')})`;
 const identifiers=columns.filter(c=>c.identifier).map(bytes);
 const q=query(db,`SELECT COUNT(*) AS n,COALESCE(SUM(row_bytes),0) AS bytes,COALESCE(MAX(row_bytes),0) AS largest,COALESCE(MAX(invalid),0) AS invalid,COALESCE(MAX(identifier_bytes),0) AS identifier_bytes FROM (
  SELECT ${columns.map(bytes).join('+')} AS row_bytes,CASE WHEN ${columns.map(valid).join(' AND ')} THEN 0 ELSE 1 END AS invalid,
  ${identifiers.length===0?'0':`max(0,${identifiers.join(',')})`} AS identifier_bytes FROM (${source(table,columns,scope)}) LIMIT ${MAX_ROWS-budget.rows+1})`,parameters);
 const n=decodeI64(q?.n,'row count'),size=decodeI64(q?.bytes,'row bytes');
 if(n>BigInt(MAX_ROWS-budget.rows))throw new RangeError('Runner inspection row budget exceeded');
 if(decodeI64(q?.invalid,'storage class')!==0n)throw new StoreIntegrityError('Invalid runner inspection SQLite storage class');
 if(decodeI64(q?.identifier_bytes,'identifier bytes')>BigInt(MAX_IDENTIFIER_BYTES))throw new RangeError('Runner inspection identifier byte budget exceeded');
 if(decodeI64(q?.largest,'largest row')>BigInt(MAX_ROW_BYTES))throw new RangeError('Runner inspection row byte budget exceeded');
 if(size>BigInt(MAX_TOTAL_BYTES-budget.bytes))throw new RangeError('Runner inspection cumulative byte budget exceeded');
 budget.rows+=Number(n);budget.bytes+=Number(size);return Number(n);
}
function snapshot<T>(path:string,work:(db:DatabaseSync,encoding:unknown)=>T):T {
 requireDiscordText(path);if(path.includes('\0'))throw new TypeError('Invalid SQLite path');
 if(Buffer.byteLength(path,'utf8')>MAX_PATH_BYTES)throw new RangeError('Runner inspection path byte budget exceeded');
 return usingExistingReadOnlyStore(path,db=>withStoreTransaction(db,'DEFERRED',()=>{
  const encoding=db.prepare('PRAGMA encoding').get()?.encoding;textDecoderFor(encoding);
  // Do not use CheckedRead's unbounded catalog JSON aggregation. Bound the
  // existing catalog before the shared read-only schema validators inspect it.
  preflight(db,'sqlite_schema',[id('type'),id('name'),id('tbl_name'),integer('rootpage'),text('sql',true)],'',[],{rows:0,bytes:0},encoding);
  const version=schemaVersion(db);
  if(version!==LATEST_STORE_SCHEMA_VERSION)throw new ReadOnlySchemaVersionError(version,LATEST_STORE_SCHEMA_VERSION);
  // A volatile view could change its values between preflight and decoding,
  // even within one read snapshot. Only ordinary main tables are supported.
  const ordinary=query(db,`SELECT COUNT(*) AS n FROM pragma_table_list WHERE schema='main' AND type='table' AND name IN
   ('discord_ingress_journal','codex_turn_queue','codex_prompt_intakes','codex_delivery_outbox','cdr_execution_holds','codex_delivery_receipts')`);
  if(decodeI64(ordinary?.n,'ordinary tables')!==6n)throw new StoreIntegrityError('Runner inspection requires ordinary main tables');
  if(!schemaExtensionsCurrent(db))throw new StoreIntegrityError('Runner inspection requires an initialized current schema; no repair attempted');
  return rollbackStore(work(db,encoding));
 }));
}
/** Existing-only worker leaf; caller must isolate synchronous SQLite work. */
export function runnerInspectionDetailExisting(path:string,requestId:string,channel:bigint,user:bigint):StoredIngress|null {
 inputText(requestId);identity(channel);identity(user);
 return snapshot(path,(db,encoding)=>{
  const parameters=[requestId,channel,user];preflight(db,'discord_ingress_journal',INGRESS,DETAIL_SCOPE,parameters,{rows:0,bytes:0},encoding);
  return ingressRowsIn(db,' '+DETAIL_SCOPE,...parameters)[0]??null;
 });
}
export function runnerInspectionSummaryExisting(path:string,channel:bigint,user:bigint):readonly StoredIngress[] {
 identity(channel);identity(user);
 return snapshot(path,(db,encoding)=>{
  const parameters=[channel,user];preflight(db,'discord_ingress_journal',INGRESS,SUMMARY_SCOPE,parameters,{rows:0,bytes:0},encoding);
  return ingressRowsIn(db,' '+SUMMARY_SCOPE,...parameters);
 });
}
/** Exactly the original seven SQL counters, including SQL NULL behavior and
 * literal quarantined rows. Counter-only reads do not decode unrelated payloads. */
export function runnerInspectionTargetCountsExisting(path:string,target:string):readonly bigint[] {
 inputText(target);return snapshot(path,db=>runnerTargetCountsIn(db,target));
}
/** One bounded, existing-only readonly snapshot. Full records are decoded after
 * all data preflights, preserving malformed queue/intake/delivery/hold failures.
 * No initialization, migration, repair, claims, network or recovery actions. */
export function runnerInspectionGlobalExisting(path:string):RunnerInspectionGlobalSnapshot {
 return snapshot(path,(db,encoding)=>{
  const budget={rows:0,bytes:0};
  preflight(db,'codex_turn_queue',QUEUE,'',[],budget,encoding);
  preflight(db,'codex_delivery_outbox',DELIVERY,'',[],budget,encoding);
  preflight(db,'codex_prompt_intakes',INTAKE,'',[],budget,encoding);
  preflight(db,'cdr_execution_holds',HOLD,HOLD_SCOPE,[],budget,encoding);
  const jobs=allJobs(db),pending=BigInt(listPendingDeliveriesIn(db).length);
  const receiptCounts=query(db,`SELECT
   (SELECT COUNT(*) FROM codex_delivery_receipts WHERE message_id IS NULL AND retryable=0 AND blocked_reason IS NULL) AS unknown,
   (SELECT COUNT(*) FROM codex_delivery_receipts WHERE message_id IS NULL AND blocked_reason IS NOT NULL) AS blocked`);
  const unknown=decodeI64(receiptCounts?.unknown,'count'),blocked=decodeI64(receiptCounts?.blocked,'count');
  const intakes=listPromptIntakesIn(db,null),held:string[]=[],seen=new Set<string>();
  for(const job of [...jobs,...intakes]){
   const reason=reasonIn(db,job.jobId);if(reason!==null){const line=`${job.jobId}: ${reason}`;if(!seen.has(line)){seen.add(line);held.push(line);}}
  }
  return {jobs,pending,unknown,blocked,intakes,held};
 });
}
