import type {DatabaseSync} from "node:sqlite";
import {selectDelivery,type StoredDelivery} from "./delivery.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {parseSerdeStruct,type StructShape} from "../core/serde-struct-json.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {serdeValueEqual} from "../core/serde-value-equal.ts";
import {decodeI64,decodeOptionalI64} from "./sqlite-values.ts";
import {parseReceiptKey,receiptHash,receiptRow,receiptText,receiptTextColumns,receiptExists,type DeliveryGuard} from "./delivery-receipt-key.ts";
interface FinalRecoveryRequest {delivery_id:string;job_id:string;thread_id:string;turn_id:string;channel_id:bigint;original_sha256:string;ingress_id:string;error_receipt_key:string;error_message_id:string;error_sha256:string}
interface Grant {request:FinalRecoveryRequest;content_sha256:string;chunks:string[];ingress:unknown}
const REQUEST:StructShape={fields:[["delivery_id","string"],["job_id","string"],["thread_id","string"],["turn_id","string"],["channel_id","i64"],["original_sha256","string"],["ingress_id","string"],["error_receipt_key","string"],["error_message_id","string"],["error_sha256","string"]]};
const GRANT:StructShape={fields:[["request",REQUEST],["content_sha256","string"],["chunks","string[]"],["ingress","value"]]};
function invalid(reason:string):never{throw new StoreIntegrityError(reason);}
function read(db:DatabaseSync,id:string):Grant|null{
  const row=receiptRow(db,`SELECT grant_json,${receiptTextColumns("grant_json")} FROM cdr_final_recovery WHERE delivery_id=?`,id);
  return row===undefined?null:parseSerdeStruct(receiptText(row,"grant_json")!,GRANT) as unknown as Grant;
}
function identity(p:StoredDelivery,r:FinalRecoveryRequest):void{
  if(p.deliveryId!==r.delivery_id||p.jobId!==r.job_id||p.targetThreadId!==r.thread_id||p.turnId!==r.turn_id||p.channelId!==r.channel_id)invalid("saved final owner or destination changed");
}
function progressClear(db:DatabaseSync,p:StoredDelivery):void{
  if(receiptExists(db,"SELECT EXISTS(SELECT 1 FROM codex_commentary_outbox WHERE job_id=?1) OR EXISTS(SELECT 1 FROM codex_goal_progress WHERE job_id=?1 OR (job_id IS NULL AND thread=?2)) AS held",p.jobId,p.targetThreadId))invalid("saved final held behind undelivered progress");
}
function evidence(db:DatabaseSync,r:FinalRecoveryRequest):unknown{
  const textKeys=["ingress_id","kind","target_thread_id","state","canonical_owner","payload_json"],q=db.prepare(`SELECT ingress_id,kind,event_id,channel_id,owner_user_id,target_thread_id,state,confirmation_delivered,canonical_owner,payload_json,
    ${receiptTextColumns(...textKeys)} FROM discord_ingress_journal WHERE owner_kind='prompt' AND owner_id=? ORDER BY created_at,ingress_id`);q.setReadBigInts(true);
  const owners=q.all(r.job_id).map(row=>({id:receiptText(row,"ingress_id")!,kind:receiptText(row,"kind")!,event:decodeOptionalI64(row.event_id,"event_id"),channel:decodeI64(row.channel_id,"channel_id"),
    actor:decodeI64(row.owner_user_id,"owner_user_id"),thread:receiptText(row,"target_thread_id",true),state:receiptText(row,"state")!,confirmed:decodeI64(row.confirmation_delivered,"confirmation_delivered")!==0n,canonical:receiptText(row,"canonical_owner",true),payload:receiptText(row,"payload_json")!}));
  if(owners.length!==1)invalid("recovery requires one unambiguous canonical ingress");const ingress=owners[0]!,event=ingress.event;if(event===null)invalid("recovery source event missing");
  const key=serializeSerdeValue([r.channel_id,"message/error/v1",`inbound-message/${event}/error-report`,0n]);
  if(ingress.id!==r.ingress_id||ingress.kind!=="message"||ingress.channel!==r.channel_id||ingress.thread!==r.thread_id||ingress.confirmed!==false||(ingress.state!=="owned"&&ingress.state!=="completed")||key!==r.error_receipt_key)invalid("recovery source is not this exact failed original request");
  const row=receiptRow(db,`SELECT content_hash,message_id,${receiptTextColumns("content_hash","message_id")} FROM codex_delivery_receipts WHERE receipt_key=?`,key);
  if(row===undefined||receiptText(row,"content_hash")!==r.error_sha256||receiptText(row,"message_id",true)!==r.error_message_id||r.error_message_id==="")invalid("original error report is not exactly confirmed");
  const mapping=db.prepare(`SELECT codex_thread_id,${receiptTextColumns("codex_thread_id")} FROM mirror_threads WHERE discord_thread_id=?`).all(r.channel_id).map(row=>receiptText(row,"codex_thread_id")!);
  if(mapping.length!==1||mapping[0]!==r.thread_id)invalid("recovery destination no longer owns this thread");
  if(receiptExists(db,"SELECT EXISTS(SELECT 1 FROM codex_turn_queue WHERE job_id=?) AS held",r.job_id))invalid("original job still has executable or uncertain queue custody");return ingress;
}
function validate(db:DatabaseSync,pending:StoredDelivery,grant:Grant):void{
  identity(pending,grant.request);const actual=selectDelivery(db,pending.deliveryId);identity(actual,grant.request);
  if(receiptHash(pending.content)!==grant.content_sha256||receiptHash(actual.content)!==grant.content_sha256||!serdeValueEqual(evidence(db,grant.request),grant.ingress))invalid("recovery evidence or frozen payload changed");progressClear(db,pending);
}
/** Validate an existing grant only. This API never creates publication authorization. */
export function finalRecoveryAuthorizedIn(db:DatabaseSync,pending:StoredDelivery):boolean{const grant=read(db,pending.deliveryId);if(grant===null)return false;validate(db,pending,grant);return true;}
export function validateFinalRecoveryClaimIn(db:DatabaseSync,key:string,hash:string,guard:DeliveryGuard|null):void{
  const parsed=parseReceiptKey(key);if(parsed===null||parsed[1]!=="completion/v1")return;const [channel,,id,index]=parsed,grant=read(db,id);if(grant===null)return;
  const pending=selectDelivery(db,id);validate(db,pending,grant);
  if(guard===null||guard.jobId!==pending.jobId||guard.threadId!==pending.targetThreadId||guard.turnId!==pending.turnId||channel!==pending.channelId||index>=BigInt(grant.chunks.length)||grant.chunks[Number(index)]!==hash)invalid("recovery chunk identity or payload changed");
}
