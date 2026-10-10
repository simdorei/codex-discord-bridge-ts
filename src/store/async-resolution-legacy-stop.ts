import type {DatabaseSync} from 'node:sqlite';
import {asU64,getOwn} from './async-resolution-json-helpers.ts';
import {serdeValueEqual} from '../core/serde-value-equal.ts';
import {checkAdmissionOrderCompatibility} from './schema-admission-order.ts';
import {decodeI64} from './sqlite-values.ts';
import {requireDiscordText} from '../discord/text.ts';

const SQL=`SELECT EXISTS(
         SELECT 1 FROM discord_ingress_journal old
         JOIN cdr_recovery_ingress_order prior ON prior.ingress_id=old.ingress_id
             AND prior.kind=old.kind AND prior.event_id=old.event_id AND prior.origin='legacy'
         JOIN discord_ingress_journal input ON input.target_thread_id=old.target_thread_id
             AND input.channel_id=old.channel_id AND input.owner_user_id=old.owner_user_id
             AND input.kind='message' AND input.event_id=input.source_message_id
             AND input.state='owned' AND input.owner_kind='prompt'
         JOIN cdr_recovery_ingress_order newer ON newer.ingress_id=input.ingress_id
             AND newer.kind=input.kind AND newer.event_id=input.event_id
             AND newer.origin='admitted' AND newer.sequence>prior.sequence
         JOIN cdr_async_execution_obligations o ON o.origin_job_id=input.owner_id
             AND o.thread_id=input.target_thread_id AND o.channel_id=input.channel_id
         JOIN cdr_async_terminal_settlements s ON s.question_id=o.question_id
             AND s.revision=o.revision AND s.proof_json=o.terminal_proof_json
         WHERE old.ingress_id=?1 AND old.target_thread_id=?2
             AND old.kind='message' AND old.event_id=old.source_message_id
             AND o.format_version=1 AND o.policy='ordinary'
             AND o.execution_state='terminal' AND o.admission_state='settled'
             AND json_extract(s.proof_json,'$.canonical_terminal.turn.status')='completed'
             AND json_extract(o.original_seal,'$.identity.job.job_id')=o.origin_job_id
             AND json_extract(o.original_seal,'$.identity.job.target_thread_id')=o.thread_id
             AND json_extract(o.original_seal,'$.identity.job.turn_id')=o.turn_id
             AND json_extract(o.original_seal,'$.identity.job.channel_id')=input.channel_id
             AND json_extract(o.original_seal,'$.identity.job.owner_user_id')=input.owner_user_id
             AND json_extract(o.original_seal,'$.identity.job.discord_message_id')=input.event_id
             AND json_extract(o.original_seal,'$.identity.job.state')='Running'
             AND json_extract(o.original_seal,'$.identity.job.attempt_count')>0) AS witnessed`;
/** User-required normal-completion restriction supplements Rust dfec7df: a
 * certified failed/interrupted terminal must not supersede the old Stop.
 * Read-only exception for exact unbound legacy Stop. No record deletion,
 * requeue, acknowledgement or release of an individual execution hold. */
export function legacyStopSupersededIn(db:DatabaseSync,thread:string,ingress:string,payload:unknown):boolean{
 requireDiscordText(thread);requireDiscordText(ingress);
 if(asU64(getOwn(payload,'version'))!==1n||!serdeValueEqual(getOwn(payload,'plan'),{Execute:{Stop:{reference:null}}})||
   ['lifecycle_binding','stop_origin','work','command'].some(k=>{const v=getOwn(payload,k);return v!==undefined&&v!==null;}))return false;
 const probe=db.prepare("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?) AS present");probe.setReadBigInts(true);
 if(decodeI64(probe.get('cdr_recovery_ingress_order')?.present,'present')===0n)return false;
 checkAdmissionOrderCompatibility(db,1n);
 const query=db.prepare(SQL);query.setReadBigInts(true);
 return decodeI64(query.get(ingress,thread)?.witnessed,'legacy stop witness')!==0n;
}
