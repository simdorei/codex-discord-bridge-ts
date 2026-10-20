import {types} from 'node:util';
import {usingInitializedStore, usingExistingReadOnlyStore, withStoreTransaction, commitStore, rollbackStore} from './owned-scope.ts';
import {eligibleArchivedCleanupIn} from './archived-cleanup-proof.ts';
import {roomCleanupPendingReasonIn} from './room-cleanup-pending.ts';
import {beginRoomCleanupIn} from './room-cleanup.ts';
import {receiptExists} from './delivery-receipt-key.ts';
import {containerI64} from './mirror-container-creation.ts';
import {requireDiscordText} from '../discord/text.ts';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
function inputs(path: string, channel: bigint, target: string, now: number): void {
  requireDiscordText(path); containerI64(channel); requireDiscordText(target);
  if (typeof now !== 'number') throw new TypeError('Expected f64 cleanup time');
}
/** Read-only eligibility and protection share one snapshot. Matching rejected
 * controls do not assert notification delivery and do not mutate held records. */
export function archivedCleanupPendingReason(path: string, channel: bigint, target: string, now: number): string | null {
  inputs(path, channel, target, now);
  return usingExistingReadOnlyStore(path, db => withStoreTransaction(db, 'DEFERRED', () => {
    const ids = eligibleArchivedCleanupIn(db, channel, target, now).map(row => row.id);
    return rollbackStore(roomCleanupPendingReasonIn(db, channel, target, null, false, ids));
  }));
}
/** Atomic archived cleanup fence plus append-only audit. The native caller must
 * freshly verify the exact archived Codex source inside the synchronous callback;
 * no callback result escapes before commit. This does not dispatch Discord. */
export async function beginArchivedCleanup(path: string, channel: bigint, target: string, parent: bigint, now: number, verifyArchive: () => string): Promise<string> {
  inputs(path, channel, target, now); containerI64(parent);
  if (typeof verifyArchive !== 'function' || types.isProxy(verifyArchive) || types.isAsyncFunction(verifyArchive) || types.isGeneratorFunction(verifyArchive)) throw new TypeError('Expected synchronous archive verification');
  return usingInitializedStore(path, db => withStoreTransaction(db, 'IMMEDIATE', () => {
    const matches = receiptExists(db, 'SELECT EXISTS(SELECT 1 FROM mirror_threads WHERE codex_thread_id=? AND discord_thread_id=? AND discord_channel_id=?) AS held', target, channel, parent);
    if (parent <= 0n || !matches) throw new StoreIntegrityError('archived cleanup parent identity changed');
    const allowed = eligibleArchivedCleanupIn(db, channel, target, now);
    const token = beginRoomCleanupIn(db, channel, target, now, allowed.map(row => row.id));
    const archive = verifyArchive();
    if (types.isPromise(archive)) { void Promise.prototype.then.call(archive, undefined, () => undefined); throw new TypeError('Archive verification returned a Promise'); }
    if (typeof archive !== 'string') throw new TypeError('Expected serialized archive verification');
    parseSerdeValue(archive);
    for (const row of allowed) {
      const changes = db.prepare(`INSERT INTO cdr_archived_cleanup_evidence
        (token,channel_id,target_thread_id,ingress_id,payload_json,outcome_json,row_snapshot_json,archive_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(token, channel, target, row.id, row.payload, row.outcome, row.snapshot, archive, now).changes;
      if (BigInt(changes) !== 1n) throw new StoreIntegrityError('archived cleanup evidence was not inserted');
    }
    return commitStore(token);
  }));
}
