import type {DatabaseSync} from 'node:sqlite';
import {requireDiscordText} from '../../discord/text.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {archiveRowDigestsIn, type ArchiveRows, type ArchiveRowLimits} from './row-digests.ts';

export class ArchiveConcurrentMutationError extends Error {
 constructor(){super('Archived records changed since backup');this.name='ArchiveConcurrentMutationError';}
}
function unchanged(db:DatabaseSync,backup:DatabaseSync,kind:ArchiveRows,id:string,limits:ArchiveRowLimits):void {
 const current=archiveRowDigestsIn(db,kind,id,limits),saved=archiveRowDigestsIn(backup,kind,id,limits);
 if(current.length!==saved.length||current.some((value,index)=>value!==saved[index]))throw new ArchiveConcurrentMutationError();
}
function captureLimits(limits:ArchiveRowLimits):ArchiveRowLimits {
 const maxRows=own(limits,'maxRows'),maxBytes=own(limits,'maxBytes');
 if(typeof maxRows!=='number'||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>4096||typeof maxBytes!=='number'||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4194304)throw new RangeError('Invalid archive evidence limits');
 return Object.freeze({maxRows,maxBytes});
}
function immediate<T>(db:DatabaseSync,backup:DatabaseSync,operation:()=>T):T {
 if(db===backup)throw new TypeError('Archive backup must be a distinct connection');
 if(db.isTransaction)throw new TypeError('Archive deletion requires an idle owned transaction scope');
 db.exec('BEGIN IMMEDIATE');
 try {const result=operation();db.exec('COMMIT');return result;}
 catch(error){
  if(db.isTransaction){try{db.exec('ROLLBACK');}catch(rollback){throw new AggregateError([error,rollback],'Archive deletion failed and rollback is unconfirmed');}}
  throw error;
 }
}
/** Native-worker leaf only. The caller must supply an independently verified,
 * immutable backup connection and maintain the outer archive reservation.
 * Owns one IMMEDIATE transaction, never opens/closes either connection. No file
 * backup, transcript deletion, reservation, or overall archive success authority. */
export function deleteArchivedStateRows(db:DatabaseSync,backup:DatabaseSync,id:string,rollout:string,limits:ArchiveRowLimits):void {
 requireDiscordText(id);requireDiscordText(rollout);const bounded=captureLimits(limits);
 immediate(db,backup,()=>{
  const query=db.prepare('SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1 AND archived=1 AND rollout_path=?2) AS present');query.setReadBigInts(true);
  const row=query.get(id,rollout);
  if(row?.present!==1n)throw new ArchiveConcurrentMutationError();
  unchanged(db,backup,'thread',id,bounded);unchanged(db,backup,'edges',id,bounded);
  db.prepare('DELETE FROM thread_spawn_edges WHERE child_thread_id = ?1 OR parent_thread_id = ?1').run(id);
  const deletion=db.prepare('DELETE FROM threads WHERE id = ?1 AND archived = 1 AND rollout_path = ?2');deletion.setReadBigInts(true);
  if(deletion.run(id,rollout).changes!==1n)throw new ArchiveConcurrentMutationError();
 });
}
/** Missing log-file handling belongs to the future filesystem owner. This leaf
 * requires two existing connections; missing tables remain native SQL failures. */
export function deleteArchivedLogRows(db:DatabaseSync,backup:DatabaseSync,id:string,limits:ArchiveRowLimits):bigint {
 requireDiscordText(id);const bounded=captureLimits(limits);
 return immediate(db,backup,()=>{
  unchanged(db,backup,'logs',id,bounded);
  const deletion=db.prepare('DELETE FROM logs WHERE thread_id = ?1');deletion.setReadBigInts(true);
  const count=deletion.run(id).changes;
  if(typeof count!=='bigint'||count<0n)throw new TypeError('Invalid native archive deletion count');
  return count;
 });
}
