import {StoreIntegrityError} from './schema-assembly.ts';
import type {DatabaseSync} from 'node:sqlite';
import {asyncResolutionHeldIn} from './async-resolution-admission.ts';
import {receiptExists} from './delivery-receipt-key.ts';
import {textDecoderFor} from './sqlite-values.ts';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {requireDiscordText} from '../discord/text.ts';
import {containerI64} from './mirror-container-creation.ts';
import {usingExistingReadOnlyStore,withStoreTransaction,rollbackStore} from './owned-scope.ts';
function hasTable(db:DatabaseSync,name:string):boolean {return receiptExists(db,"SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?) AS held",name);}
/** First-match protection reason. The caller supplies its own transaction.
 * An optional table may be absent only where the Rust contract permits it;
 * present malformed tables and native query failures are never absence. */
export function roomCleanupPendingReasonIn(db:DatabaseSync,channel:bigint,target:string|null,confirmation:string|null=null,allowPreCommentarySchema=false,excluded:readonly string[]=[]):string|null {
 containerI64(channel);if(target!==null)requireDiscordText(target);if(confirmation!==null)requireDiscordText(confirmation);if(typeof allowPreCommentarySchema!=='boolean')throw new TypeError('Expected legacy schema switch');
 const omitted=cloneOwnedSerdeValue(excluded);if(!Array.isArray(omitted))throw new TypeError('Expected ingress exclusions');for(const item of omitted)requireDiscordText(item);
 if(target!==null&&asyncResolutionHeldIn(db,target))return 'unresolved async execution or recovery authorization';
 if(hasTable(db,'cdr_async_execution_obligations')&&receiptExists(db,'SELECT EXISTS(SELECT 1 FROM cdr_async_unsettled_obligations WHERE channel_id=?) AS held',channel))return 'unresolved async execution or recovery authorization';
 if(hasTable(db,'cdr_async_questions')&&receiptExists(db,"SELECT EXISTS(SELECT 1 FROM cdr_async_questions WHERE (channel_id=?1 OR thread_id=?2) AND state IN ('observed','open','dispatching')) AS held",channel,target))return 'unanswered or unconfirmed async question';
 if(hasTable(db,'cdr_async_question_inbox')&&receiptExists(db,"SELECT EXISTS(SELECT 1 FROM cdr_async_question_inbox WHERE (candidate_channel_id=?1 OR thread_id=?2) AND state='waiting') AS held",channel,target))return 'unbound async question awaiting original ownership';
 if(hasTable(db,'cdr_idle_release')&&receiptExists(db,"SELECT EXISTS(SELECT 1 FROM cdr_idle_release WHERE (?1 IS NULL OR thread_id=?1) AND state NOT IN ('Candidate','Settled')) AS held",target))return 'unsettled idle subscription release';
 const checks=[['queued requests','codex_turn_queue',''],['prompt intake','codex_prompt_intakes',''],['ingress','discord_ingress_journal',`AND CASE WHEN state='completed' AND confirmation_delivered=1 THEN 0 WHEN state='owned' AND confirmation_delivered=1 AND owner_kind='prompt' AND length(trim(owner_id))>0 THEN 0 ELSE 1 END`],['undelivered result','codex_delivery_outbox',''],['undelivered progress','codex_commentary_outbox',''],['busy choice','busy_choices',"AND claimed_at IS NULL AND expires_at > unixepoch()"]] as const;
 for(const [reason,table,extra] of checks){
  if(allowPreCommentarySchema&&table==='codex_commentary_outbox'&&!hasTable(db,table))continue;
  const where=`SELECT EXISTS(SELECT 1 FROM ${table} WHERE (channel_id=?1 OR (?2 IS NOT NULL AND target_thread_id=?2)) ${extra}`;
  const held=table==='discord_ingress_journal'?receiptExists(db,where+' AND (?3 IS NULL OR ingress_id!=?3) AND ingress_id NOT IN (SELECT value FROM json_each(?4))) AS held',channel,target,confirmation,serializeSerdeValue(omitted)):receiptExists(db,where+') AS held',channel,target);
  if(held)return reason;
 }
 if(receiptExists(db,'SELECT EXISTS(SELECT 1 FROM codex_goal_progress WHERE channel=?1 OR (?2 IS NOT NULL AND thread=?2)) AS held',channel,target))return 'undelivered goal progress';
 // Decode each receipt only when reached. Later invalid UTF-8 cannot defeat an
 // earlier protection reason, as Rust query_map decodes one row at a time.
 const q=db.prepare('SELECT typeof(receipt_key) AS kind,CAST(receipt_key AS BLOB) AS bytes FROM codex_delivery_receipts WHERE message_id IS NULL');q.setReadBigInts(true);let decoder:ReturnType<typeof textDecoderFor>|undefined;
 for(const row of q.iterate()){
  decoder??=textDecoderFor(db.prepare('PRAGMA encoding').get()?.encoding);
  // Enforce TEXT storage class; bytes are decoded lazily here.
  let text:string;
  if(row.kind!=='text'||!(row.bytes instanceof Uint8Array))throw new StoreIntegrityError('Expected SQLite TEXT for receipt_key');
  else {try{text=decoder.decode(row.bytes);}catch{throw new StoreIntegrityError('Invalid SQLite text encoding for receipt_key');}}
  let parsed:unknown;try{parsed=parseSerdeValue(text);}catch{parsed=undefined;}
  const id=Array.isArray(parsed)?parsed[0]:undefined;
  if(typeof id!=='bigint'||id<-(1n<<63n)||id>=1n<<63n)return 'unattributable delivery receipt (invalid or missing channel identity)';
  if(id===channel)return 'unsettled delivery receipt (unknown, retryable or blocked)';
 }
 return null;
}
export function roomCleanupPendingReasonReadonly(path:string,channel:bigint,target:string|null,allowPreCommentarySchema=false):string|null {
 requireDiscordText(path);return usingExistingReadOnlyStore(path,db=>withStoreTransaction(db,'DEFERRED',()=>rollbackStore(roomCleanupPendingReasonIn(db,channel,target,null,allowPreCommentarySchema))));
}
