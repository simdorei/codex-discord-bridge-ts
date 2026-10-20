import type {DatabaseSync} from 'node:sqlite';
import {remainingDiscordIdsIn,type RemainingDiscordIds} from './mirror-policy-read.ts';
import {withStoreTransaction,rollbackStore} from './owned-scope.ts';
/** Complete bounded first half of the source policy refresh. Counts include
 * filtered zero/null/duplicate IDs. Measurements and decoding share one read
 * transaction. No partial set is returned. Not a hard SQLite scan/RSS bound. */
export function boundedRemainingDiscordIdsIn(db:DatabaseSync,maxRows:bigint,maxValueBytes:bigint):RemainingDiscordIds {
 if(typeof maxRows!=='bigint'||maxRows<1n||maxRows>65536n||typeof maxValueBytes!=='bigint'||maxValueBytes<1n||maxValueBytes>16777216n)throw new RangeError('Invalid remaining ID snapshot limits');
 return withStoreTransaction(db,'DEFERRED',()=>{
  const measure=db.prepare(`SELECT
   (SELECT COUNT(*) FROM mirror_threads)+(SELECT COUNT(*) FROM mirror_projects) AS rows,
   (SELECT COALESCE(SUM(COALESCE(length(CAST(discord_thread_id AS BLOB)),0)),0) FROM mirror_threads)+
   (SELECT COALESCE(SUM(COALESCE(length(CAST(discord_channel_id AS BLOB)),0)),0) FROM mirror_projects) AS bytes`);
  measure.setReadBigInts(true);const row=measure.get();
  if(row===undefined||typeof row.rows!=='bigint'||typeof row.bytes!=='bigint'||row.rows<0n||row.bytes<0n)throw new TypeError('Invalid remaining ID snapshot measurement');
  if(row.rows>maxRows||row.bytes>maxValueBytes)throw new RangeError('Complete remaining ID snapshot exceeds budget');
  return rollbackStore(remainingDiscordIdsIn(db));
 });
}
