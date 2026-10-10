import {types} from "node:util";
import type {DatabaseSync} from "node:sqlite";
import {openInitialized} from "./owned-driver.ts";
import {takeUnicodeScalarChars} from "./queue-preflight-failure.ts";
import {decodeI64} from "./sqlite-values.ts";
import {validateFinalRecoveryClaimIn} from "./final-recovery-claims.ts";
import {validateNewReplyClaimIn,confirmNewReplyReceiptIn,newReplyNoticeClaimedIn,newReplyNoticeRejectedIn} from "./new-reply-claims.ts";
import {receiptRow,receiptText,receiptTextColumns,type DeliveryGuard} from "./delivery-receipt-key.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
export type ReceiptState={kind:"New"|"Unknown"|"ContentConflict"}|{kind:"Delivered";messageId:string}|{kind:"RejectedBlocked"|"Held";reason:string};
function text(value:unknown):asserts value is string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed text");}
function guardSnapshot(value:DeliveryGuard|null):DeliveryGuard|null{
  if(value===null)return null;if(typeof value!=="object"||types.isProxy(value))throw new TypeError("Expected delivery guard data");
  const field=(key:string):string=>{const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own delivery guard field");text(d.value);return d.value;};
  return {jobId:field("jobId"),threadId:field("threadId"),turnId:field("turnId")};
}
async function owned<T>(path:string,transaction:boolean,run:(db:DatabaseSync)=>{value:T;commit:boolean}):Promise<T>{
  text(path);const db=await openInitialized(path);try{if(transaction)db.exec("BEGIN IMMEDIATE");const result=run(db);if(transaction&&result.commit)db.exec("COMMIT");return result.value;}
  finally{if(db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close rolls back */}}db.close();}
}
/** Unknown outcomes never resend. Only a recorded authoritative rejection may release an intent. */
export function beginDeliveryReceipt(path:string,key:string,hash:string,inputGuard:DeliveryGuard|null=null):Promise<ReceiptState>{
  text(key);text(hash);const guard=guardSnapshot(inputGuard);
  return owned<ReceiptState>(path,true,db=>{const value=beginDeliveryReceiptIn(db,key,hash,guard);return {value,commit:value.kind!=="Held"};});
}
/** Borrowed transaction only; the caller commits or rolls back all receipt side effects. */
export function beginDeliveryReceiptIn(db:DatabaseSync,key:string,hash:string,inputGuard:DeliveryGuard|null=null):ReceiptState{
  text(key);text(hash);const guard=guardSnapshot(inputGuard);
  if(!db.isTransaction)throw new StoreIntegrityError("delivery receipt requires an active transaction");
    validateFinalRecoveryClaimIn(db,key,hash,guard);const hold=validateNewReplyClaimIn(db,key,hash,guard);if(hold!==null)return {kind:"Held",reason:hold};
    const inserted=BigInt(db.prepare("INSERT OR IGNORE INTO codex_delivery_receipts(receipt_key,content_hash) VALUES (?,?)").run(key,hash).changes)===1n;
    const row=receiptRow(db,`SELECT content_hash,message_id,retryable,blocked_reason,${receiptTextColumns("content_hash","message_id","blocked_reason")} FROM codex_delivery_receipts WHERE receipt_key=?`,key);
    if(row===undefined)throw new StoreIntegrityError("delivery receipt intent is missing after INSERT");
    const storedHash=receiptText(row,"content_hash")!,message=receiptText(row,"message_id",true),retryable=decodeI64(row.retryable,"retryable")!==0n,blocked=receiptText(row,"blocked_reason",true);
    const retry=storedHash===hash&&message===null&&blocked===null&&retryable&&BigInt(db.prepare("UPDATE codex_delivery_receipts SET retryable=0 WHERE receipt_key=? AND retryable=1").run(key).changes)===1n;
    if(message!==null&&storedHash===hash)confirmNewReplyReceiptIn(db,key);newReplyNoticeClaimedIn(db,key);
    const value:ReceiptState=storedHash!==hash?{kind:"ContentConflict"}:inserted||retry?{kind:"New"}:message!==null?{kind:"Delivered",messageId:message}:blocked!==null?{kind:"RejectedBlocked",reason:blocked}:{kind:"Unknown"};
    return value;
}

export function confirmDeliveryReceipt(path:string,key:string,messageId:string):Promise<boolean>{
  text(key);text(messageId);return owned(path,true,db=>{const changed=BigInt(db.prepare("UPDATE codex_delivery_receipts SET message_id=? WHERE receipt_key=? AND message_id IS NULL").run(messageId,key).changes)===1n;
    if(changed)confirmNewReplyReceiptIn(db,key);return {value:changed,commit:true};});
}
/** Caller must have authoritative evidence the failed request could not create a message. */
export function releaseRejectedDelivery(path:string,key:string):Promise<boolean>{
  text(key);return owned(path,true,db=>{const changed=BigInt(db.prepare("UPDATE codex_delivery_receipts SET retryable=1 WHERE receipt_key=? AND message_id IS NULL AND blocked_reason IS NULL").run(key).changes)===1n;
    if(changed)newReplyNoticeRejectedIn(db,key);return {value:changed,commit:true};});
}
export function blockRejectedDelivery(path:string,key:string,reason:string):Promise<boolean>{
  text(key);text(reason);const bounded=takeUnicodeScalarChars(reason,1000);return owned(path,false,db=>({value:BigInt(db.prepare("UPDATE codex_delivery_receipts SET blocked_reason=?,retryable=0 WHERE receipt_key=? AND message_id IS NULL").run(bounded,key).changes)===1n,commit:true}));
}
export function unknownDeliveryReceiptCount(path:string):Promise<bigint>{return owned(path,false,db=>({value:decodeI64(receiptRow(db,"SELECT COUNT(*) AS n FROM codex_delivery_receipts WHERE message_id IS NULL AND retryable=0 AND blocked_reason IS NULL")?.n,"count"),commit:true}));}
export function blockedDeliveryReceiptCount(path:string):Promise<bigint>{return owned(path,false,db=>({value:decodeI64(receiptRow(db,"SELECT COUNT(*) AS n FROM codex_delivery_receipts WHERE message_id IS NULL AND blocked_reason IS NOT NULL")?.n,"count"),commit:true}));}
