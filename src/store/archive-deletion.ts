import type {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {requireDiscordText} from '../discord/text.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {usingExistingStore,withStoreTransaction,commitStore} from './owned-scope.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
import {containerI64} from './mirror-container-creation.ts';
import {decodeI64} from './sqlite-values.ts';
import {receiptExists,receiptRow,receiptText,receiptTextColumns} from './delivery-receipt-key.ts';
import {roomCleanupPendingReasonIn} from './room-cleanup-pending.ts';
export interface ArchiveDeletionConfirmation{readonly messageId:bigint;readonly channelId:bigint;readonly userId:bigint;readonly reference:string;}
function capture(input:ArchiveDeletionConfirmation|null):ArchiveDeletionConfirmation|null{
 if(input===null)return null;const messageId=own(input,'messageId'),channelId=own(input,'channelId'),userId=own(input,'userId'),reference=own(input,'reference');containerI64(messageId as bigint);containerI64(channelId as bigint);containerI64(userId as bigint);requireDiscordText(reference);return Object.freeze({messageId:messageId as bigint,channelId:channelId as bigint,userId:userId as bigint,reference});
}
/** Borrowed IMMEDIATE transaction. Confirmation exclusion applies only to the
 * exact original ingress; every other pending-work protection remains active.
 * A durable token does not authorize filesystem deletion or automatic retry. */
export function beginArchiveDeletionIn(db:DatabaseSync,target:string,now:number,input:ArchiveDeletionConfirmation|null):string{
 requireDiscordText(target);const confirmation=capture(input);if(!db.isTransaction)throw new StoreIntegrityError('Archive deletion requires owning transaction');
 if(target===''||typeof now!=='number'||!Number.isFinite(now))throw new StoreIntegrityError('invalid archive deletion identity');
 const ingress=confirmation===null?null:`message:${confirmation.messageId}`;
 if(confirmation!==null&&!receiptExists(db,"SELECT EXISTS(SELECT 1 FROM discord_ingress_journal WHERE ingress_id=?1 AND kind='message' AND event_id=?2 AND channel_id=?3 AND owner_user_id=?4 AND state='executing' AND json_extract(payload_json,'$.plan.Execute.DeleteArchiveConfirm.reference')=?5) AS held",ingress,confirmation.messageId,confirmation.channelId,confirmation.userId,confirmation.reference))throw new StoreIntegrityError('archive confirmation custody identity changed');
 const query=db.prepare('SELECT discord_thread_id FROM mirror_threads WHERE codex_thread_id=? LIMIT 4097');query.setReadBigInts(true);const rooms:bigint[]=[];
 for(const row of query.iterate(target)){if(rooms.length>=4096)throw new StoreIntegrityError('Archive room evidence budget exceeded');rooms.push(decodeI64(row.discord_thread_id,'discord_thread_id'));}
 for(const channel of [0n,...rooms]){const reason=roomCleanupPendingReasonIn(db,channel,target,ingress);if(reason!==null)throw new StoreIntegrityError(`archive deletion protected by ${reason}`);}
 const token=randomUUID(),channels=serializeSerdeValue(rooms);
 const inserted=db.prepare("INSERT INTO cdr_archive_fences(target_thread_id,token,channels,phase,created_at) VALUES(?,?,?,'deleting',?)").run(target,token,channels,now).changes;
 const row=receiptRow(db,`SELECT token,channels,phase,${receiptTextColumns('token','channels','phase')} FROM cdr_archive_fences WHERE target_thread_id=?`,target);
 if(BigInt(inserted)!==1n||row===undefined||receiptText(row,'token')!==token||receiptText(row,'channels')!==channels||receiptText(row,'phase')!=='deleting')throw new StoreIntegrityError('archive deletion fence intent was not stored exactly');return token;
}
/** Existing-only runtime boundary; caller must invoke from a native worker. */
export function beginArchiveDeletionExisting(path:string,target:string,now:number,input:ArchiveDeletionConfirmation|null):string{
 requireDiscordText(path);const confirmation=capture(input);return usingExistingStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>commitStore(beginArchiveDeletionIn(db,target,now,confirmation))),100);
}
export function completeArchiveDeletionIn(db:DatabaseSync,target:string,token:string):void{
 requireDiscordText(target);requireDiscordText(token);const count=db.prepare("UPDATE cdr_archive_fences SET phase='deleted' WHERE target_thread_id=? AND token=? AND phase='deleting'").run(target,token).changes;
 if(BigInt(count)!==1n)throw new StoreIntegrityError('archive deletion fence ownership changed');
}
export function completeArchiveDeletionExisting(path:string,target:string,token:string):void{requireDiscordText(path);return usingExistingStore(path,db=>completeArchiveDeletionIn(db,target,token),100);}
export interface ArchivedMirrorDeleteCounts {readonly mirrorThreads:bigint;readonly sessionMirrorOffsets:bigint;}
/** Run only after the source archive deletion and its postconditions succeed.
 * The durable token is rechecked in the same owning transaction as both deletes.
 * Failure leaves the outer archive fence in deleting for explicit recovery. */
export function deleteArchivedMirrorStateIn(db:DatabaseSync,target:string,token:string):ArchivedMirrorDeleteCounts{
 requireDiscordText(target);requireDiscordText(token);if(!db.isTransaction)throw new StoreIntegrityError('Archive mapping deletion requires owning transaction');
 if(!receiptExists(db,"SELECT EXISTS(SELECT 1 FROM cdr_archive_fences WHERE target_thread_id=? AND token=? AND phase='deleting') AS held",target,token))throw new StoreIntegrityError('archive deletion fence ownership changed');
 const mirrorThreads=BigInt(db.prepare('DELETE FROM mirror_threads WHERE codex_thread_id=?').run(target).changes);
 const sessionMirrorOffsets=BigInt(db.prepare('DELETE FROM codex_session_mirror_offsets WHERE codex_thread_id=?').run(target).changes);
 if(receiptExists(db,'SELECT EXISTS(SELECT 1 FROM mirror_threads WHERE codex_thread_id=?1 UNION ALL SELECT 1 FROM codex_session_mirror_offsets WHERE codex_thread_id=?1) AS held',target))throw new StoreIntegrityError('archive mapping deletion postcondition failed');
 return Object.freeze({mirrorThreads,sessionMirrorOffsets});
}
export function deleteArchivedMirrorStateExisting(path:string,target:string,token:string):ArchivedMirrorDeleteCounts{
 requireDiscordText(path);return usingExistingStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>commitStore(deleteArchivedMirrorStateIn(db,target,token))),100);
}
