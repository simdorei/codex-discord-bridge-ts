import type {DatabaseSync} from 'node:sqlite';
import {realpathSync} from 'node:fs';
import {selectJob} from './queue-read.ts';
import {asyncResolutionHeldIn} from './async-resolution-admission.ts';
import {captureStopOriginIn} from './stop-revision-read.ts';
import {ActiveTransactionError} from './owned-driver.ts';
import {AbandonmentIntegrityError} from './schema-abandonment.ts';
import {AbandonmentRowMissingError,readAbandonmentRuntimeIn,verifyAbandonmentMessageIn,type AbandonmentTarget} from './abandonment-identity.ts';
import {captureSqliteEvidenceRows,type EvidenceFailure} from './sqlite-evidence-rows.ts';
import {receiptRow,receiptExists} from './delivery-receipt-key.ts';
import {decodeI64} from './sqlite-values.ts';
import {rustTrim} from '../app-server/value.ts';
import {requireDiscordText} from '../discord/text.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
const MAX_BYTES=393216;
const invalid=(reason:string):never=>{throw new AbandonmentIntegrityError(reason);};
const reasons:Record<EvidenceFailure,string>={column:'invalid evidence column',page:'private evidence page exceeds bound',cell:'private evidence cell exceeds bound',encoding:'non-UTF8 evidence',blob:'private evidence blob exceeds bound',budget:'private evidence exceeds bound'};
const profile={maxBytes:MAX_BYTES,maxRows:128,reject:(failure:EvidenceFailure):never=>invalid(reasons[failure])};
const queries=[
  [
    "siblings",
    "SELECT * FROM codex_turn_queue WHERE target_thread_id=?1 AND job_id!=?2 ORDER BY created_at,job_id LIMIT 129"
  ],
  [
    "mapping",
    "SELECT * FROM mirror_threads WHERE codex_thread_id=?1 OR discord_thread_id=?3 ORDER BY codex_thread_id LIMIT 3"
  ],
  [
    "obligations",
    "SELECT * FROM cdr_async_execution_obligations WHERE thread_id=?1 ORDER BY question_id LIMIT 129"
  ],
  [
    "questions",
    "SELECT * FROM cdr_async_questions WHERE thread_id=?1 ORDER BY id LIMIT 129"
  ],
  [
    "settlements",
    "SELECT * FROM cdr_async_terminal_settlements WHERE question_id IN\n            (SELECT question_id FROM cdr_async_execution_obligations WHERE thread_id=?1) ORDER BY question_id LIMIT 129"
  ],
  [
    "handoffs",
    "SELECT * FROM cdr_async_execution_handoffs WHERE question_id IN\n            (SELECT question_id FROM cdr_async_execution_obligations WHERE thread_id=?1) ORDER BY question_id,revision LIMIT 129"
  ],
  [
    "terminal_candidates",
    "SELECT * FROM cdr_async_terminal_candidates WHERE question_id IN\n            (SELECT question_id FROM cdr_async_execution_obligations WHERE thread_id=?1) ORDER BY question_id,revision,kind,evidence_sha256 LIMIT 129"
  ],
  [
    "policy",
    "SELECT * FROM cdr_async_recovery_policies WHERE thread_id=?1 LIMIT 2"
  ],
  [
    "intakes",
    "SELECT * FROM codex_prompt_intakes WHERE target_thread_id=?1 ORDER BY rowid LIMIT 129"
  ],
  [
    "stop_controls",
    "SELECT * FROM cdr_stop_controls WHERE target_thread_id=?1 ORDER BY sequence LIMIT 129"
  ],
  [
    "archive",
    "SELECT * FROM codex_archive_fences WHERE target_thread_id=?1 LIMIT 2"
  ],
  [
    "cleanup",
    "SELECT * FROM cdr_cleanup_fences WHERE target_thread_id=?1 OR channel_id=?3 ORDER BY channel_id LIMIT 129"
  ],
  [
    "dead_generation",
    "SELECT * FROM codex_dead_generation_holds WHERE target_thread_id=?1 ORDER BY rowid LIMIT 129"
  ],
  [
    "execution_holds",
    "SELECT * FROM cdr_execution_holds WHERE target_thread_id=?1 ORDER BY job_id LIMIT 129"
  ],
  [
    "other_cancellations",
    "SELECT * FROM codex_request_cancellations WHERE target_thread_id=?1 AND job_id!=?2 ORDER BY job_id LIMIT 129"
  ],
  [
    "prepared_wire",
    "SELECT * FROM codex_mutation_attempts WHERE state='prepared' AND (scoped=0 OR target_thread_id=?1) ORDER BY sequence LIMIT 129"
  ]
] as const;

function databaseIdentity(path:string):string {
  let raw:Buffer;try{raw=realpathSync(path,{encoding:'buffer'});}catch{return invalid('database identity is unavailable');}
  try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);}catch{return invalid('database identity is not UTF-8');}
}
export interface AbandonmentSnapshot {readonly target:AbandonmentTarget;readonly evidence:unknown}
/** Captures private evidence within a borrowed caller transaction. No abandonment
 * decision, terminal-state certification or dispatch authority is created. */
export function captureAbandonmentSnapshotIn(db:DatabaseSync,path:string,jobId:string,source:string,creating:boolean):AbandonmentSnapshot {
  for(const text of [path,jobId,source])requireDiscordText(text);
  if(typeof creating!=='boolean')throw new TypeError('Expected creating flag');
  if(!db.isTransaction)throw new ActiveTransactionError();
  const length=receiptRow(db,'SELECT length(CAST(prompt AS BLOB)) AS n FROM codex_turn_queue WHERE job_id=?',jobId);
  if(length===undefined)throw new AbandonmentRowMissingError();
  if(decodeI64(length.n,'original prompt bytes')>131072n)return invalid('original input exceeds private evidence bound');
  const job=selectJob(db,jobId),owner=job.ownerUserId;
  if(owner===null||owner<=0n)return invalid('original request owner is missing');
  if(job.state!=='Pending'||job.turnId!==null||job.goalWaiting||job.discordMessageId===null||job.discordMessageId<=0n
    ||job.appServerGeneration<1n||job.channelId<=0n||rustTrim(job.targetThreadId)===''||!asyncResolutionHeldIn(db,job.targetThreadId))
    return invalid('request is not an original owned, held, unstarted Pending job');
  const target={job:jobId,thread:job.targetThreadId,owner,channel:job.channelId};
  const mapped=receiptExists(db,'SELECT count(*)=1 AND MAX(codex_thread_id=?1 AND discord_thread_id=?2) AS held FROM mirror_threads WHERE codex_thread_id=?1 OR discord_thread_id=?2',target.thread,target.channel);
  const unresolved=receiptExists(db,`SELECT EXISTS(SELECT 1 FROM codex_mutation_attempts WHERE state='prepared' AND (scoped=0 OR target_thread_id=?1))
    OR EXISTS(SELECT 1 FROM codex_request_cancellations WHERE job_id=?2 OR discord_message_id=?3) AS held`,target.thread,jobId,job.discordMessageId);
  if(!mapped||unresolved)return invalid('mapping or unresolved wire/cancellation authority changed');
  const budget={bytes:0},row=captureSqliteEvidenceRows(db,'SELECT * FROM codex_turn_queue WHERE job_id=?',[jobId],budget,profile),context:Record<string,unknown>={};
  for(const [key,sql] of queries){
    // Fixed source queries use numbered SQLite parameters, including the unused
    // ?2 slot when ?3 is present. Preserve that slot rather than rebinding it.
    const args=sql.includes('?3')?[target.thread,target.job,target.channel]:sql.includes('?2')?[target.thread,target.job]:[target.thread];
    context[key]=captureSqliteEvidenceRows(db,sql,args,budget,profile);
  }
  context.capabilities=captureSqliteEvidenceRows(db,'SELECT * FROM cdr_runtime_capability_requirements ORDER BY component LIMIT 129',[],budget,profile);
  context.stop_origin=captureStopOriginIn(db,target.thread);
  context.runtime=readAbandonmentRuntimeIn(db);
  context.source=verifyAbandonmentMessageIn(db,target,source,creating);
  context.database=databaseIdentity(path);
  const evidence={job:row,context};
  if(Buffer.byteLength(serializeSerdeValue(evidence),'utf8')>MAX_BYTES)return invalid('private snapshot exceeds bound');
  return Object.freeze({target:Object.freeze(target),evidence:cloneOwnedSerdeValue(evidence)});
}
