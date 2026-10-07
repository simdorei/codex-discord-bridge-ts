import {hasPendingCommentaryIn} from "./commentary-outbox.ts";
import type {DatabaseSync} from "node:sqlite";
import {CheckedRead,openInitialized} from "./owned-driver.ts";
import {snapshotStoredDelivery,type StoredDelivery} from "./delivery.ts";
import {finalRecoveryAuthorizedIn} from "./final-recovery-claims.ts";
import {newReplyOutputHoldIn} from "./new-reply-claims.ts";
import {hasPendingGoalProgressIn} from "./goal-progress.ts";
import {receiptRow,receiptText,receiptTextColumns} from "./delivery-receipt-key.ts";
import {decodeI64} from "./sqlite-values.ts";
export type FinalReadiness={kind:"Ready"|"Commentary"|"GoalProgress"}|{kind:"Held";reason:string}|{kind:"FirstReply";request:string};
/** Earliest original visible request only; a later canonical duplicate cannot re-close this barrier. */
export function pendingFirstReplyIn(db:DatabaseSync,job:string):string|null{
  const row=receiptRow(db,`SELECT ingress_id,confirmation_delivered,${receiptTextColumns("ingress_id")} FROM discord_ingress_journal
    WHERE owner_kind='prompt' AND owner_id=? AND kind IN ('message','interaction') ORDER BY created_at,ingress_id LIMIT 1`,job);
  if(row===undefined)return null;const id=receiptText(row,"ingress_id")!,confirmed=decodeI64(row.confirmation_delivered,"confirmation_delivered")!==0n;return confirmed?null:id;
}
export async function pendingFirstReply(path:string,job:string):Promise<string|null>{
  for(const value of [path,job])if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed text");
  const db=await openInitialized(path);try{return pendingFirstReplyIn(db,job);}finally{db.close();}}
function read(db:DatabaseSync,pending:StoredDelivery):FinalReadiness{
  const grant=finalRecoveryAuthorizedIn(db,pending),hold=newReplyOutputHoldIn(db,pending.jobId);if(hold!==null)return {kind:"Held",reason:hold};
  if(!grant){const request=pendingFirstReplyIn(db,pending.jobId);if(request!==null)return {kind:"FirstReply",request};
    if(hasPendingCommentaryIn(db,pending.jobId,null))return {kind:"Commentary"};}
  if(hasPendingGoalProgressIn(db,pending.jobId,pending.targetThreadId))return {kind:"GoalProgress"};return {kind:"Ready"};
}
/** A short read snapshot, not send authorization. Finish the snapshot before returning; no result cache. */
export function finalDeliveryPreflight(path:string,input:StoredDelivery):FinalReadiness{
  const pending=snapshotStoredDelivery(input),snapshot=CheckedRead.open(path);
  try{snapshot.ensureActive();const result=read(snapshot.connection(),pending);snapshot.ensureActive();snapshot.finish();return result;}finally{snapshot.close();}
}
