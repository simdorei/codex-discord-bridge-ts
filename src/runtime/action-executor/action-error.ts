import {passiveErrorText} from '../../core/passive-error-text.ts';
export type ActionErrorKind = 'PromptRedisplay' | 'State' | 'Resolve' | 'Bridge' | 'Store' | 'Queue' | 'AppServer' | 'ArchiveDelete' | 'Prompt' | 'MirrorSync'
  | 'NoTarget' | 'IntegerRange' | 'SystemTime' | 'Io' | 'MissingAppServer' | 'Invalid' | 'Unsupported';
const transparent = new Set<ActionErrorKind>(['PromptRedisplay', 'State', 'Resolve', 'Bridge', 'Store', 'Queue', 'AppServer', 'ArchiveDelete', 'Prompt', 'MirrorSync']);
const fixed = new Map<ActionErrorKind, string>([['NoTarget', 'no Codex thread target is selected or mirrored for this channel'], ['IntegerRange', 'Discord identifier does not fit the SQLite integer contract'], ['MissingAppServer', 'resident Codex app-server is unavailable for this command']]);
const prefix = new Map<ActionErrorKind, string>([['SystemTime', 'system clock is before the Unix epoch: '], ['Io', 'operating-system command failed: '], ['Invalid', 'invalid command request: '], ['Unsupported', 'runtime action is not implemented yet: ']]);
const owned = new WeakMap<object, Readonly<{kind: ActionErrorKind; source: unknown}>>();
/** Shared source ActionError boundary. Existing leaf-specific errors can remain
 * underlying causes; classification never traverses arbitrary name/cause fields. */
export class ActionExecutionError extends Error {
  constructor(kind: ActionErrorKind, source?: unknown) {
    const detail = typeof source === 'string' ? source : passiveErrorText(source, 'action failed');
    const message = fixed.get(kind) ?? (prefix.has(kind) ? prefix.get(kind)! + detail : transparent.has(kind) ? detail : null);
    if (message === null) throw new TypeError('Expected action error variant');
    super(message, {cause: source}); this.name = 'ActionExecutionError'; owned.set(this, Object.freeze({kind, source})); Object.freeze(this);
  }
}
export function actionExecutionErrorInfo(value: unknown) {return value !== null && (typeof value === 'object' || typeof value === 'function') ? owned.get(value) ?? null : null;}
