import type {DatabaseSync} from 'node:sqlite';
import {snapshotBoundMirrorCursor,prepareMappedMirrorCursorAdvance,advancePreparedMappedMirrorCursorInTransaction,type BoundMirrorCursor} from '../../store/mirror-cursor-journal.ts';
import type {MirrorCursorAnchor} from '../../core/mirror-cursor-anchor.ts';
import type {ExpectedReceipt} from '../../store/confirmed-receipt-batch.ts';
import {withStoreTransaction,commitStore} from '../../store/owned-scope.ts';
import {snapshotMirrorSkippedItems,requireCurrentMirrorSkipsIn} from './ownership.ts';
import type {MirrorItem} from './collect.ts';
/** Fixed native DB operation: current mapping, delivered receipts, current skip
 * proof and both cursor records share one IMMEDIATE transaction. Trigger effects
 * that revoke skip proof are checked again before commit and rolled back.
 * No network/filesystem IO. Receipt hashes and input capture occur before BEGIN; skip guards revalidate bounded data.
 * Trusted caller must derive the COMPLETE delivered/skipped partition from an
 * authentic batch. This leaf alone cannot detect omitted items or authorize sends.
 * A previously committed operation whose skip proof later changed must be
 * reconciled by read-only exact packet identity, not replayed automatically. */
export function advanceMirrorCursorWithSkips(db:DatabaseSync,expected:BoundMirrorCursor,anchor:MirrorCursorAnchor,turn:string,updatedAt:number,operationId:string,receipts:readonly ExpectedReceipt[],channel:bigint,input:readonly MirrorItem[],maxJobs:bigint,maxValueBytes:bigint):BoundMirrorCursor{
 const old=snapshotBoundMirrorCursor(expected),skipped=snapshotMirrorSkippedItems(old.thread,input);
 const plan=prepareMappedMirrorCursorAdvance(old,anchor,turn,updatedAt,operationId,receipts,channel);
 return withStoreTransaction(db,'IMMEDIATE',()=>{
  requireCurrentMirrorSkipsIn(db,old.thread,skipped,maxJobs,maxValueBytes);
  const result=advancePreparedMappedMirrorCursorInTransaction(db,plan);
  requireCurrentMirrorSkipsIn(db,result.thread,skipped,maxJobs,maxValueBytes);
  return commitStore(result);
 });
}
