import type {DatabaseSync} from 'node:sqlite';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {rustTrim, serdeField} from '../app-server/value.ts';
import {parseBusyChoice} from './busy-choice.ts';
import {receiptText, receiptTextColumns} from './delivery-receipt-key.ts';
import {decodeI64} from './sqlite-values.ts';
import {containerI64} from './mirror-container-creation.ts';
import {requireDiscordText} from '../discord/text.ts';
export interface ArchivedCleanupRejection {
  readonly id: string; readonly payload: string; readonly outcome: string;
  readonly actor: bigint; readonly canonical: string; readonly snapshot: string;
}
const CANDIDATES = `SELECT ingress_id,payload_json,outcome_json,owner_user_id,canonical_owner,
 json_object('ingress_id',ingress_id,'version',version,'kind',kind,'event_id',event_id,
 'application_id',application_id,'channel_id',channel_id,'owner_user_id',owner_user_id,
 'source_message_id',source_message_id,'payload_json',payload_json,'runtime_id',runtime_id,
 'state',state,'phase',phase,'target_thread_id',target_thread_id,'canonical_owner',canonical_owner,
 'owner_kind',owner_kind,'owner_id',owner_id,'outcome_json',outcome_json,
 'confirmation_delivered',confirmation_delivered,'hold_reason',hold_reason,'notice_staged',notice_staged,
 'created_at',created_at,'updated_at',updated_at) AS snapshot
 FROM discord_ingress_journal j
 WHERE channel_id=?1 AND target_thread_id=?2 AND kind='interaction' AND state='held'
 AND phase='result_recorded' AND confirmation_delivered=0 AND owner_kind IS NULL AND owner_id IS NULL
 AND outcome_json IS NOT NULL AND canonical_owner IS NOT NULL AND event_id>0
 AND ingress_id='interaction:' || event_id
 AND NOT EXISTS(SELECT 1 FROM discord_ingress_owner_receipts r WHERE r.owner_key=j.canonical_owner)
 ORDER BY ingress_id`;
/** A definite non-dispatch is not notification delivery. This predicate only
 * authorizes the narrow candidate exclusion; it never mutates ingress state. */
export function provesArchivedSteerRejection(row: ArchivedCleanupRejection, channel: bigint, target: string, now: number): boolean {
  let outcome: unknown, payload: unknown;
  try { outcome = parseSerdeValue(row.outcome); payload = parseSerdeValue(row.payload); } catch { return false; }
  if (serdeField(outcome, 'kind') !== 'busy_control_preflight_rejected' || serdeField(outcome, 'control_dispatched') !== false || serdeField(payload, 'busy_action') !== 'steer') return false;
  let choice;
  try { choice = parseBusyChoice(serializeSerdeValue(serdeField(payload, 'busy_choice') ?? null)); } catch { return false; }
  return rustTrim(choice.choiceId) !== '' && row.canonical === `busy-choice:${choice.choiceId}` && row.actor > 0n
    && choice.ownerUserId === row.actor && choice.channelId === channel && choice.targetThreadId === target
    && !choice.allowSteer && Number.isFinite(now) && Number.isFinite(choice.createdAt) && Number.isFinite(choice.expiresAt)
    && choice.expiresAt >= choice.createdAt && choice.expiresAt <= now;
}
/** Borrowed reader. Caller owns a transaction spanning this selection and the
 * pending-work check/fence; no standalone absence or cleanup permission. */
export function eligibleArchivedCleanupIn(db: DatabaseSync, channel: bigint, target: string, now: number): readonly ArchivedCleanupRejection[] {
  containerI64(channel); requireDiscordText(target); if (typeof now !== 'number') throw new TypeError('Expected f64 observation time');
  const fields = ['ingress_id', 'payload_json', 'outcome_json', 'canonical_owner', 'snapshot'];
  const query = db.prepare(`SELECT *,${receiptTextColumns(...fields)} FROM (${CANDIDATES}) ORDER BY ingress_id`);
  query.setReadBigInts(true); const allowed: ArchivedCleanupRejection[] = [];
  for (const row of query.iterate(channel, target)) {
    const id = receiptText(row, 'ingress_id')!, payload = receiptText(row, 'payload_json')!, outcome = receiptText(row, 'outcome_json')!;
    const actor = decodeI64(row.owner_user_id, 'owner_user_id'), canonical = receiptText(row, 'canonical_owner')!, snapshot = receiptText(row, 'snapshot')!;
    const candidate = Object.freeze({id, payload, outcome, actor, canonical, snapshot});
    if (provesArchivedSteerRejection(candidate, channel, target, now)) allowed.push(candidate);
  }
  return Object.freeze(allowed);
}
