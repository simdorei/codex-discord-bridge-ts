import type {DatabaseSync} from 'node:sqlite';
import {mirrorTargetsIn,type MirrorTarget} from './mirror-policy-read.ts';
import {withStoreTransaction,rollbackStore} from './owned-scope.ts';
/** Opt-in complete snapshot guard for off-thread discovery. Raw selected value
 * bytes and row count are bounded before materialization, under one read
 * transaction. This is not a hard SQLite cache/RSS or scan-time budget.
 * Invalid/filtered rows still consume budget and undergo the source decoder.
 * The existing unbounded API is unchanged. No create/migrate/close or writes. */
export function boundedMirrorTargetsIn(db:DatabaseSync,maxRows:bigint,maxValueBytes:bigint):readonly MirrorTarget[]{
 if(typeof maxRows!=='bigint'||maxRows<1n||maxRows>65536n||typeof maxValueBytes!=='bigint'||maxValueBytes<1n||maxValueBytes>16777216n)throw new RangeError('Expected bounded mirror snapshot limits');
 return withStoreTransaction(db,'DEFERRED',()=>{
  const query=db.prepare(`SELECT COUNT(*) AS rows,COALESCE(SUM(
   COALESCE(length(CAST(codex_thread_id AS BLOB)),0)+COALESCE(length(CAST(thread_title AS BLOB)),0)+
   COALESCE(length(CAST(discord_channel_id AS BLOB)),0)+COALESCE(length(CAST(discord_thread_id AS BLOB)),0)),0) AS bytes
   FROM mirror_threads`);query.setReadBigInts(true);const budget=query.get();
  if(budget===undefined||typeof budget.rows!=='bigint'||typeof budget.bytes!=='bigint'||budget.rows<0n||budget.bytes<0n)throw new TypeError('Invalid mirror snapshot measurement');
  if(budget.rows>maxRows||budget.bytes>maxValueBytes)throw new RangeError('Complete mirror target snapshot exceeds budget');
  return rollbackStore(mirrorTargetsIn(db,(1n<<63n)-1n));
 });
}
