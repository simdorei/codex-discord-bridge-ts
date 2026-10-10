import type {DatabaseSync} from 'node:sqlite';
import {listFilteredIn,COLUMNS,type StoredQueueJob} from './queue-read.ts';
import {withStoreTransaction,rollbackStore} from './owned-scope.ts';
// COLUMNS is an internal constant, never caller-supplied SQL.
const valueBytes=COLUMNS.split(',').map(column=>`COALESCE(length(CAST(${column.trim()} AS BLOB)),0)`).join('+');
/** Complete, bounded source queue read under one borrowed read transaction.
 * Bounds raw selected values before full decoding, including baseline JSON.
 * Does not truncate, initialize, write, close, or modify caller transactions.
 * Must run off the main runtime loop; this function is synchronous SQLite.
 * Raw-byte bounds do not prove SQLite heap/cache or decoded object heap limits. */
export function boundedQueueJobsIn(db:DatabaseSync,maxRows:bigint,maxValueBytes:bigint,target:string|null=null):StoredQueueJob[]{
 if(typeof maxRows!=='bigint'||maxRows<1n||maxRows>65536n||typeof maxValueBytes!=='bigint'||maxValueBytes<1n||maxValueBytes>16777216n)throw new RangeError('Expected bounded queue snapshot limits');
 if(target!==null&&(typeof target!=='string'||/[\uD800-\uDFFF]/u.test(target)))throw new TypeError('Expected well-formed target');
 const where=target===null?'':' WHERE target_thread_id = ?',params=target===null?[]:[target];
 return withStoreTransaction(db,'DEFERRED',()=>{
  const query=db.prepare(`SELECT COUNT(*) AS rows,COALESCE(SUM(${valueBytes}),0) AS bytes FROM codex_turn_queue${where}`);query.setReadBigInts(true);const budget=query.get(...params);
  if(budget===undefined||typeof budget.rows!=='bigint'||typeof budget.bytes!=='bigint'||budget.rows<0n||budget.bytes<0n)throw new TypeError('Invalid queue snapshot measurement');
  if(budget.rows>maxRows||budget.bytes>maxValueBytes)throw new RangeError('Complete queue snapshot exceeds budget');
  return rollbackStore(listFilteredIn(db,target,null));
 });
}
