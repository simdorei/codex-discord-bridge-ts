import {passiveErrorText} from '../../core/passive-error-text.ts';
export type BusyComponentErrorKind = 'Missing' | 'MissingAuthorizationSnapshot' | 'WrongUser' | 'WrongChannel' | 'SteerNotAllowed' | 'AlreadyHandled' | 'ActionUnconfirmed'
  | 'ActionOutcomeIndeterminate' | 'ControlNotDispatched' | 'NoActiveTurn' | 'NoTarget' | 'IntegerRange' | 'Action' | 'AppServer' | 'Store' | 'Discord' | 'Confirmation';
const fixed = new Map<BusyComponentErrorKind, string>([
  ['Missing', 'this busy-choice button is no longer active'], ['MissingAuthorizationSnapshot', 'busy interaction has no matching pre-ack authorization snapshot'],
  ['WrongUser', 'only the original sender can choose this busy action'], ['WrongChannel', 'the busy-choice button belongs to a different Discord channel'],
  ['SteerNotAllowed', 'steering is not allowed for this busy choice; queue it instead'], ['AlreadyHandled', 'this busy choice was already handled'],
  ['ActionUnconfirmed', 'this busy action is claimed, but no durable success marker exists; it may still be in flight or its result is indeterminate'],
  ['NoActiveTurn', 'the target Codex thread has no active turn to control'], ['NoTarget', 'busy-choice record has no Codex thread target'],
  ['IntegerRange', 'Discord identifier does not fit the SQLite integer contract'],
]);
const known = new WeakMap<object, Readonly<{kind: BusyComponentErrorKind; source: unknown; text: string}>>();
export class BusyComponentError extends Error {
  constructor(kind: BusyComponentErrorKind, source?: unknown) {
    const detail = typeof source === 'string' ? source : passiveErrorText(source, 'busy action failed');
    const text = fixed.get(kind) ?? (kind === 'ActionOutcomeIndeterminate' ? 'busy action acceptance is indeterminate; claim retained to prevent duplicate execution: ' + detail
      : kind === 'ControlNotDispatched' ? 'control was not dispatched: ' + detail
      : ['Action', 'AppServer', 'Store', 'Discord', 'Confirmation'].includes(kind) ? detail : null);
    if (text === null) throw new TypeError('Expected busy component failure kind');
    super(text, {cause: source}); this.name = 'BusyComponentError'; known.set(this, Object.freeze({kind, source, text})); Object.freeze(this);
  }
}
export function busyComponentErrorInfo(value: unknown) {return value !== null && (typeof value === 'object' || typeof value === 'function') ? known.get(value) ?? null : null;}
