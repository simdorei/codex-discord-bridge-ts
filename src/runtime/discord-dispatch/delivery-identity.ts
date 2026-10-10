import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {persistentComponentClaimKey, type ComponentId} from '../../discord/components.ts';
export const INTERACTION_FOLLOWUP_DOMAIN = 'interaction/followup/v1';
export const INTERACTION_ERROR_DOMAIN = 'interaction/error/v1';
export const COMPONENT_CONFIRMATION_DOMAIN = 'component/confirmation/v1';
export const BUSY_CONFIRMATION_DOMAIN = 'component/busy-confirmation/v1';
export const COMPONENT_ERROR_DOMAIN = 'interaction/error-component/v1';
const approvals = new Map([['Approve', '1'], ['ApproveSession', '2'], ['Reject', '3'], ['Cancel', 'cancel']]);
const busy = new Map([['Steer', 'steer'], ['Queue', 'queue'], ['Stop', 'stop'], ['Ignore', 'ignore']]);
function id(value: bigint): void {if (typeof value !== 'bigint' || value <= 0n || value >= 1n << 64n) throw new TypeError('Expected nonzero Discord identity');}
function field(name: string, value: string): string {requireDiscordText(value); return `${name}=${Buffer.byteLength(value, 'utf8')}:${value};`;}
export function snapshotComponentId(input: ComponentId): ComponentId {
  const copied = cloneOwnedSerdeValue(input);
  if (copied === null || typeof copied !== 'object' || Array.isArray(copied) || Object.keys(copied).length !== 1) throw new TypeError('Expected one component variant');
  const [kind] = Object.keys(copied), value = (copied as Record<string, unknown>)[kind!];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected component fields');
  const data = value as Record<string, unknown>;
  const shapes: Record<string, readonly string[]> = {RecoveryAbandonDecision: ['proposal_id', 'revision', 'decision'], RecoveryPublicationDecision: ['proposal_id', 'revision', 'decision'],
    AsyncChoice: ['question_id', 'option'], Busy: ['choice_id', 'action'], Approval: ['thread_id', 'answer'], BoundApproval: ['thread_fingerprint', 'request_fingerprint', 'answer'], Input: ['thread_id', 'value'], BoundInput: ['thread_fingerprint', 'request_fingerprint', 'value']};
  if (!Object.hasOwn(shapes, kind!)) throw new TypeError('Expected component variant'); const keys = shapes[kind!]!;
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) throw new TypeError('Expected exact component fields');
  for (const key of keys) if (key !== 'revision' && key !== 'option') requireDiscordText(data[key]);
  if (Object.hasOwn(data, 'revision') && (typeof data.revision !== 'bigint' || data.revision < -(1n << 63n) || data.revision >= 1n << 63n)) throw new TypeError('Expected i64 revision');
  if (Object.hasOwn(data, 'option') && (typeof data.option !== 'bigint' || data.option < 0n || data.option >= 1n << 64n)) throw new TypeError('Expected 64-bit usize option');
  if (Object.hasOwn(data, 'answer') && !approvals.has(data.answer as string)) throw new TypeError('Expected approval answer');
  if (Object.hasOwn(data, 'action') && !busy.has(data.action as string)) throw new TypeError('Expected busy action');
  if (kind === 'RecoveryAbandonDecision' && data.decision !== 'AbandonOnly' && data.decision !== 'KeepHeld') throw new TypeError('Expected abandonment decision');
  if (kind === 'RecoveryPublicationDecision' && data.decision !== 'ApproveExact' && data.decision !== 'KeepHeld') throw new TypeError('Expected publication decision');
  // Preserve the validated own variant without Object.prototype inheritance;
  // downstream source-style variant checks must not observe polluted siblings.
  return Object.freeze(Object.assign(Object.create(null), copied)) as ComponentId;
}
function componentIdentity(component: ComponentId): string {
  if ('RecoveryAbandonDecision' in component) {const c = component.RecoveryAbandonDecision; return 'abandonment-decision-v1;' + field('proposal', c.proposal_id) + field('revision', String(c.revision)) + field('decision', c.decision);}
  if ('RecoveryPublicationDecision' in component) {const c = component.RecoveryPublicationDecision; return 'publication-intent-v1;' + field('proposal', c.proposal_id) + field('revision', String(c.revision)) + field('decision', c.decision);}
  if ('AsyncChoice' in component) return `async-question:${component.AsyncChoice.question_id}:${component.AsyncChoice.option}`;
  if ('Busy' in component) return 'busy;' + field('choice', component.Busy.choice_id) + field('action', busy.get(component.Busy.action)!);
  if ('Approval' in component) return 'approval;' + field('thread', component.Approval.thread_id) + field('answer', approvals.get(component.Approval.answer)!);
  if ('Input' in component) return 'input;' + field('thread', component.Input.thread_id) + field('value', component.Input.value);
  if ('BoundApproval' in component) return 'approval-v2;' + field('thread', component.BoundApproval.thread_fingerprint) + field('request', component.BoundApproval.request_fingerprint) + field('answer', approvals.get(component.BoundApproval.answer)!);
  return 'input-v2;' + field('thread', component.BoundInput.thread_fingerprint) + field('request', component.BoundInput.request_fingerprint) + field('value', component.BoundInput.value);
}
export function interactionDeliveryKey(interactionId: bigint): string {id(interactionId); return `interaction:${interactionId}`;}
/** Identity only, not parser acceptance or actor authority. Internal enum strings
 * retain delimiters/Unicode; revision accepts source i64 and option accepts the
 * selected64-bit usize profile. Length fields count UTF-8 bytes, not JS units. */
export function componentDeliveryKey(interactionId: bigint, sourceMessageId: bigint | null, input: ComponentId, claimIdentity: string | null): string {
  id(interactionId); if (sourceMessageId !== null) id(sourceMessageId); if (claimIdentity !== null) requireDiscordText(claimIdentity);
  const component = componentIdentity(snapshotComponentId(input));
  return 'v1;' + (sourceMessageId === null ? 'source-none;' : field('source-some', String(sourceMessageId)))
    + field('interaction', String(interactionId)) + field('component', component)
    + (claimIdentity === null ? 'claim-none;' : field('claim-some', claimIdentity));
}
export function componentClaimIdentity(sourceMessageId: bigint | null, input: ComponentId): string | null {
  if (sourceMessageId !== null) id(sourceMessageId); const component = snapshotComponentId(input);
  if ('RecoveryAbandonDecision' in component || 'RecoveryPublicationDecision' in component) return null;
  if ('AsyncChoice' in component) return component.AsyncChoice.question_id;
  if ('Busy' in component) return component.Busy.choice_id;
  return sourceMessageId === null ? null : persistentComponentClaimKey(sourceMessageId, component);
}
