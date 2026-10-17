import type {DatabaseSync} from 'node:sqlite';
import {requireDiscordText} from '../discord/text.ts';
import {getIn,type NewReply} from './new-reply-read.ts';
import {usingInitializedStore,withStoreTransaction,commitStore} from './owned-scope.ts';
import {decodeI64,decodeTextField,textDecoderFor} from './sqlite-values.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
const ROW_BYTES=1048576n,BATCH_BYTES=4194304n,KEY_BYTES=16384;
function limitValue(value:number):number{if(!Number.isSafeInteger(value)||value<0)throw new TypeError('Expected nonnegative safe new reply limit');return Math.min(value,32);}
const costSql="SELECT COALESCE(length(CAST(identity_json AS BLOB)),0)+COALESCE(length(CAST(turn_id AS BLOB)),0)+COALESCE(length(CAST(state AS BLOB)),0)+COALESCE(length(CAST(scan_json AS BLOB)),0)+COALESCE(length(CAST(last_error AS BLOB)),0) AS bytes FROM codex_new_first_replies WHERE job_id=?";
/** Bounded source pending discovery in one read snapshot. Whole-batch rejection
 * on a text budget breach, never silently omit a held request. 32 rows maximum,
 * 1 MiB persisted text per row and 4 MiB total, plus bounded job keys. These are
 * returned-data budgets, not SQLite internal scan/memory or wall-time limits.
 * This synchronous leaf still needs native hosting for the runtime worker. */
export function pendingNewRepliesIn(db:DatabaseSync,inputLimit:number):NewReply[]{
 const limit=limitValue(inputLimit);
 return withStoreTransaction(db,'DEFERRED',()=>{
  const keys=db.prepare("SELECT CASE WHEN length(CAST(job_id AS BLOB))<=?2 THEN job_id END AS job,CASE WHEN length(CAST(job_id AS BLOB))<=?2 THEN CAST(job_id AS BLOB) END AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM codex_new_first_replies WHERE turn_id IS NOT NULL AND (state<>'verified' OR confirmation_delivered=0 OR warning_due=1) ORDER BY checked_at,job_id LIMIT ?1").all(limit,KEY_BYTES);
  const records:NewReply[]=[];let total=0n;
  const cost=db.prepare(costSql);cost.setReadBigInts(true);
  for(const key of keys){
   if(key.job===null||key.raw===null)throw new StoreIntegrityError('new reply pending job key exceeds budget');
   const job=decodeTextField(key.job,key.raw,'job_id',false,textDecoderFor(key.encoding))!;
   const row=cost.get(job);if(row===undefined)continue;
   const bytes=decodeI64(row.bytes,'new reply persisted text size');if(bytes<0n||bytes>ROW_BYTES||total+bytes>BATCH_BYTES)throw new StoreIntegrityError('new reply pending text budget exceeded; no partial batch');
   total+=bytes;const record=getIn(db,job);if(record!==null)records.push(record);
  }
  return commitStore(records);
 });
}
export async function pendingNewReplies(path:string,limit:number):Promise<NewReply[]>{requireDiscordText(path);const pinned=limitValue(limit);return usingInitializedStore(path,db=>pendingNewRepliesIn(db,pinned));}

/** Exact original job read, including verified rows no longer in pending().
 * The byte probe and decode share one read snapshot; no fallback by ingress. */
export function getNewReplyBoundedIn(db:DatabaseSync,job:string):NewReply|null{
 requireDiscordText(job);if(Buffer.byteLength(job)>KEY_BYTES)throw new RangeError('New reply job identity exceeds budget');
 return withStoreTransaction(db,'DEFERRED',()=>{
  const query=db.prepare(costSql);query.setReadBigInts(true);const row=query.get(job);if(row===undefined)return commitStore(null);
  const bytes=decodeI64(row.bytes,'new reply persisted text size');if(bytes<0n||bytes>ROW_BYTES)throw new StoreIntegrityError('new reply exact row exceeds text budget');
  return commitStore(getIn(db,job));
 });
}
export async function getNewReplyBounded(path:string,job:string):Promise<NewReply|null>{requireDiscordText(path);requireDiscordText(job);if(Buffer.byteLength(job)>KEY_BYTES)throw new RangeError('New reply job identity exceeds budget');return usingInitializedStore(path,db=>getNewReplyBoundedIn(db,job));}
