import {passiveErrorText} from '../../core/passive-error-text.ts';
import {componentWorkerErrorInfo} from '../component-worker/errors.ts';
import {busyComponentErrorInfo} from '../component-worker/busy-errors.ts';
import {cleanupNotificationFailureInfo} from '../cleanup-notification-failure.ts';
export type InteractionWorkerErrorKind = 'KnownOutcomeNotification' | 'PromptDelivery' | 'Plan' | 'Action' | 'Delivery' | 'Unsupported' | 'Component' | 'Ui' | 'Custody';
const owned = new WeakMap<object, Readonly<{kind: InteractionWorkerErrorKind; source: unknown; text: string}>>();
const kinds = new Set<InteractionWorkerErrorKind>(['KnownOutcomeNotification', 'PromptDelivery', 'Plan', 'Action', 'Delivery', 'Unsupported', 'Component', 'Ui', 'Custody']);
export class InteractionWorkerError extends Error {
  constructor(kind: InteractionWorkerErrorKind, source: unknown) {
    if (!kinds.has(kind)) throw new TypeError('Expected interaction failure kind');
    if (kind === 'Component' && componentWorkerErrorInfo(source) === null) throw new TypeError('Expected owned component failure');
    if (kind === 'KnownOutcomeNotification' && cleanupNotificationFailureInfo(source) === null) throw new TypeError('Expected recorded known-outcome notification failure');
    const detail = typeof source === 'string' ? source : passiveErrorText(source, 'interaction operation failed');
    // Native JS delivery diagnostics intentionally use passive text, not arbitrary
    // Debug/toString traversal of transport/source objects.
    const text = kind === 'Delivery' ? 'Discord interaction delivery failed: ' + detail : kind === 'Unsupported' ? 'interaction work type is not implemented yet: ' + detail
      : kind === 'Custody' ? 'durable interaction custody failed: ' + detail : detail;
    super(text, {cause: source}); this.name = 'InteractionWorkerError'; owned.set(this, Object.freeze({kind, source, text})); Object.freeze(this);
  }
}
export function interactionWorkerErrorInfo(value: unknown) {return value !== null && (typeof value === 'object' || typeof value === 'function') ? owned.get(value) ?? null : null;}
export type InteractionErrorDisposition = 'IgnoreDuplicate' | 'LogOnly' | 'Report';
export function interactionErrorDisposition(error: unknown): InteractionErrorDisposition {
  const info = interactionWorkerErrorInfo(error); if (info === null) return 'Report';
  if (info.kind === 'KnownOutcomeNotification') return 'LogOnly';
  if (info.kind !== 'Component') return 'Report';
  const component = componentWorkerErrorInfo(info.source)!;
  const kind = component.kind === 'Busy' ? busyComponentErrorInfo(component.source)?.kind : component.kind;
  if (kind === 'AlreadyHandled') return 'IgnoreDuplicate';
  return kind === 'ActionUnconfirmed' || kind === 'ActionOutcomeIndeterminate' || kind === 'Confirmation' ? 'LogOnly' : 'Report';
}
