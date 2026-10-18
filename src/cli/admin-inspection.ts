import {createHash} from 'node:crypto';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {checkPublicationConsentCompatibility} from '../store/schema-publication-consent.ts';
import {checkAbandonmentCompatibility} from '../store/schema-abandonment.ts';
import {checkAdmissionOrderCompatibility} from '../store/schema-admission-order.ts';
import {LATEST_STORE_SCHEMA_VERSION} from '../store/schema-assembly.ts';
import {REVIEWED_INCIDENT_THREAD} from '../store/async-resolution-policy.ts';
import {inspectLifecycleIntent} from './admin-intent.ts';
const hash=(v:unknown)=>typeof v==='string'?createHash('sha256').update(v).digest('hex'):null;
const table=(db:DatabaseSync,name:string)=>db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name)!==undefined;
function rows(db:DatabaseSync,sql:string,...params:SQLInputValue[]):Record<string,any>[]{const q=db.prepare(sql);q.setReadBigInts(true);return q.all(...params);}
function schema(db:DatabaseSync){const version=rows(db,'PRAGMA user_version')[0]?.user_version;if(version!==LATEST_STORE_SCHEMA_VERSION)throw new Error('Unsupported store schema; no migration attempted');return version;}
export function inspectFirstReply(db:DatabaseSync,job:string){
 const count=(name:string,where:string)=>rows(db,`SELECT count(*) AS n FROM ${name} WHERE ${where}=?`,job)[0]!.n;
 const report:Record<string,unknown>={read_only:true,job_id:job,ingress_count:count('discord_ingress_journal','owner_id'),outbox_count:count('codex_delivery_outbox','job_id'),replay_authorized:false,delivery_authorized:false};
 if(report.ingress_count!==1n||report.outbox_count!==1n)return {...report,reason:'exact ingress/outbox identity is not unique; preserved'};
 const owner=rows(db,'SELECT event_id,channel_id,target_thread_id,CASE WHEN length(CAST(outcome_json AS BLOB))<=131072 THEN outcome_json END AS outcome_json,confirmation_delivered FROM discord_ingress_journal WHERE owner_id=?',job)[0]!;
 const final=rows(db,'SELECT target_thread_id,turn_id,channel_id,CASE WHEN length(CAST(content AS BLOB))<=4194304 THEN content END AS content FROM codex_delivery_outbox WHERE job_id=?',job)[0]!;
 if(final.content===null)throw new Error('Final preview exceeds byte budget');const evidence=parseSerdeValue(owner.outcome_json||'{}') as any,prepared=evidence?.new_verification;
 const mapping=rows(db,'SELECT codex_thread_id FROM mirror_threads WHERE discord_thread_id=? LIMIT 2',final.channel_id);
 const key=serializeSerdeValue([owner.channel_id,'message/reply/v1',`inbound-message/${owner.event_id}/action-result`,0n]);
 const receipt=rows(db,'SELECT message_id,retryable,blocked_reason FROM codex_delivery_receipts WHERE receipt_key=?',key)[0];
 return {...report,thread_id:final.target_thread_id,turn_id:final.turn_id,destination_matches:owner.target_thread_id===final.target_thread_id&&prepared?.thread_id===final.target_thread_id&&prepared?.channel_id===final.channel_id&&mapping.length===1&&mapping[0]!.codex_thread_id===final.target_thread_id,
  normal_ack_receipt:receipt===undefined?'absent':receipt.message_id!==null&&String(receipt.message_id)!=='0'?'confirmed':receipt.blocked_reason?'rejected_blocked':receipt.retryable?'definite_rejection':'unknown',final_sha256:hash(final.content),normal_ack_confirmed_flag:owner.confirmation_delivered!==0n,reason:'Historical non-attempt and current exclusive delivery ownership are not proven by this preview; preserved'};
}
/** Fixed SQL inventory: opaque prompts, seals and evidence are hashed, never
 * printed. Limits describe incompleteness rather than treating it as clearance. */
export function inspectAsyncRecovery(db:DatabaseSync,thread:string){
 const version=schema(db);if(thread.trim()===''||Buffer.byteLength(thread)>512)throw new Error('Invalid bounded thread identity');
 const page=(name:string,key:string,metadata:string,details:readonly string[]=[],where='',order='rowid')=>{
  if(!table(db,name))return {rows:[],truncated:false,row_limit:128,schema_present:false};
  const detailColumns=details.flatMap(field=>[`length(CAST(${field} AS BLOB)) AS ${field}_bytes`,`CASE WHEN length(CAST(${field} AS BLOB))<=131072 THEN ${field} END AS ${field}_hash_input`]);
  const found=rows(db,`SELECT ${metadata}${detailColumns.length?','+detailColumns.join(','):''} FROM ${name} WHERE ${where||key+'=?'} ORDER BY ${order} LIMIT 129`,thread);
  for(const row of found){for(const field of details){row[field+'_sha256']=hash(row[field+'_hash_input']);row[field+'_oversized']=row[field+'_bytes']>131072n;delete row[field+'_hash_input'];}if(Buffer.byteLength(serializeSerdeValue(row))>16384)throw new Error('Recovery metadata exceeds its bound');}
  return {rows:found.slice(0,128),truncated:found.length>128,row_limit:128,schema_present:true};
 };
 const lifecyclePage=(name:string,key:string,metadata:string,detail:string|null=null,where='',order='rowid')=>{
  const result=page(name,key,metadata,detail===null?[]:[detail],where,order);
  const found=result.rows.map(row=>{
   let encoded:string|null=null;
   if(name==='discord_ingress_journal'&&row.payload_json_bytes<=131072n){encoded=rows(db,'SELECT payload_json FROM discord_ingress_journal WHERE ingress_id=?',row.ingress_id)[0]?.payload_json??null;}
   const bytes=detail===null?null:row[detail+'_bytes'],digest=detail===null?null:row[detail+'_sha256'],oversized=detail!==null&&row[detail+'_oversized'];
   if(detail!==null){delete row[detail+'_bytes'];delete row[detail+'_sha256'];delete row[detail+'_oversized'];}
   if(Buffer.byteLength(serializeSerdeValue(row))>4096)row={metadata_oversized:true};
   Object.assign(row,{details_bytes:bytes,details_sha256:digest,details_oversized:oversized});
   if(name==='discord_ingress_journal')row.intent_evidence=inspectLifecycleIntent(row,encoded);
   return row;
  });
  return {...result,rows:found,...(result.schema_present?{metadata_byte_limit:4096,details_byte_limit:131072}:{})};
 };
 const seal=table(db,'cdr_async_questions')&&rows(db,"SELECT name FROM pragma_table_info('cdr_async_questions')").some(r=>r.name==='preparation_json');
 const lifecycle={diagnostic_only:true,state_labels_are_not_authority:true,absence_is_clearance:false,automatic_resume_authorized:false,does_not_confirm_execution_end:true,reviewed_incident_policy_required:thread===REVIEWED_INCIDENT_THREAD,
  mapping:lifecyclePage('mirror_threads','codex_thread_id','codex_thread_id AS thread_id,discord_channel_id AS channel_id,discord_thread_id,(SELECT count(*) FROM mirror_threads other WHERE other.discord_thread_id=mirror_threads.discord_thread_id) AS same_discord_thread_mappings',null,'','codex_thread_id'),
  recovery_policy:lifecyclePage('cdr_async_recovery_policies','thread_id','thread_id,format_version,policy,proposal_sha256,original_turn_id,origin_job_id,pending_job_id',null,'','thread_id'),
  stop_receipts:lifecyclePage('cdr_stop_revision_receipts','target_thread_id','operation_id,target_thread_id AS thread_id,revision','scope_json','','revision,operation_id'),
  stop_controls:lifecyclePage('cdr_stop_controls','target_thread_id','sequence,operation_id,target_thread_id AS thread_id,resident_owner AS resident,generation,turn_id,phase','record_json','','sequence'),
  archive_fences:lifecyclePage('codex_archive_fences','target_thread_id','target_thread_id AS thread_id,operation_id,own_ingress_id,phase',null,'','target_thread_id'),
  execution_holds:lifecyclePage('cdr_execution_holds','target_thread_id','job_id,target_thread_id AS thread_id','evidence_json','','job_id'),
  unresolved_ingress:lifecyclePage('discord_ingress_journal','target_thread_id',"ingress_id,target_thread_id AS thread_id,kind,event_id,source_message_id,target_thread_id IS NULL AS target_is_unbound,state,phase,channel_id,owner_user_id,owner_kind,owner_id,confirmation_delivered,CASE WHEN json_valid(payload_json) THEN CASE WHEN json_type(payload_json,'$.plan.Execute.Stop')='object' THEN 'Stop' WHEN json_type(payload_json,'$.plan.Execute.Archive')='object' THEN 'Archive' ELSE 'unknown_or_other' END ELSE 'unknown_or_other' END AS declared_action",'payload_json',"(target_thread_id=? OR target_thread_id IS NULL) AND state!='completed' AND NOT(state='owned' AND confirmation_delivered=1)",'created_at,ingress_id')};
 const questions=page('cdr_async_questions','thread_id','id,runtime_id,generation,turn_id,item_id,origin_job_id,channel_id,owner_user_id,state,chosen,dispatch_mode,reply_job_id,accepted_turn_id',seal?['preparation_json']:[],'','id');
 for(const row of questions.rows){row.seal_bytes=row.preparation_json_bytes??null;row.seal_sha256=row.preparation_json_sha256??null;row.seal_oversized=row.preparation_json_oversized??false;delete row.preparation_json_bytes;delete row.preparation_json_sha256;delete row.preparation_json_oversized;}
 const obligations=page('cdr_async_execution_obligations','thread_id','question_id,origin_job_id,turn_id,format_version,revision,answer_state,execution_state,admission_state,policy',['claim_json','terminal_proof_json'],'','question_id');
 for(const row of obligations.rows){row.claim_bytes=row.claim_json_bytes;row.claim_sha256=row.claim_json_sha256;row.terminal_evidence_bytes=row.terminal_proof_json_bytes;row.terminal_evidence_sha256=row.terminal_proof_json_sha256;row.evidence_oversized=row.claim_json_oversized||row.terminal_proof_json_oversized;row.state_labels_are_not_authority=true;for(const key of ['claim_json','terminal_proof_json'])for(const suffix of ['_bytes','_sha256','_oversized'])delete row[key+suffix];}
 const jobs=page('codex_turn_queue','target_thread_id','job_id,state,app_server_generation,execution_generation,turn_observation_generation,goal_waiting,attempt_count,turn_id,channel_id,owner_user_id,discord_message_id,created_at,updated_at',['prompt'],'','created_at,job_id');
 for(const row of jobs.rows){row.goal_waiting=row.goal_waiting!==0n;for(const key of ['created_at','updated_at']){const bytes=Buffer.alloc(8);bytes.writeDoubleLE(Number(row[key]));row[key+'_bits']=bytes.readBigUInt64LE();delete row[key];}}
 return {protocol:'cdr-async-recovery-inspection-v1',read_only:true,thread_id:thread,schema_version:version,
  questions_schema_present:table(db,'cdr_async_questions'),ledger_schema_present:table(db,'cdr_async_execution_obligations'),queue_schema_present:table(db,'codex_turn_queue'),
  questions,obligations,jobs,lifecycle_evidence:lifecycle,
  execution_authorized:false,receipt_apply_authorized:false,publication_authorized:false,requires_evidence_review:true,reason:'Inventory only; no replay or execution authority. Truncated or oversized evidence is incomplete.'};
}
export function inspectCompatibility(db:DatabaseSync){
 const version=schema(db),requirements:Record<string,bigint>={async_resolution:0n,async_recovery_policy:0n,recovery_publication_consent:0n,recovery_abandonment:0n,recovery_admission_order:0n};
 const registry=table(db,'cdr_runtime_capability_requirements');
 if(registry){const required=rows(db,'SELECT component,format_version FROM cdr_runtime_capability_requirements ORDER BY component LIMIT 65');if(required.length>64)throw new Error('Capability requirements exceed bound');for(const row of required){if(!Object.hasOwn(requirements,row.component)||row.format_version!==1n)throw new Error('Persisted capability is not supported');requirements[row.component]=row.format_version;}}
 const ledger=table(db,'cdr_async_execution_obligations'),policies=table(db,'cdr_async_recovery_policies');
 if(requirements.async_resolution!>0n&&!ledger||requirements.async_recovery_policy!>0n&&!policies)throw new Error('Required recovery ledger is missing');
 if(policies&&(requirements.async_recovery_policy===0n||rows(db,'SELECT 1 FROM cdr_async_recovery_policies WHERE format_version<1 OR format_version>? LIMIT 1',requirements.async_recovery_policy!).length))throw new Error('Recovery policy exceeds persisted capability');
 if(ledger){const r=rows(db,'SELECT count(*) AS n,min(format_version) AS lo,max(format_version) AS hi FROM cdr_async_execution_obligations')[0]!;if(r.n>0n&&(!registry||requirements.async_resolution===0n)||r.lo!==null&&(r.lo<1n||r.hi>requirements.async_resolution!))throw new Error('Execution evidence exceeds persisted capability');}
 checkPublicationConsentCompatibility(db,requirements.recovery_publication_consent!);checkAbandonmentCompatibility(db,requirements.recovery_abandonment!);checkAdmissionOrderCompatibility(db,requirements.recovery_admission_order!);
 return {protocol:'cdr-recovery-compatibility-v1',read_only:true,compatible:true,store_schema:version,required_formats:requirements,supported_formats:Object.fromEntries(Object.keys(requirements).map(k=>[k,1n])),special_dispatch_supported:false,new_requests_release_supported:false,abandonment_apply_supported:false,admission_authorized:false,recovery_authorized:false,note:'Format compatibility only; maintain deployment exclusion through launch'};
}
