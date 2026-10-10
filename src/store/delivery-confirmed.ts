import {openExisting} from './existing-store.ts';
import {verifyCurrentCatalogIn} from './owned-driver.ts';
import {DeliveryNotFoundError,selectDelivery,snapshotStoredDelivery,type StoredDelivery} from './delivery.ts';
import {finalDeliveryPreflightIn} from './delivery-preflight.ts';
import {beginDeliveryReceiptIn} from './delivery-receipts.ts';
import {receiptHash} from './delivery-receipt-key.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {requireDiscordText} from '../discord/text.ts';
/** Internal trusted runtime supplies every normally rendered, validated chunk.
 * No network send; no initialize or repair. All claims and retirement commit once. */
export function completeConfirmedDelivery(path:string,input:StoredDelivery,inputChunks:readonly string[]):boolean {
 requireDiscordText(path);const pending=snapshotStoredDelivery(input),chunks=cloneOwnedSerdeValue(inputChunks);if(!Array.isArray(chunks))throw new TypeError('Expected delivery chunks');for(const chunk of chunks)requireDiscordText(chunk);
 if(chunks.length===0||pending.channelId<=0n)return false;
 const db=openExisting(path);let committed=false;try{
  db.exec('BEGIN IMMEDIATE');verifyCurrentCatalogIn(db);let stored:StoredDelivery;
  try{stored=selectDelivery(db,pending.deliveryId);}catch(error){if(error instanceof DeliveryNotFoundError)return false;throw error;}
  for(const key of Object.keys(pending) as (keyof StoredDelivery)[])if(stored[key]!==pending[key])return false;
  if(finalDeliveryPreflightIn(db,pending).kind!=='Ready')return false;
  const guard={jobId:pending.jobId,threadId:pending.targetThreadId,turnId:pending.turnId};
  for(const[index,chunk]of chunks.entries()){
   const key=serializeSerdeValue([pending.channelId,'completion/v1',pending.deliveryId,BigInt(index)]);
   if(beginDeliveryReceiptIn(db,key,receiptHash(chunk),guard).kind!=='Delivered')return false;
  }
  if(BigInt(db.prepare('DELETE FROM codex_delivery_outbox WHERE delivery_id=?').run(pending.deliveryId).changes)!==1n)return false;
  db.exec('COMMIT');committed=true;return true;
 }finally{if(!committed&&db.isTransaction){try{db.exec('ROLLBACK');}catch{/* close abandons the owned transaction */}}db.close();}
}
