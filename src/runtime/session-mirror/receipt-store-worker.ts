import {parentPort,workerData as q} from 'node:worker_threads';
import {usingExistingStore,withStoreTransaction,commitStore,rollbackStore} from '../../store/owned-scope.ts';
import {beginDeliveryReceiptIn,confirmDeliveryReceiptIn,releaseRejectedDeliveryIn,blockRejectedDeliveryIn} from '../../store/delivery-receipts.ts';
import {takeUnicodeScalarChars} from '../../store/queue-preflight-failure.ts';
import {parseReceiptKey} from '../../store/delivery-receipt-key.ts';
import {requireExactMirrorChannelIn} from '../../store/mirror-cursor-mapping.ts';
import type {DatabaseSync} from 'node:sqlite';
if(parentPort===null)throw new Error('Mirror receipt store requires an owned worker');
function identity():void{
 const key=parseReceiptKey(q.key);if(key===null||key[0]!==q.channel)throw new TypeError('Mirror receipt channel changed');
 const domain=key[1],logical=key[2],prefix=Buffer.byteLength(q.thread)+':'+q.thread+':';
 const digest=logical.slice(-64);if(!/^[0-9a-f]{64}$/.test(digest)||logical.at(-65)!==':')throw new TypeError('Invalid mirror receipt digest');
 if(domain==='session-mirror/event/v1'){
  if(logical.slice(0,-64)!==prefix)throw new TypeError('Mirror event thread changed');return;
 }
 if(domain!=='session-mirror/assistant-text/v1')throw new TypeError('Not a mirror receipt domain');
 const colon=logical.indexOf(':'),size=logical.slice(0,colon),scope=logical.slice(colon+1,-65);
 if(!/^(0|[1-9][0-9]*)$/.test(size)||String(Buffer.byteLength(scope))!==size||!scope.startsWith(prefix))throw new TypeError('Mirror assistant scope changed');
 const tail=scope.slice(prefix.length),split=tail.indexOf(':'),turnSize=tail.slice(0,split),turn=tail.slice(split+1);
 if(split<0||!/^(0|[1-9][0-9]*)$/.test(turnSize)||String(Buffer.byteLength(turn))!==turnSize)throw new TypeError('Mirror turn scope changed');
}
/** Scalar-only preflight prevents corrupt large row materialization. Raw byte
 * budgets permit UTF16; existing strict decoders still validate stored values. */
function rowBudget(db:DatabaseSync):boolean|null{
 const stmt=db.prepare(`SELECT CAST(receipt_key AS BLOB)=CAST(? AS BLOB) AS exact,
  CAST(content_hash AS BLOB)=CAST(? AS BLOB) AS same_hash,
  typeof(content_hash)='text' AND length(CAST(content_hash AS BLOB))<=128
  AND (message_id IS NULL OR (typeof(message_id)='text' AND length(CAST(message_id AS BLOB))<=80))
  AND (blocked_reason IS NULL OR (typeof(blocked_reason)='text' AND length(CAST(blocked_reason AS BLOB))<=8000))
  AND typeof(retryable)='integer' AS bounded
  FROM codex_delivery_receipts WHERE receipt_key=? LIMIT 2`);
 stmt.setReadBigInts(true);const rows=stmt.all(q.key,q.hash,q.key);
 if(rows.length===0)return null;
 if(rows.length!==1||rows[0]!.exact!==1n||rows[0]!.bounded!==1n)throw new TypeError('Mirror receipt row is ambiguous, malformed or exceeds budget');
 return rows[0]!.same_hash===1n;
}
try{
 identity();
 const value=usingExistingStore(q.path,db=>withStoreTransaction<unknown>(db,'IMMEDIATE',()=>{
  const matches=rowBudget(db);
  if(q.kind==='Begin'){
   requireExactMirrorChannelIn(db,q.thread,q.channel);const state=beginDeliveryReceiptIn(db,q.key,q.hash,null);
   const after=rowBudget(db);if(state.kind!=='ContentConflict'&&state.kind!=='Held'&&after!==true)throw new TypeError('Mirror receipt hash changed during begin');
   requireExactMirrorChannelIn(db,q.thread,q.channel);
   return state.kind==='Held'?rollbackStore(state):commitStore(state);
  }
  if(matches===false)throw new TypeError('Mirror receipt content changed');
  let changed:boolean;
  switch(q.kind){
   case 'Confirm':changed=confirmDeliveryReceiptIn(db,q.key,q.message);break;
   case 'Release':changed=releaseRejectedDeliveryIn(db,q.key);break;
   case 'Block':changed=blockRejectedDeliveryIn(db,q.key,q.reason);break;
   default:throw new TypeError('Unsupported mirror receipt operation');
  }
  const after=rowBudget(db);if(matches!==null&&after!==true)throw new TypeError('Mirror receipt changed during mutation');
  if(changed){
   let check;
   if(q.kind==='Confirm')check=db.prepare('SELECT CAST(message_id AS BLOB)=CAST(? AS BLOB) AS valid FROM codex_delivery_receipts WHERE receipt_key=?').get(q.message,q.key);
   else if(q.kind==='Release')check=db.prepare('SELECT retryable=1 AND message_id IS NULL AND blocked_reason IS NULL AS valid FROM codex_delivery_receipts WHERE receipt_key=?').get(q.key);
   else check=db.prepare('SELECT CAST(blocked_reason AS BLOB)=CAST(? AS BLOB) AND retryable=0 AND message_id IS NULL AS valid FROM codex_delivery_receipts WHERE receipt_key=?').get(takeUnicodeScalarChars(q.reason,1000),q.key);
   if(check?.valid!==1)throw new TypeError('Mirror receipt mutation postcondition failed');
  }
  return commitStore(changed);
 }),100);
 parentPort.postMessage({ok:true,value});
}catch(error){parentPort.postMessage({ok:false,detail:[...(error instanceof Error?error.message:'Mirror receipt operation failed')].slice(0,2048).join('')});}
finally{parentPort.close();}
