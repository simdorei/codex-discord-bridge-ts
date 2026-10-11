import type {DatabaseSync} from 'node:sqlite';
import {listFilteredIn,COLUMNS,type StoredQueueJob} from './queue-read.ts';
import {withStoreTransaction,rollbackStore} from './owned-scope.ts';
// COLUMNS is an internal constant, never caller-supplied SQL.
const valueBytes=COLUMNS.split(',').map(column=>`COALESCE(length(CAST(${column.trim()} AS BLOB)),0)`).join('+');
function validate(maxRows:bigint,maxValueBytes:bigint,target:string|null):void{
 if(typeof maxRows!=='bigint'||maxRows<1n||maxRows>65536n||typeof maxValueBytes!=='bigint'||maxValueBytes<1n||maxValueBytes>16777216n)throw new RangeError('Expected bounded queue snapshot limits');
 if(target!==null&&(typeof target!=='string'||/[\uD800-\uDFFF]/u.test(target)))throw new TypeError('Expected well-formed target');
}
/** Owns one read transaction on a borrowed connection. Existing caller transactions
 * are rejected, never committed or rolled back. Complete raw-byte bound precedes decode. */
export function boundedQueueJobsIn(db:DatabaseSync,maxRows:bigint,maxValueBytes:bigint,target:string|null=null):StoredQueueJob[]{
 validate(maxRows,maxValueBytes,target);
 return withStoreTransaction(db,'DEFERRED',()=>rollbackStore(boundedQueueJobsInTransaction(db,maxRows,maxValueBytes,target)));
}
/** Caller owns the active transaction. Never begins, commits, rolls back or closes.
 * Complete target snapshot, no truncation. Must execute off the main runtime loop.
 * Raw-value budget does not establish SQLite heap/cache or decoded heap bounds. */
export function boundedQueueJobsInTransaction(db:DatabaseSync,maxRows:bigint,maxValueBytes:bigint,target:string|null=null):StoredQueueJob[]{
 validate(maxRows,maxValueBytes,target);
 if(!db.isTransaction)throw new TypeError('Queue snapshot requires active caller transaction');
 const where=target===null?'':' WHERE target_thread_id = ?',params=target===null?[]:[target];
  const query=db.prepare(`SELECT COUNT(*) AS rows,COALESCE(SUM(${valueBytes}),0) AS bytes FROM codex_turn_queue${where}`);query.setReadBigInts(true);const budget=query.get(...params);
  if(budget===undefined||typeof budget.rows!=='bigint'||typeof budget.bytes!=='bigint'||budget.rows<0n||budget.bytes<0n)throw new TypeError('Invalid queue snapshot measurement');
  if(budget.rows>maxRows||budget.bytes>maxValueBytes)throw new RangeError('Complete queue snapshot exceeds budget');
  return listFilteredIn(db,target,null);
}
