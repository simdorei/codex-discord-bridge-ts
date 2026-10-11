import {deliverChunksIndexed} from '../../discord/delivery.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {sendNativeMirrorReceiptChunk} from './native-sender.ts';
import type {NativeMirrorReceiptStore} from './receipt-store.ts';
import type {DiscordReceiptTransport} from '../completion/receipt-sender.ts';
import {AnchoredMirrorBatch} from './continuity-observation.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {snapshotExpectedReceiptBatch,type ExpectedReceipt} from '../../store/confirmed-receipt-batch.ts';
const slot=new OwnedWorkerSlot();
export class MirrorReceiptPlanningError extends Error{constructor(detail:string){super('Mirror receipt planning failed: '+detail);this.name='MirrorReceiptPlanningError';}}
const token=Symbol('native mirror send plan');
interface ItemPlan{readonly domain:string;readonly logicalKey:string;readonly chunks:readonly string[]}
export class MirrorReceiptPlan{
 readonly receipts:readonly ExpectedReceipt[];readonly receiptSetHash:string;readonly itemCount:number;readonly #items:readonly ItemPlan[];readonly #channel:bigint;
 constructor(key:symbol,receipts:readonly ExpectedReceipt[],receiptSetHash:string,items:readonly ItemPlan[],channel:bigint){
  if(key!==token)throw new TypeError('Expected native mirror send plan');
  this.receipts=receipts;this.receiptSetHash=receiptSetHash;this.#items=items;this.itemCount=items.length;this.#channel=channel;Object.freeze(this);
 }
 /** One explicit item after caller ownership checks. No automatic skips/retries.
  * Exact marked chunks were created off-thread. Earlier receipts are reused and
  * every native storage/transport operation settles before another part starts. */
 async sendItem(store:NativeMirrorReceiptStore,transport:DiscordReceiptTransport,index:number,signal?:AbortSignal):Promise<void>{
  const items=this.#items;signal?.throwIfAborted();
  if(!Number.isSafeInteger(index)||index<0||index>=items.length)throw new RangeError('Invalid mirror item index');
  const item=items[index]!;
  await deliverChunksIndexed(item.chunks,{retryDelaysMs:[],chunkMarkers:true},(chunkIndex,content)=>sendNativeMirrorReceiptChunk(store,transport,this.#channel,{domain:item.domain,logicalKey:item.logicalKey,chunkIndex,content},signal));
  signal?.throwIfAborted();
 }
}
Object.freeze(MirrorReceiptPlan.prototype);
function itemPlans(input:unknown,expected:number):readonly ItemPlan[]{
 if(!Array.isArray(input)||input.length!==expected||input.length>4096)throw new TypeError('Invalid native mirror item plan');
 let chunks=0,bytes=0,keys=0;const result:ItemPlan[]=[];
 for(const value of input){
  const identity=own(value,'identity'),domain=own(identity,'domain'),logicalKey=own(identity,'logicalKey'),raw=own(value,'chunks');
  if(domain!=='session-mirror/event/v1'&&domain!=='session-mirror/assistant-text/v1')throw new TypeError('Invalid native mirror domain');
  requireDiscordText(logicalKey);if(Buffer.byteLength(logicalKey)>65536)throw new RangeError('Mirror identity exceeds budget');keys+=Buffer.byteLength(logicalKey);
  if(keys>1048576||!Array.isArray(raw)||raw.length===0||raw.length>4096)throw new RangeError('Mirror native chunk plan exceeds budget');
  const copy:string[]=[];
  for(const text of raw){
   requireDiscordText(text);const size=Buffer.byteLength(text);bytes+=size;chunks++;
   if(size>8192||bytes>2097152||chunks>4096)throw new RangeError('Mirror native chunk bytes exceed budget');copy.push(text);
  }
  result.push(Object.freeze({domain,logicalKey,chunks:Object.freeze(copy)}));
 }
 return Object.freeze(result);
}
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
 const items=itemPlans(own(result,'items'),batch.items.length);
 if(items.reduce((n,item)=>n+item.chunks.length,0)!==receipts.length)throw new MirrorReceiptPlanningError('native receipt/chunk count mismatch');
 return new MirrorReceiptPlan(token,receipts,receiptSetHash,items,channel);
}
