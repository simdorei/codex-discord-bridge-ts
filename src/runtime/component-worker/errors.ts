import {passiveErrorText} from '../../core/passive-error-text.ts';
import {confirmationErrorInfo} from './confirmation.ts';
import {busyComponentErrorInfo} from './busy-errors.ts';
export type ComponentWorkerErrorKind = 'Abandonment' | 'AbandonmentNotice' | 'PublicationConsent' | 'AsyncQuestion' | 'MissingSourceMessage' | 'NoPendingRequest'
  | 'AmbiguousPendingRequest' | 'LegacyComponentExpired' | 'BusyChoice' | 'InvalidComponent' | 'Authority' | 'AlreadyHandled' | 'ActionUnconfirmed'
  | 'ActionOutcomeIndeterminate' | 'AppServer' | 'Store' | 'Discord' | 'ConfirmationPlan' | 'Confirmation' | 'Clear' | 'Busy';
const fixed = new Map<ComponentWorkerErrorKind, string>([
  ['MissingSourceMessage', 'component interaction did not include its source Discord message'], ['NoPendingRequest', 'no matching pending app-server request is available'],
  ['AmbiguousPendingRequest', "more than one pending app-server request matches; use the exact request's button or displayed [codex-reply:...] prefix"],
  ['LegacyComponentExpired', 'this legacy approval or input component has expired; use the latest prompt'], ['BusyChoice', 'busy-choice component handling is not implemented in this path'],
  ['InvalidComponent', 'persistent component ID could not be encoded'], ['AlreadyHandled', 'this approval or input choice was already handled'],
  ['ActionUnconfirmed', 'this component action is claimed, but no durable success marker exists; it may still be in flight or its result is indeterminate'],
]);
const prefix = new Map<ComponentWorkerErrorKind, string>([
  ['Abandonment', 'saved-request disposition held: '], ['AbandonmentNotice', 'saved-request decision is recorded; notification incomplete, without request replay: '],
  ['PublicationConsent', 'publication consent was not recorded: '], ['ActionOutcomeIndeterminate', 'component action acceptance is indeterminate; claim retained to prevent duplicate execution: '],
  ['Clear', 'could not clear handled Discord buttons: '],
]);
const transparent = new Set<ComponentWorkerErrorKind>(['AsyncQuestion', 'Authority', 'AppServer', 'Store', 'Discord', 'ConfirmationPlan', 'Confirmation', 'Busy']);
const owned = new WeakMap<object, Readonly<{kind: ComponentWorkerErrorKind; source: unknown; text: string}>>();
export class ComponentWorkerError extends Error {
  constructor(kind: ComponentWorkerErrorKind, source?: unknown) {
    const detail = typeof source === 'string' ? source : passiveErrorText(source, 'component action failed');
    const text = fixed.get(kind) ?? (prefix.has(kind) ? prefix.get(kind)! + detail : transparent.has(kind) ? detail : null);
    if (text === null) throw new TypeError('Expected component failure kind');
    super(text, {cause: source}); this.name = 'ComponentWorkerError'; owned.set(this, Object.freeze({kind, source, text})); Object.freeze(this);
  }
}
export function componentWorkerErrorInfo(value: unknown) {return value !== null && (typeof value === 'object' || typeof value === 'function') ? owned.get(value) ?? null : null;}
export function actionCompletedBeforeFailure(value: unknown): boolean {
  const error = componentWorkerErrorInfo(value); if (error === null) return false;
  if (error.kind === 'Confirmation') return confirmationErrorInfo(error.source)?.kind === 'Recovery';
  if (error.kind !== 'Busy') return false; const busy = busyComponentErrorInfo(error.source);
  return busy?.kind === 'Confirmation' && confirmationErrorInfo(busy.source)?.kind === 'Recovery';
}
