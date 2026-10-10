import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {ComponentId} from '../../discord/components.ts';
import {snapshotComponentId, COMPONENT_CONFIRMATION_DOMAIN, BUSY_CONFIRMATION_DOMAIN} from '../discord-dispatch/delivery-identity.ts';
export interface ConfirmationPlan {readonly content: string; readonly domain: string; readonly logicalKey: string}
export type ConfirmationClaimState = 'ExecuteAction' | 'ActionUnconfirmed' | 'DeliverConfirmation';
export class ConfirmationPlanError extends Error {constructor() {super('busy components require a busy confirmation plan'); this.name = 'ConfirmationPlanError';}}
export type ConfirmationErrorKind = 'Delivery' | 'Recovery' | 'Clear';
const failures = new WeakMap<object, Readonly<{kind: ConfirmationErrorKind; detail: string; source: unknown}>>();
export class ConfirmationError extends Error {
  constructor(kind: ConfirmationErrorKind, detail: string, source?: unknown) {
    requireDiscordText(detail);
    const prefix = kind === 'Delivery' ? 'action succeeded; confirmation delivery failed and remains retryable: '
      : kind === 'Recovery' ? 'action succeeded; durable confirmation recovery state failed: '
      : kind === 'Clear' ? 'action and confirmation succeeded; clearing handled Discord buttons failed and remains retryable: ' : null;
    if (prefix === null) throw new TypeError('Expected confirmation failure kind');
    super(prefix + detail, {cause: source}); this.name = 'ConfirmationError'; failures.set(this, Object.freeze({kind, detail, source})); Object.freeze(this);
  }
}
export function confirmationErrorInfo(value: unknown) {return value !== null && (typeof value === 'object' || typeof value === 'function') ? failures.get(value) ?? null : null;}
const plans = new WeakSet<object>();
export function isConfirmationPlan(value: unknown): value is ConfirmationPlan {return value !== null && typeof value === 'object' && plans.has(value);}
function field(name: string, value: string): string {requireDiscordText(value); return `${name}=${Buffer.byteLength(value, 'utf8')}:${value};`;}
function plan(content: string, domain: string, kind: string, action: string): ConfirmationPlan {
  const result = Object.freeze({content, domain, logicalKey: 'v1;' + field('kind', kind) + field('action', action)}); plans.add(result); return result;
}
export function standardReadyMarker(actionClaim: string): string {return 'confirmation-ready:v1;' + field('kind', 'standard') + field('action', actionClaim);}
export function busyReadyMarker(choiceId: string, ownerUserId: bigint, channelId: bigint): string {
  for (const value of [ownerUserId, channelId]) if (typeof value !== 'bigint' || value < 0n || value >= 1n << 64n) throw new TypeError('Expected u64 ready-marker identity');
  return 'confirmation-ready:v1;' + field('kind', 'busy') + field('action', choiceId) + field('user', String(ownerUserId)) + field('channel', String(channelId));
}
export function standardConfirmationPlan(input: ComponentId, actionClaim: string): ConfirmationPlan {
  const component = snapshotComponentId(input);
  if ('Approval' in component || 'BoundApproval' in component) return plan('Approval response submitted.', COMPONENT_CONFIRMATION_DOMAIN, 'approval', actionClaim);
  if ('Input' in component || 'BoundInput' in component) return plan('Codex input choice submitted.', COMPONENT_CONFIRMATION_DOMAIN, 'input', actionClaim);
  throw new ConfirmationPlanError();
}
export function busyConfirmationPlan(choiceId: string): ConfirmationPlan {return plan('Busy action submitted.', BUSY_CONFIRMATION_DOMAIN, 'busy', choiceId);}
const live = state.isComponentClaimLive, claim = state.claimComponent;
export const confirmationReady = live;
export const recordConfirmationReady = claim;
/** Preserve ready→claim→ready ordering and separate source transactions. The
 * second ready check distinguishes a completed action from an uncertain claim. */
export async function claimStandardAction(database: string, actionClaim: string, readyMarker: string, now: number, timeToLive: number): Promise<ConfirmationClaimState> {
  if (await live(database, readyMarker, now)) return 'DeliverConfirmation';
  if (await claim(database, actionClaim, now, timeToLive)) return 'ExecuteAction';
  return await live(database, readyMarker, now) ? 'DeliverConfirmation' : 'ActionUnconfirmed';
}
/** Exact async-question confirmation identity, minted only as a display plan. */
export function asyncQuestionConfirmationPlan(questionId: string): ConfirmationPlan {
  requireDiscordText(questionId); const value = Object.freeze({content: '선택한 답변을 원래 Codex 스레드에 전달했습니다.', domain: 'async-question-confirmation-v1', logicalKey: questionId}); plans.add(value); return value;
}

/** Records descriptive recovery intent only, never an execution permit. */
export function publicationIntentConfirmationPlan(id: string, revision: bigint, decision: 'ApproveExact' | 'KeepHeld'): ConfirmationPlan {
  requireDiscordText(id);
  if (!/^[0-9a-f]{32}$/.test(id) || typeof revision !== 'bigint' || revision <= 0n || revision >= 1n << 63n
    || (decision !== 'ApproveExact' && decision !== 'KeepHeld')) throw new TypeError('Expected exact publication decision');
  const value = Object.freeze({
    content: decision === 'ApproveExact'
      ? 'Exact recovery intent recorded. No request was started; separate safety checks are still required.'
      : 'Recovery will remain held. No request was started.',
    domain: 'recovery-publication-intent-confirmation-v1', logicalKey: `${id}:${revision}`,
  });
  plans.add(value); return value;
}
