import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {usingInitializedStore,withStoreTransaction,commitStore} from './owned-scope.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
import {receiptExists,receiptRow,receiptText,receiptTextColumns} from './delivery-receipt-key.ts';
import {decodeI64} from './sqlite-values.ts';
import {beforeIdleCleanupIn} from './idle-release-store.ts';
import {roomCleanupPendingReasonIn} from './room-cleanup-pending.ts';
import {containerI64,containerRecordsIn,expectedContainerMapping} from './mirror-container-creation.ts';
import {requireDiscordText} from '../discord/text.ts';
export class RoomCleanupProtectedError extends Error {
 readonly channel:bigint;readonly reason:string;
 constructor(channel:bigint,reason:string){super(`room ${channel} cleanup is protected: ${reason}`);this.name='RoomCleanupProtectedError';this.channel=channel;this.reason=reason;}
}
/** Creation custody is checked before cleanup identity/pending checks. Any
 * unresolved orphan creation conservatively protects targetless cleanup. */
function protectCreationIn(db:DatabaseSync,channel:bigint,target:string|null):void {
 if(receiptExists(db,'SELECT EXISTS(SELECT 1 FROM cdr_mirror_thread_creations WHERE thread_id=? OR parent_id=? OR channel_id=? OR (? IS NULL AND channel_id IS NULL)) AS held',target,channel,channel,target))throw new RoomCleanupProtectedError(channel,'unresolved mirror creation');
 const row=receiptRow(db,'SELECT discord_channel_id FROM mirror_threads WHERE codex_thread_id=?',target);const mapped=row===undefined?null:decodeI64(row.discord_channel_id,'discord_channel_id');
 for(const r of containerRecordsIn(db)){
  const previous=expectedContainerMapping(r);
  if(r.parent===channel||r.channel===channel||previous.some(([,id])=>id===channel||id===mapped)||(target===null&&r.channel===null))throw new RoomCleanupProtectedError(channel,'unresolved mirror container creation');
 }
}
/** Borrowed IMMEDIATE transaction; exclusions are only for the later separately
 * proved archived-Steer path. This public normal begin never supplies them. */
export function beginRoomCleanupIn(db:DatabaseSync,channel:bigint,target:string|null,now:number,excluded:readonly string[]=[]):string {
 if(!db.isTransaction)throw new StoreIntegrityError('Cleanup begin requires an owning transaction');
 protectCreationIn(db,channel,target);
 if(receiptExists(db,'SELECT EXISTS(SELECT 1 FROM cdr_cleanup_fences WHERE channel_id=?) AS held',channel))throw new StoreIntegrityError(`room ${channel} cleanup outcome is fenced; manual reconciliation required`);
 const q=db.prepare(`SELECT codex_thread_id,${receiptTextColumns('codex_thread_id')} FROM mirror_threads WHERE discord_thread_id=? OR discord_channel_id=?`);q.setReadBigInts(true);const mapped=q.all(channel,channel).map(row=>receiptText(row,'codex_thread_id')!);
 const matches=target===null?mapped.length===0:mapped.length===1&&mapped[0]===target;
 if(channel<=0n||!Number.isFinite(now)||!matches)throw new StoreIntegrityError('cleanup mapping identity changed or invalid');
 if(target!==null)beforeIdleCleanupIn(db,target);
 const reason=roomCleanupPendingReasonIn(db,channel,target,null,false,excluded);if(reason!==null)throw new RoomCleanupProtectedError(channel,reason);
 const token=randomUUID();const changed=db.prepare("INSERT INTO cdr_cleanup_fences(channel_id,target_thread_id,token,phase,created_at) VALUES(?,?,?,'deleting',?)").run(channel,target,token,now).changes;
 const stored=receiptRow(db,`SELECT target_thread_id,token,phase,${receiptTextColumns('target_thread_id','token','phase')} FROM cdr_cleanup_fences WHERE channel_id=?`,channel);
 if(BigInt(changed)!==1n||stored===undefined||receiptText(stored,'target_thread_id',true)!==target||receiptText(stored,'token')!==token||receiptText(stored,'phase')!=='deleting')throw new StoreIntegrityError('cleanup fence intent was not stored exactly');return token;
}
export async function beginRoomCleanup(path:string,channel:bigint,target:string|null,now:number):Promise<string> {
 requireDiscordText(path);containerI64(channel);if(target!==null)requireDiscordText(target);if(typeof now!=='number')throw new TypeError('Expected f64 cleanup timestamp');
 return usingInitializedStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>commitStore(beginRoomCleanupIn(db,channel,target,now))));
}
export async function completeRoomCleanup(path:string,channel:bigint,token:string):Promise<void> {
 requireDiscordText(path);containerI64(channel);requireDiscordText(token);return usingInitializedStore(path,db=>{const changed=db.prepare("UPDATE cdr_cleanup_fences SET phase='deleted' WHERE channel_id=? AND token=? AND phase='deleting'").run(channel,token).changes;if(BigInt(changed)!==1n)throw new StoreIntegrityError('cleanup fence ownership changed');});
}
/** Only the runtime's proved no-effect rejection may call this after dispatch. */
export async function releaseRejectedRoomCleanup(path:string,channel:bigint,token:string):Promise<void> {
 requireDiscordText(path);containerI64(channel);requireDiscordText(token);return usingInitializedStore(path,db=>{const changed=db.prepare("DELETE FROM cdr_cleanup_fences WHERE channel_id=? AND token=? AND phase='deleting'").run(channel,token).changes;if(BigInt(changed)!==1n)throw new StoreIntegrityError('cleanup fence ownership changed');});
}
export async function roomCleanupPhase(path:string,channel:bigint):Promise<string|null> {
 requireDiscordText(path);containerI64(channel);return usingInitializedStore(path,db=>{const row=receiptRow(db,`SELECT phase,${receiptTextColumns('phase')} FROM cdr_cleanup_fences WHERE channel_id=?`,channel);return row===undefined?null:receiptText(row,'phase')!;});
}
export async function roomCleanupConfirmedTarget(path:string,channel:bigint,target:string):Promise<boolean> {
 requireDiscordText(path);containerI64(channel);requireDiscordText(target);return usingInitializedStore(path,db=>receiptExists(db,"SELECT EXISTS(SELECT 1 FROM cdr_cleanup_fences WHERE channel_id=? AND target_thread_id=? AND phase='deleted') AS held",channel,target));
}
export async function unconfirmedRoomCleanupChannels(path:string):Promise<readonly bigint[]> {
 requireDiscordText(path);return usingInitializedStore(path,db=>{const q=db.prepare("SELECT channel_id FROM cdr_cleanup_fences WHERE phase='deleting' ORDER BY channel_id");q.setReadBigInts(true);return Object.freeze(q.all().map(row=>decodeI64(row.channel_id,'channel_id')));});
}

/** Exact unfinished intent ownership. Read-back does not create a new grant. */
export async function roomCleanupOwnsToken(path:string,channel:bigint,token:string):Promise<boolean> {
 requireDiscordText(path);containerI64(channel);requireDiscordText(token);
 return usingInitializedStore(path,db=>receiptExists(db,"SELECT EXISTS(SELECT 1 FROM cdr_cleanup_fences WHERE channel_id=? AND token=? AND phase='deleting') AS held",channel,token));
}
