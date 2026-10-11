import {NativeMirrorCursorStore} from './cursor-store.ts';
import {AnchoredMirrorBatch} from './continuity-observation.ts';
import {encodeMirrorCursorAnchor,type MirrorCursorAnchor} from '../../core/mirror-cursor-anchor.ts';
import {snapshotBoundMirrorCursor,type BoundMirrorCursor} from '../../store/mirror-cursor-journal.ts';
import type {ExpectedReceipt} from '../../store/confirmed-receipt-batch.ts';
import {planMirrorReceiptsOffThread,type MirrorReceiptPlan} from './receipt-plan.ts';
import {requireDiscordText} from '../../discord/text.ts';
export interface AllDeliveredMirrorPacket{
 readonly expected:BoundMirrorCursor;readonly anchor:MirrorCursorAnchor;readonly turn:string;
 readonly channel:bigint;readonly updatedAt:number;readonly operationId:string;
 readonly receipts:readonly ExpectedReceipt[];readonly itemCount:number;
 readonly historyIntegrityVerified:false;
}
const packets=new WeakMap<object,Readonly<{observation:AnchoredMirrorBatch;receiptSetHash:string;plan:MirrorReceiptPlan}>>();
function authentic(packet:AllDeliveredMirrorPacket){
 if(packet===null||typeof packet!=='object')throw new TypeError('Expected factory-created all-delivered packet');
 const owned=packets.get(packet);if(owned===undefined)throw new TypeError('Expected factory-created all-delivered packet');return owned;
}
/** Builds complete receipt coverage from an authentic decoded batch. It does not
 * send, skip bot-owned items, check current mapping, or write a cursor. A runtime
 * coordinator must establish send ownership and current mapping separately.
 * This all-delivered profile cannot represent skipped items: their missing
 * receipts must hold the later DB write. Detail filtering remains the explicitly
 * supplied native decoder policy. Bounded anchors still require an independently
 * established append-only producer contract; no historical integrity is claimed.
 * Retain this exact packet for uncertain-write reconciliation, never resend. */
export async function prepareAllDeliveredMirrorPacket(
 input:BoundMirrorCursor,observation:AnchoredMirrorBatch,channel:bigint,
 updatedAt:number,operationId:string,signal?:AbortSignal
):Promise<AllDeliveredMirrorPacket>{
 signal?.throwIfAborted();
 const expected=snapshotBoundMirrorCursor(input);
 // Calling the frozen prototype method checks the private brand first, rejecting
 // lookalikes/proxies without invoking their getters or method overrides.
 const {expectedAnchor,batch}=AnchoredMirrorBatch.prototype.captured.call(observation);
 if(encodeMirrorCursorAnchor(expected.anchor)!==encodeMirrorCursorAnchor(expectedAnchor)||
    expected.thread!==batch.thread||expected.turn!==(batch.priorTurn??''))
  throw new TypeError('Mirror batch does not match the persisted cursor');
 if(typeof channel!=='bigint'||channel<=0n||channel>=(1n<<63n))throw new RangeError('Expected mapped positive i64 channel');
 requireDiscordText(operationId);
 if(operationId.length===0||operationId.length>128||Buffer.byteLength(operationId)>128)throw new RangeError('Mirror operation identity budget exceeded');
 if(typeof updatedAt!=='number'||!Number.isFinite(updatedAt)||updatedAt<0)throw new TypeError('Invalid mirror packet timestamp');
 const plan=await planMirrorReceiptsOffThread(observation,channel,signal),captured=plan.receipts;
 const next=await AnchoredMirrorBatch.prototype.observeNextBoundary.call(observation,signal);
 signal?.throwIfAborted();
 const result:AllDeliveredMirrorPacket=Object.freeze({expected,anchor:next.anchor,turn:batch.currentTurn??'',channel,updatedAt,operationId,receipts:captured,itemCount:batch.items.length,historyIntegrityVerified:false});
 packets.set(result,Object.freeze({observation,receiptSetHash:plan.receiptSetHash,plan}));
 return result;
}


/** Commit only a factory-owned packet after re-observing its exact file stamp.
 * Current thread/channel, every receipt and cursor CAS are then checked in the
 * native DB transaction. File observation is not atomic with a concurrent writer;
 * append-only producer and pre-send ownership contracts remain prerequisites.
 * No network, automatic resend, skip inference or legacy cursor adoption. */
export async function commitAllDeliveredMirrorPacket(store:NativeMirrorCursorStore,packet:AllDeliveredMirrorPacket,signal?:AbortSignal):Promise<BoundMirrorCursor>{
 const owned=authentic(packet);signal?.throwIfAborted();
 await AnchoredMirrorBatch.prototype.verifyCurrent.call(owned.observation,signal);
 signal?.throwIfAborted();
 return NativeMirrorCursorStore.prototype.advanceMapped.call(store,packet.expected,packet.anchor,packet.turn,packet.updatedAt,packet.operationId,packet.receipts,packet.channel,signal);
}
export type MirrorPacketReconciliation=
 Readonly<{kind:'Committed';cursor:BoundMirrorCursor}>|
 Readonly<{kind:'CurrentCursorUnchanged';cursor:BoundMirrorCursor}>|
 Readonly<{kind:'Conflict';cursor:BoundMirrorCursor|null}>;
/** Read-only exact-packet reconciliation. Does not touch rollout or mapping,
 * resend messages, write, or infer that an outstanding worker did not commit.
 * Join the original write owner first. CurrentCursorUnchanged is an observation,
 * never permission to blindly retry network delivery. */
export async function reconcileAllDeliveredMirrorPacket(store:NativeMirrorCursorStore,packet:AllDeliveredMirrorPacket,signal?:AbortSignal):Promise<MirrorPacketReconciliation>{
 const owned=authentic(packet);signal?.throwIfAborted();
 const cursor=await NativeMirrorCursorStore.prototype.read.call(store,packet.expected.thread,signal);
 if(cursor===null)return Object.freeze({kind:'Conflict',cursor});
 const encoded=encodeMirrorCursorAnchor(cursor.anchor),old=packet.expected;
 if(cursor.thread===old.thread&&cursor.revision===old.revision+1n&&cursor.operationId===packet.operationId&&cursor.turn===packet.turn&&cursor.updatedAt===packet.updatedAt&&cursor.receiptSetHash===owned.receiptSetHash&&encoded===encodeMirrorCursorAnchor(packet.anchor))
  return Object.freeze({kind:'Committed',cursor});
 if(cursor.thread===old.thread&&cursor.revision===old.revision&&cursor.operationId===old.operationId&&cursor.turn===old.turn&&cursor.updatedAt===old.updatedAt&&cursor.receiptSetHash===old.receiptSetHash&&encoded===encodeMirrorCursorAnchor(old.anchor))
  return Object.freeze({kind:'CurrentCursorUnchanged',cursor});
 return Object.freeze({kind:'Conflict',cursor});
}


/** Reuse the exact native chunk plan already retained by this authentic packet.
 * Caller still decides each item's send ownership; omitting an item never removes
 * its receipt from the final all-delivered cursor guard. */
export function mirrorPacketSendPlan(packet:AllDeliveredMirrorPacket):MirrorReceiptPlan{return authentic(packet).plan;}
