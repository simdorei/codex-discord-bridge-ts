import {AnchoredMirrorBatch} from './continuity-observation.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {snapshotExpectedReceiptBatch,type ExpectedReceipt} from '../../store/confirmed-receipt-batch.ts';
const slot=new OwnedWorkerSlot();
export class MirrorReceiptPlanningError extends Error{constructor(detail:string){super('Mirror receipt planning failed: '+detail);this.name='MirrorReceiptPlanningError';}}
export interface MirrorReceiptPlan{readonly receipts:readonly ExpectedReceipt[];readonly receiptSetHash:string}
/** Fixed worker receives only an authentic frozen native display batch, bounded
 * to 4096 items and one MiB field bytes before structured clone. Formatting,
 * normalized digest, chunking, serde keys and receipt-set hashing run off main.
 * One process-wide owner, shared global capacity, zero queue, actual exit joined
 * even on timeout/cancel. Returned receipts are bounded metadata, not delivery. */
export async function planMirrorReceiptsOffThread(observation:AnchoredMirrorBatch,channel:bigint,signal?:AbortSignal,timeoutMs=5000):Promise<MirrorReceiptPlan>{
 signal?.throwIfAborted();
 const {batch}=AnchoredMirrorBatch.prototype.captured.call(observation);
 if(typeof channel!=='bigint'||channel<=0n||channel>=(1n<<63n))throw new RangeError('Expected mapped positive i64 channel');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid mirror receipt deadline');
 if(batch.items.length>4096)throw new RangeError('Mirror packet item budget exceeded');
 let bytes=Buffer.byteLength(batch.thread);
 for(const item of batch.items){
  for(const value of [item.text,item.digest,item.kind,item.phase,item.turnId??''])bytes+=Buffer.byteLength(value);
  if(bytes>1048576)throw new RangeError('Mirror receipt input exceeds one MiB');
 }
 if(slot.busy)throw new OwnedWorkerBusyError();
 const pending=slot.run(new URL('./receipt-plan-worker.ts',import.meta.url),{thread:batch.thread,items:batch.items,channel},timeoutMs,signal),exit=slot.join();
 let result:unknown;try{result=await pending}finally{await exit}
 signal?.throwIfAborted();
 if(own(result,'ok')!==true){const detail=own(result,'detail');throw new MirrorReceiptPlanningError(typeof detail==='string'?detail:'invalid native result');}
 const receipts=snapshotExpectedReceiptBatch(own(result,'receipts') as readonly ExpectedReceipt[]),receiptSetHash=own(result,'receiptSetHash');
 if(typeof receiptSetHash!=='string'||!/^[0-9a-f]{64}$/.test(receiptSetHash))throw new MirrorReceiptPlanningError('invalid receipt set hash');
 return Object.freeze({receipts,receiptSetHash});
}
