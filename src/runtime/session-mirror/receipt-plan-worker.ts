import {splitDeliveryChunks} from '../../discord/text.ts';
import {parentPort,workerData as q} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {formatMirrorItem,type MirrorItem} from './collect.ts';
import {sessionMirrorIdentity,sessionMirrorReceiptExpectations} from './sender.ts';
import {snapshotExpectedReceiptBatch,type ExpectedReceipt} from '../../store/confirmed-receipt-batch.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
if(parentPort===null)throw new Error('Mirror receipt planner requires an owned native worker');
try{
 let textBytes=0,keyBytes=0;const receipts:ExpectedReceipt[]=[];const items=[];
 for(const item of q.items as readonly MirrorItem[]){
  const text=formatMirrorItem(item);textBytes+=Buffer.byteLength(text);
  if(textBytes>1048576)throw new RangeError('Mirror packet text budget exceeded');
  const identity=sessionMirrorIdentity(q.thread,item);items.push({identity,chunks:splitDeliveryChunks(text,true)});
  for(const receipt of sessionMirrorReceiptExpectations(q.channel,identity,text)){
   keyBytes+=Buffer.byteLength(receipt.key)+64;
   if(receipts.length>=4096||keyBytes>1048576)throw new RangeError('Mirror packet receipt budget exceeded');
   receipts.push(receipt);
  }
 }
 const captured=snapshotExpectedReceiptBatch(receipts);
 const receiptSetHash=createHash('sha256').update(serializeSerdeValue(captured.map(r=>[r.key,r.contentHash]))).digest('hex');
 parentPort.postMessage({ok:true,receipts:captured,receiptSetHash,items});
}catch(error){parentPort.postMessage({ok:false,detail:[...(error instanceof Error?error.message:'Mirror receipt planning failed')].slice(0,2048).join('')});}
finally{parentPort.close();}
