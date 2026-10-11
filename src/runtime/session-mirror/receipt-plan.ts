import {types} from 'node:util';
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
 readonly receipts:readonly ExpectedReceipt[];readonly receiptSetHash:string;readonly itemCount:number;readonly #items:readonly (ItemPlan|null)[];readonly #channel:bigint;
 constructor(key:symbol,receipts:readonly ExpectedReceipt[],receiptSetHash:string,items:readonly (ItemPlan|null)[],channel:bigint){
  if(key!==token)throw new TypeError('Expected native mirror send plan');
  this.receipts=receipts;this.receiptSetHash=receiptSetHash;this.#items=items;this.itemCount=items.length;this.#channel=channel;Object.freeze(this);
 }
 /** One explicit item after caller ownership checks. No automatic skips/retries.
  * Exact marked chunks were created off-thread. Earlier receipts are reused and
  * every native storage/transport operation settles before another part starts. */
 async sendItem(store:NativeMirrorReceiptStore,transport:DiscordReceiptTransport,index:number,signal?:AbortSignal):Promise<void>{
  const items=this.#items;signal?.throwIfAborted();
  if(!Number.isSafeInteger(index)||index<0||index>=items.length)throw new RangeError('Invalid mirror item index');
  const item=items[index];if(item===null||item===undefined)throw new TypeError('Skipped mirror item cannot be sent by this plan');
  await deliverChunksIndexed(item.chunks,{retryDelaysMs:[],chunkMarkers:true},(chunkIndex,content)=>sendNativeMirrorReceiptChunk(store,transport,this.#channel,{domain:item.domain,logicalKey:item.logicalKey,chunkIndex,content},signal));
  signal?.throwIfAborted();
 }
}
Object.freeze(MirrorReceiptPlan.prototype);
function itemPlans(input:unknown,modes:readonly MirrorDeliveryMode[]):readonly (ItemPlan|null)[]{
 const expected=modes.length;
 if(!Array.isArray(input)||input.length!==expected||input.length>4096)throw new TypeError('Invalid native mirror item plan');
 let chunks=0,bytes=0,keys=0;const result:(ItemPlan|null)[]=[];
 for(let index=0;index<input.length;index++){
  const value=input[index];
  if(modes[index]==='Skip'){if(value!==null)throw new TypeError('Skipped native plan contains chunks');result.push(null);continue;}
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
export type MirrorDeliveryMode='Deliver'|'Skip';
/** Exact one decision for every authentic item; no holes, getters or omission. */
export function snapshotMirrorDeliveryModes(input:readonly MirrorDeliveryMode[],count:number):readonly MirrorDeliveryMode[]{
 if(!Number.isSafeInteger(count)||count<0||count>4096||types.isProxy(input)||!Array.isArray(input)||input.length!==count)throw new TypeError('Expected complete bounded mirror delivery modes');
 const result:MirrorDeliveryMode[]=[];
 for(let i=0;i<count;i++){const mode=own(input,String(i));if(mode!=='Deliver'&&mode!=='Skip')throw new TypeError('Invalid mirror delivery mode');result.push(mode);}
 return Object.freeze(result);
}
export async function planMirrorReceiptsOffThread(observation:AnchoredMirrorBatch,channel:bigint,signal?:AbortSignal,timeoutMs=5000):Promise<MirrorReceiptPlan>{
 signal?.throwIfAborted();
 const {batch}=AnchoredMirrorBatch.prototype.captured.call(observation);
 if(batch.items.length>4096)throw new RangeError('Mirror packet item budget exceeded');
 return planMixedMirrorReceiptsOffThread(observation,channel,Array<MirrorDeliveryMode>(batch.items.length).fill('Deliver'),signal,timeoutMs);
}
/** Skip choices do not grant skip permission. Final atomic cursor guard must
 * prove them all against the same authentic batch and current database state. */
export async function planMixedMirrorReceiptsOffThread(observation:AnchoredMirrorBatch,channel:bigint,inputModes:readonly MirrorDeliveryMode[],signal?:AbortSignal,timeoutMs=5000):Promise<MirrorReceiptPlan>{

 signal?.throwIfAborted();
 const {batch}=AnchoredMirrorBatch.prototype.captured.call(observation);
 if(batch.items.length>4096)throw new RangeError('Mirror packet item budget exceeded');
 const modes=snapshotMirrorDeliveryModes(inputModes,batch.items.length);
 if(typeof channel!=='bigint'||channel<=0n||channel>=(1n<<63n))throw new RangeError('Expected mapped positive i64 channel');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid mirror receipt deadline');
 if(batch.items.length>4096)throw new RangeError('Mirror packet item budget exceeded');
 let bytes=Buffer.byteLength(batch.thread);
 for(const item of batch.items){
  for(const value of [item.text,item.digest,item.kind,item.phase,item.turnId??''])bytes+=Buffer.byteLength(value);
  if(bytes>1048576)throw new RangeError('Mirror receipt input exceeds one MiB');
 }
 if(slot.busy)throw new OwnedWorkerBusyError();
 const pending=slot.run(new URL('./receipt-plan-worker.ts',import.meta.url),{thread:batch.thread,items:batch.items,channel,modes},timeoutMs,signal),exit=slot.join();
 let result:unknown;try{result=await pending}finally{await exit}
 signal?.throwIfAborted();
 if(own(result,'ok')!==true){const detail=own(result,'detail');throw new MirrorReceiptPlanningError(typeof detail==='string'?detail:'invalid native result');}
 const receipts=snapshotExpectedReceiptBatch(own(result,'receipts') as readonly ExpectedReceipt[]),receiptSetHash=own(result,'receiptSetHash');
 if(typeof receiptSetHash!=='string'||!/^[0-9a-f]{64}$/.test(receiptSetHash))throw new MirrorReceiptPlanningError('invalid receipt set hash');
 const items=itemPlans(own(result,'items'),modes);
 if(items.reduce((n,item)=>n+(item?.chunks.length??0),0)!==receipts.length)throw new MirrorReceiptPlanningError('native receipt/chunk count mismatch');
 return new MirrorReceiptPlan(token,receipts,receiptSetHash,items,channel);
}
