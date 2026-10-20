import {requireDiscordText} from '../discord/text.ts';
import {actionExecutionErrorInfo} from './action-executor/action-error.ts';
import {cleanupRefusalFromOutcome, type CleanupRefusal} from '../store/async-resolution-cleanup-refusal.ts';
const protectedErrors = new WeakMap<object, Readonly<{channel: bigint; reason: string}>>();
/** Concrete pre-delete MirrorSyncError variant. Construct only at the mirror
 * protection check; arbitrary outcome data or error strings cannot mint it. */
export class MirrorCleanupProtectedError extends Error {
  constructor(channel: bigint, reason: string) {
    if (typeof channel !== 'bigint' || channel < 0n || channel >= 1n << 64n) throw new TypeError('Expected u64 room'); requireDiscordText(reason);
    super(`mirror sync stopped: room ${channel} is protected by ${reason}; no deletion was dispatched for this room; earlier sync changes may have completed`);
    this.name = 'MirrorCleanupProtectedError'; protectedErrors.set(this, Object.freeze({channel, reason})); Object.freeze(this);
  }
}
export function cleanupRefusalFromActionError(error: unknown): CleanupRefusal | undefined {
  const action = actionExecutionErrorInfo(error); if (action?.kind !== 'MirrorSync') return undefined;
  const value = action.source; if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  const protection = protectedErrors.get(value); if (protection === undefined) return undefined;
  return cleanupRefusalFromOutcome({kind: 'mirror_cleanup_refused', version: 1n, sync_completed: false, blocked_room_id: protection.channel,
    protection_reason: protection.reason, delete_dispatched: false, earlier_changes_possible: true});
}
