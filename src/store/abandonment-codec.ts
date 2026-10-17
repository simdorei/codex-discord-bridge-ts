import {parseSerdeField, type StructShape, type StructFieldDecoder} from '../core/serde-struct-json.ts';
import {strictSerdeStruct} from '../core/strict-serde-struct.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import type {PublicationProposal} from './publication-codec.ts';

/** The pinned Rust abandonment and publication Proposal declarations have the
 * same value fields. Neither this value nor a decoded receipt grants execution. */
export type AbandonmentProposal = PublicationProposal;
export type AbandonmentDecision = 'AbandonOnly' | 'KeepHeld';
export interface StoredAbandonmentProposal {
  readonly version: bigint; readonly proposal: AbandonmentProposal;
  readonly source_ingress: string; readonly snapshot: unknown;
}
export interface AbandonmentDecisionReceipt {
  readonly proposal_id: string; readonly revision: bigint; readonly job_id: string; readonly thread_id: string;
  readonly ingress_id: string; readonly interaction_id: bigint; readonly decision: AbandonmentDecision; readonly recorded_at_bits: bigint;
}
const proposalShape: StructShape = {fields: [
  ['id','string'],['revision','i64'],['job_id','string'],['thread_id','string'],['owner_user_id','i64'],
  ['channel_id','i64'],['application_id','i64'],['created_at_bits','u64'],['expires_at_bits','u64'],['review_text','string'],['review_sha256','string'],
]};
const decision: StructFieldDecoder = (raw, _depth, context): AbandonmentDecision => {
  let value: unknown;
  if (raw.trimStart().startsWith('"')) value = context.decode('string');
  else {
    let entries = 0;
    context.map((key, decode) => {
      if (++entries !== 1 || decode('value') !== null) throw new SyntaxError('Expected one unit enum variant');
      value = key;
    });
    if (entries !== 1) throw new SyntaxError('Expected one unit enum variant');
  }
  if (value !== 'AbandonOnly' && value !== 'KeepHeld') throw new SyntaxError('Unknown abandonment decision');
  return value;
};
const receiptShape: StructShape = {fields: [
  ['proposal_id','string'],['revision','i64'],['job_id','string'],['thread_id','string'],['ingress_id','string'],
  ['interaction_id','i64'],['decision',decision],['recorded_at_bits','u64'],
]};
const storedShape: StructShape = {fields: [
  ['version','i64'],['proposal',strictSerdeStruct(proposalShape)],['source_ingress','string'],['snapshot','value'],
]};
export function parseStoredAbandonmentProposal(raw: string): StoredAbandonmentProposal {
  return cloneOwnedSerdeValue(parseSerdeField(raw,strictSerdeStruct(storedShape))) as StoredAbandonmentProposal;
}
export function parseAbandonmentDecisionReceipt(raw: string): AbandonmentDecisionReceipt {
  return cloneOwnedSerdeValue(parseSerdeField(raw,strictSerdeStruct(receiptShape))) as AbandonmentDecisionReceipt;
}
function record(value: unknown, shape: StructShape): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== shape.fields.length
    || shape.fields.some(([key]) => !Object.hasOwn(value,key))) throw new TypeError('Expected exact abandonment struct fields');
  return value as Record<string,unknown>;
}
function encode(value: Record<string,unknown>, shape: StructShape): string {
  return '{' + shape.fields.map(([key]) => JSON.stringify(key)+':'+serializeSerdeValue(value[key])).join(',') + '}';
}
export function serializeStoredAbandonmentProposal(input: StoredAbandonmentProposal): string {
  const value=record(cloneOwnedSerdeValue(input),storedShape), proposal=record(value.proposal,proposalShape);
  const raw='{'+storedShape.fields.map(([key])=>JSON.stringify(key)+':'+(key==='proposal'?encode(proposal,proposalShape):serializeSerdeValue(value[key]))).join(',')+'}';
  parseStoredAbandonmentProposal(raw);return raw;
}
export function serializeAbandonmentDecisionReceipt(input: AbandonmentDecisionReceipt): string {
  const raw=encode(record(cloneOwnedSerdeValue(input),receiptShape),receiptShape);
  parseAbandonmentDecisionReceipt(raw);return raw;
}
