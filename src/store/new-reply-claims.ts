import {requireDiscordText} from '../discord/text.ts';
import {decodeI64} from "./sqlite-values.ts";
import type {DatabaseSync} from "node:sqlite";
import {getIn,type NewReply} from "./new-reply-read.ts";
import {openInitialized} from "./owned-driver.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {mirroredThreadIdIn} from "./busy-choice.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {parseReceiptKey,receiptHash,receiptRow,receiptExists,receiptText,receiptTextColumns,type DeliveryGuard} from "./delivery-receipt-key.ts";
import {validateReserveStartClaimIn,validateReserveTransitionClaimIn} from "./reserve-notice-claims.ts";
export function newReplyAcknowledgementKey(record:NewReply):string{
  const id=record.identity;if(id.event_id===null)throw new StoreIntegrityError("new acknowledgement has no event identity");
  if(id.kind==="action")throw new StoreIntegrityError("headless new has no Discord acknowledgement");
  return serializeSerdeValue([id.origin_channel_id,id.kind==="message"?"message/reply/v1":"interaction/initial/v1",id.kind==="message"?`inbound-message/${id.event_id}/action-result`:`interaction/${id.event_id}`,0n]);
}
export function validateNewReplyIdentityIn(db:DatabaseSync,record:NewReply):void{
  const id=record.identity;
  const matches=receiptExists(db,`SELECT EXISTS(SELECT 1 FROM discord_ingress_journal WHERE ingress_id=? AND owner_kind='prompt' AND owner_id=? AND target_thread_id=? AND channel_id=?
    AND json_extract(outcome_json,'$.new_creation.version')=1 AND json_extract(outcome_json,'$.new_creation.cwd')=? AND json_extract(outcome_json,'$.new_verification.thread_id')=?
    AND json_extract(outcome_json,'$.new_verification.channel_id')=? AND json_extract(outcome_json,'$.new_verification.prompt_sha256')=? AND phase<>'cancelled') AS held`,id.ingress_id,id.job_id,id.thread_id,id.origin_channel_id,id.cwd,id.thread_id,id.channel_id,id.prompt_sha256);
  const mapping=mirroredThreadIdIn(db,id.channel_id);if(!matches||mapping!==id.thread_id)throw new StoreIntegrityError("new first-reply evidence or original room mapping changed; no message sent");
}
/** Source validate_current: absence is allowed; present identity must remain exact. */
export async function validateNewReplyCurrent(path:string,job:string):Promise<void>{
  requireDiscordText(path);requireDiscordText(job);const db=await openInitialized(path);try{const record=getIn(db,job);if(record!==null)validateNewReplyIdentityIn(db,record);}finally{db.close();}
}
function readiness(record:NewReply):string|null{
  if(record.state!=="verified")return `new first input verification is ${record.state}; output remains saved: ${record.lastError}`;
  if(!record.confirmationDelivered&&record.identity.kind!=="action")return "new first reply is not confirmed; output remains saved";return null;
}
export function newReplyOutputHoldIn(db:DatabaseSync,job:string):string|null{const record=getIn(db,job);if(record===null)return null;validateNewReplyIdentityIn(db,record);return readiness(record);}
export async function newReplyOutputHold(path:string,job:string):Promise<string|null>{const db=await openInitialized(path);try{return newReplyOutputHoldIn(db,job);}finally{db.close();}}
function rustI64(text:string):bigint|null{
  const matched=/^[+-]?[0-9]+/u.exec(text);if(matched===null||matched[0]!==text)return null;
  const negative=text[0]==="-",start=text[0]==="-"||text[0]==="+"?1:0,limit=negative?1n<<63n:(1n<<63n)-1n;let result=0n;
  for(let i=start;i<text.length;i++){result=result*10n+BigInt(text.charCodeAt(i)-48);if(result>limit)return null;}return negative?-result:result;
}
function acknowledgementForKey(db:DatabaseSync,key:string):NewReply|null{
  const parsed=parseReceiptKey(key);if(parsed===null)return null;const [channel,domain,logical,part]=parsed;
  if(part!==0n||(domain!=="message/reply/v1"&&domain!=="interaction/initial/v1"))return null;
  const raw=domain==="message/reply/v1"?(logical.startsWith("inbound-message/")&&logical.endsWith("/action-result")?logical.slice(16,-14):null):(logical.startsWith("interaction/")?logical.slice(12):null);
  const event=raw===null?null:rustI64(raw);if(event===null)return null;
  const row=receiptRow(db,`SELECT job_id,${receiptTextColumns("job_id")} FROM codex_new_first_replies WHERE json_extract(identity_json,'$.origin_channel_id')=? AND json_extract(identity_json,'$.event_id')=?`,channel,event);
  return row===undefined?null:getIn(db,receiptText(row,"job_id")!);
}
export function newReplyWarningText(record:NewReply):string{return `확인 대기\n새 대화의 첫 입력 저장 또는 접수 답장 확인이 지연되고 있습니다. 작업과 답변은 보존하며 다시 실행하지 않습니다.\n새 대화: <#${record.identity.channel_id}>\njob_id: ${record.identity.job_id}`;}
function validateNoticeIn(db:DatabaseSync,key:string,hash:string):void{
  const parsed=parseReceiptKey(key);if(parsed===null||parsed[1]!=="new/verification-notice/v1")return;const [channel,,job,part]=parsed,record=getIn(db,job);
  if(record===null)throw new StoreIntegrityError("new warning has no original intent");
  const owner=receiptExists(db,"SELECT EXISTS(SELECT 1 FROM discord_ingress_journal WHERE ingress_id=? AND owner_id=? AND channel_id=?) AS held",record.identity.ingress_id,job,channel);
  if(!owner||channel!==record.identity.origin_channel_id||part!==0n||record.warningDue===0n||receiptHash(newReplyWarningText(record))!==hash)throw new StoreIntegrityError("new warning identity changed; no notice sent");
}
export function validateNewReplyClaimIn(db:DatabaseSync,key:string,hash:string,guard:DeliveryGuard|null):string|null{
  validateNoticeIn(db,key,hash);validateReserveTransitionClaimIn(db,key,hash);
  const reserved=validateReserveStartClaimIn(db,key,hash);
  if(reserved!==null){const record=getIn(db,reserved);if(record!==null){validateNewReplyIdentityIn(db,record);const parsed=parseReceiptKey(key)!;
    if(record.turnId!==null||record.identity.channel_id!==parsed[0])throw new StoreIntegrityError("Reserve no-turn failure notice has a changed /new identity");}}
  if(guard!==null){const record=getIn(db,guard.jobId);if(record!==null){
    validateNewReplyIdentityIn(db,record);const parsed=parseReceiptKey(key);if(parsed===null)throw new SyntaxError("Expected typed delivery receipt key");const channel=parsed[0];
    if(record.identity.thread_id!==guard.threadId||record.identity.channel_id!==channel||guard.turnId==="")throw new StoreIntegrityError("new output claim changed its original destination");
    if(record.turnId!==guard.turnId&&!receiptExists(db,`SELECT EXISTS(SELECT 1 FROM codex_delivery_outbox WHERE job_id=?1 AND target_thread_id=?2 AND turn_id=?3 AND channel_id=?4)
      OR EXISTS(SELECT 1 FROM codex_goal_progress WHERE job_id=?1 AND thread=?2 AND turn=?3 AND channel=?4)
      OR EXISTS(SELECT 1 FROM codex_commentary_outbox WHERE job_id=?1 AND target_thread_id=?2 AND turn_id=?3 AND channel_id=?4) AS held`,guard.jobId,guard.threadId,guard.turnId,channel))throw new StoreIntegrityError("new output claim has no exact-turn ownership evidence");
    const hold=readiness(record);if(hold!==null)return hold;
  }}
  const record=acknowledgementForKey(db,key);if(record!==null){validateNewReplyIdentityIn(db,record);
    if(newReplyAcknowledgementKey(record)!==key||receiptHash(record.identity.acknowledgement)!==hash)throw new StoreIntegrityError("new acknowledgement identity/body changed; no POST attempted");
    if(record.turnId===null)return "new turn acceptance is uncertain; normal acknowledgement is not authorized";
  }
  return null;
}
export function confirmNewReplyReceiptIn(db:DatabaseSync,key:string):void{
  const record=acknowledgementForKey(db,key);if(record===null)return;validateNewReplyIdentityIn(db,record);
  if(!receiptExists(db,"SELECT EXISTS(SELECT 1 FROM codex_delivery_receipts WHERE receipt_key=? AND content_hash=? AND message_id IS NOT NULL) AS held",key,receiptHash(record.identity.acknowledgement)))throw new StoreIntegrityError("new acknowledgement receipt is not confirmed");
  db.prepare("UPDATE codex_new_first_replies SET confirmation_delivered=1 WHERE job_id=?").run(record.identity.job_id);
  db.prepare("UPDATE discord_ingress_journal SET confirmation_delivered=1 WHERE ingress_id=? AND owner_id=?").run(record.identity.ingress_id,record.identity.job_id);
}
export function newReplyNoticeClaimedIn(db:DatabaseSync,key:string):void{const parsed=parseReceiptKey(key);if(parsed!==null&&parsed[1]==="new/verification-notice/v1")db.prepare("UPDATE codex_new_first_replies SET warning_due=2 WHERE job_id=?").run(parsed[2]);}
export function newReplyNoticeRejectedIn(db:DatabaseSync,key:string):void{const parsed=parseReceiptKey(key);if(parsed!==null&&parsed[1]==="new/verification-notice/v1")db.prepare("UPDATE codex_new_first_replies SET warning_due=1 WHERE job_id=? AND warning_due=2").run(parsed[2]);}

export async function newReplyAcknowledgementSendable(path:string,record:NewReply):Promise<boolean>{
  if(!record.acknowledgementRecoveryAllowed)return false;const key=newReplyAcknowledgementKey(record),db=await openInitialized(path);
  try{const row=receiptRow(db,`SELECT message_id,retryable,blocked_reason,${receiptTextColumns("message_id","blocked_reason")} FROM codex_delivery_receipts WHERE receipt_key=?`,key);
    if(row===undefined)return true;const message=receiptText(row,"message_id",true),retryable=decodeI64(row.retryable,"retryable")!==0n,blocked=receiptText(row,"blocked_reason",true);
    return message!==null||(retryable&&blocked===null);
  }finally{db.close();}
}
export async function releaseNewReplyAcknowledgement(path:string,ingress:string):Promise<void>{
  if(typeof ingress!=="string"||/[\uD800-\uDFFF]/u.test(ingress))throw new TypeError("Expected well-formed text");
  const db=await openInitialized(path);try{db.prepare("UPDATE codex_new_first_replies SET ack_recovery_allowed=1 WHERE ingress_id=? AND confirmation_delivered=0").run(ingress);}finally{db.close();}
}
