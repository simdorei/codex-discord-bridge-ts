import type {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {usingInitializedStore,withStoreTransaction,commitStore} from './owned-scope.ts';
import {receiptRow,receiptText,receiptTextColumns,receiptExists} from './delivery-receipt-key.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {requireDiscordText} from '../discord/text.ts';
import {rustTrim} from '../app-server/value.ts';
/** Exact source durable reservation; no expiry or automatic retry. Caller owns
 * verified archive scope and original-ingress exclusion authority. */
export async function reserveArchiveScope(path:string,input:readonly string[],own:string|null):Promise<string>{
 requireDiscordText(path);if(own!==null)requireDiscordText(own);const snapshot=cloneOwnedSerdeValue(input);
 if(!Array.isArray(snapshot))throw new TypeError('Expected archive scope');for(const id of snapshot)requireDiscordText(id);
 const scope=[...new Set(snapshot as string[])].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
 if(scope.length===0||scope.some(id=>id===''||rustTrim(id)!==id))throw new StoreIntegrityError('invalid archive reservation scope');
 return usingInitializedStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{
  for(const target of scope){
   const blocked=unfinishedIn(db,target,own);
   if(blocked!==null)throw new StoreIntegrityError(`archive reservation refused: unfinished request ${blocked} is preserved; no archive was sent`);
   const occupied=receiptExists(db,`SELECT EXISTS(SELECT 1 FROM codex_archive_fences WHERE target_thread_id=?1)
    OR EXISTS(SELECT 1 FROM codex_turn_queue WHERE target_thread_id=?1)
    OR EXISTS(SELECT 1 FROM codex_prompt_intakes WHERE target_thread_id=?1) AS held`,target);
   if(occupied)throw new StoreIntegrityError(`archive reservation refused: ${target} has work or an existing archive fence; no archive was sent`);
  }
  const operation=randomUUID();for(const target of scope)db.prepare("INSERT INTO codex_archive_fences(target_thread_id,operation_id,own_ingress_id,phase) VALUES(?,?,?,'attempted')").run(target,operation,own);
  return commitStore(operation);
 }));
}
export async function archiveTargetFenced(path:string,target:string):Promise<boolean>{
 requireDiscordText(path);requireDiscordText(target);return usingInitializedStore(path,db=>receiptExists(db,'SELECT EXISTS(SELECT 1 FROM codex_archive_fences WHERE target_thread_id=?) AS held',target));
}
/** Only after every scope member is confirmed archived. Fences/held ingress stay. */
export async function markArchiveVerified(path:string,operation:string):Promise<void>{
 requireDiscordText(path);requireDiscordText(operation);return usingInitializedStore(path,db=>{if(BigInt(db.prepare("UPDATE codex_archive_fences SET phase='verified' WHERE operation_id=? AND phase='attempted'").run(operation).changes)===0n)throw new StoreIntegrityError('missing attempted archive reservation');});
}
/** Caller must prove rejection BEFORE effect; never call for timeout/disconnect.
 * Releases this attempted operation only, never requeues separately held ingress. */
export async function releaseRejectedArchive(path:string,operation:string):Promise<void>{
 requireDiscordText(path);requireDiscordText(operation);return usingInitializedStore(path,db=>{if(BigInt(db.prepare("DELETE FROM codex_archive_fences WHERE operation_id=? AND phase='attempted'").run(operation).changes)===0n)throw new StoreIntegrityError('missing rejected archive reservation');});
}

function unfinishedIn(db:DatabaseSync,target:string,own:string|null):string|null{
 const blocked=receiptRow(db,`SELECT ingress_id,${receiptTextColumns('ingress_id')} FROM discord_ingress_journal
    WHERE (target_thread_id=?1 OR target_thread_id IS NULL)
    AND state!='completed' AND NOT(state='owned' AND confirmation_delivered=1)
    AND (?2 IS NULL OR ingress_id!=?2) ORDER BY created_at,ingress_id LIMIT 1`,target,own);
 return blocked===undefined?null:receiptText(blocked,'ingress_id');
}
export async function unfinishedArchiveRequest(path:string,target:string,own:string|null):Promise<string|null>{
 requireDiscordText(path);requireDiscordText(target);if(own!==null)requireDiscordText(own);return usingInitializedStore(path,db=>unfinishedIn(db,target,own));
}
