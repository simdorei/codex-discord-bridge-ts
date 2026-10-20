import {parentPort,workerData} from 'node:worker_threads';
import {usingExistingStore,withStoreTransaction,commitStore,rollbackStore} from '../../store/owned-scope.ts';
import {confirmDeliveryReceiptIn} from '../../store/delivery-receipts.ts';
import {receiptHash,parseReceiptKey} from '../../store/delivery-receipt-key.ts';
import {messageNonce} from '../../discord/message-nonce.ts';
import {splitDeliveryChunks} from '../../discord/text.ts';
if(parentPort===null)throw new Error('Gateway receipt confirmation requires an owned worker');
// Only the bridge's emitted button/row profile is eligible. Other components
// remain held, never converted to an empty-components hash.
function component(value:any):unknown{
 if(value.id!==null)throw Error('Component identity differs');
 if(value.type===1n)return {type:1,components:value.components.map(component)};
 if(value.type===2n&&typeof value.custom_id==='string'&&typeof value.label==='string'&&[1n,2n,3n,4n].includes(value.style)&&value.disabled===false&&value.emoji===null&&value.url===null&&value.sku_id===null)return {type:2,custom_id:value.custom_id,label:value.label,style:Number(value.style)};
 throw Error('Unsupported echoed component');
}
try{
 const message=workerData.message,components=message.components as unknown[];
 let hash:string|null=null;try{hash=receiptHash(components.length===0?message.content:JSON.stringify([message.content,components.map(component)]));}catch{}
 const confirmed=hash===null?false:usingExistingStore(workerData.database,db=>withStoreTransaction(db,'IMMEDIATE',()=>{
  const candidates=db.prepare('SELECT receipt_key FROM codex_delivery_receipts WHERE content_hash=? AND (message_id IS NULL OR message_id=?) AND retryable=0 AND blocked_reason IS NULL LIMIT 1025').all(hash,message.id.toString());
  if(candidates.length>1024)return rollbackStore(false);let matched:ReturnType<typeof parseReceiptKey>=null,key:string|null=null;
  for(const row of candidates){if(typeof row.receipt_key!=='string')continue;const parsed=parseReceiptKey(row.receipt_key);if(parsed===null||parsed[0]!==message.channel_id||messageNonce(parsed[1],parsed[0],parsed[2],parsed[3])!==message.nonce)continue;if(matched!==null)return rollbackStore(false);matched=parsed;key=row.receipt_key;}
  if(matched===null||key===null)return rollbackStore(false);
  // Already-confirmed matching echoes are idempotent and can finish a legacy
  // barrier if the process died between the older implementation's writes.
  const changed=confirmDeliveryReceiptIn(db,key,message.id.toString());
  const event=matched[1]==='message/reply/v1'?/^inbound-message\/([0-9]+)\/action-result$/u.exec(matched[2])?.[1]:undefined;
  if(event!==undefined&&BigInt(event)<(1n<<63n)){
   const row=db.prepare('SELECT outcome_json FROM discord_ingress_journal WHERE ingress_id=?').get('message:'+event);
   let response:unknown;try{response=typeof row?.outcome_json==='string'?(JSON.parse(row.outcome_json) as {response?:unknown}).response:undefined;}catch{}
   if(typeof response==='string'&&Buffer.byteLength(response)<=1048576){const chunks=splitDeliveryChunks(response,true);
    if(chunks.length>0&&chunks.every((chunk,index)=>db.prepare('SELECT 1 FROM codex_delivery_receipts WHERE receipt_key=? AND content_hash=? AND message_id IS NOT NULL').get(`[${message.channel_id},"message/reply/v1",${JSON.stringify(matched![2])},${index}]`,receiptHash(chunk))!==undefined))
     db.prepare("UPDATE discord_ingress_journal SET confirmation_delivered=1,updated_at=unixepoch('subsec') WHERE ingress_id=? AND kind='message' AND event_id=? AND channel_id=? AND state='owned' AND phase='result_recorded' AND owner_kind='prompt' AND confirmation_delivered=0 AND json_extract(outcome_json,'$.response')=? AND json_extract(outcome_json,'$.waits_for_final')=1 AND NOT EXISTS(SELECT 1 FROM codex_new_first_replies WHERE job_id=discord_ingress_journal.owner_id)").run('message:'+event,BigInt(event),message.channel_id,response);
   }
  }
  return commitStore(changed);
 }),100);
 parentPort.postMessage({ok:true,confirmed});
}catch{parentPort.postMessage({ok:false});}finally{parentPort.close();}
