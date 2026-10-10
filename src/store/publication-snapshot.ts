import type {DatabaseSync} from 'node:sqlite';
import {selectJob} from './queue-read.ts';
import {captureStopOriginIn} from './stop-revision-read.ts';
import {ActiveTransactionError} from './owned-driver.ts';
import {PublicationConsentIntegrityError} from './schema-publication-consent.ts';
import {decodeI64} from './sqlite-values.ts';
import {captureSqliteEvidenceRows, type EvidenceFailure} from './sqlite-evidence-rows.ts';
import {rustTrim} from '../app-server/value.ts';
import {requireDiscordText} from '../discord/text.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
const MAX_BYTES = 262144;
const reasons: Record<EvidenceFailure,string> = {column:'invalid evidence column',page:'local evidence page exceeds bound',cell:'evidence cell exceeds bound',encoding:'non-UTF8 evidence',blob:'evidence blob exceeds bound',budget:'local evidence exceeds review bound'};
const evidenceProfile={maxBytes:MAX_BYTES,maxRows:128,reject:(failure:EvidenceFailure):never=>invalid(reasons[failure])};
const invalid = (reason: string): never => {throw new PublicationConsentIntegrityError(reason);};
export class PublicationRowMissingError extends Error {readonly kind = 'QueryReturnedNoRows'; constructor() {super('Query returned no rows'); this.name = 'PublicationRowMissingError';}}
export interface PublicationSnapshot {readonly thread: string; readonly owner: bigint; readonly channel: bigint; readonly seal: unknown}
const queries = [
  ['queue','SELECT * FROM codex_turn_queue WHERE target_thread_id=? ORDER BY created_at,job_id LIMIT 129'],
  ['mapping','SELECT * FROM mirror_threads WHERE codex_thread_id=? LIMIT 2'],
  ['obligations','SELECT * FROM cdr_async_execution_obligations WHERE thread_id=? ORDER BY question_id LIMIT 129'],
  ['settlements','SELECT * FROM cdr_async_terminal_settlements WHERE question_id IN (SELECT question_id FROM cdr_async_execution_obligations WHERE thread_id=?) ORDER BY question_id LIMIT 129'],
  ['handoffs','SELECT * FROM cdr_async_execution_handoffs WHERE question_id IN (SELECT question_id FROM cdr_async_execution_obligations WHERE thread_id=?) ORDER BY question_id,revision LIMIT 129'],
  ['policy','SELECT * FROM cdr_async_recovery_policies WHERE thread_id=? LIMIT 2'],
] as const;
/** Borrowed active transaction only. This immutable local snapshot is evidence,
 * not proof of terminal state, publication exclusion or permission to dispatch. */
export function capturePublicationSnapshotIn(db: DatabaseSync, jobId: string): PublicationSnapshot {
  requireDiscordText(jobId);if(!db.isTransaction)throw new ActiveTransactionError();
  const length=db.prepare('SELECT length(CAST(prompt AS BLOB)) AS n FROM codex_turn_queue WHERE job_id=?');length.setReadBigInts(true);const row=length.get(jobId);if(row===undefined)throw new PublicationRowMissingError();
  if(decodeI64(row.n,'pending prompt bytes')>131072n)return invalid('pending input exceeds review bound');
  const job=selectJob(db,jobId),owner=job.ownerUserId;
  if(owner===null||owner<=0n)return invalid('pending has no exact original owner');
  if(job.state!=='Pending'||job.channelId<=0n||job.appServerGeneration<1n||rustTrim(job.targetThreadId)==='')return invalid('proposal does not name an owned Pending job');
  const mapping=db.prepare('SELECT count(*)=1 AND MAX(codex_thread_id=?1 AND discord_thread_id=?2) AS mapped FROM mirror_threads WHERE codex_thread_id=?1 OR discord_thread_id=?2');mapping.setReadBigInts(true);
  if(decodeI64(mapping.get(job.targetThreadId,job.channelId)?.mapped,'pending mapping')===0n)return invalid('pending mapping is missing or ambiguous');
  const stop=captureStopOriginIn(db,job.targetThreadId),budget={bytes:0},seal:Record<string,unknown>={};
  for(const [key,sql] of queries)seal[key]=captureSqliteEvidenceRows(db,sql,[job.targetThreadId],budget,evidenceProfile);
  seal.stop_origin=stop;if(Buffer.byteLength(serializeSerdeValue(seal),'utf8')>MAX_BYTES)return invalid('local evidence exceeds review bound');
  return Object.freeze({thread:job.targetThreadId,owner,channel:job.channelId,seal:cloneOwnedSerdeValue(seal)});
}
