import {snapshotMirrorSkippedItems} from './ownership.ts';
import type {MirrorItem} from './collect.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {NativeMirrorCursorStore} from './cursor-store.ts';
import {AnchoredMirrorBatch} from './continuity-observation.ts';
import {encodeMirrorCursorAnchor,type MirrorCursorAnchor} from '../../core/mirror-cursor-anchor.ts';
import {snapshotBoundMirrorCursor,type BoundMirrorCursor} from '../../store/mirror-cursor-journal.ts';
import type {ExpectedReceipt} from '../../store/confirmed-receipt-batch.ts';
import {planMirrorReceiptsOffThread,planMixedMirrorReceiptsOffThread,snapshotMirrorDeliveryModes,type MirrorDeliveryMode,type MirrorReceiptPlan} from './receipt-plan.ts';
import {requireDiscordText} from '../../discord/text.ts';
export interface AllDeliveredMirrorPacket{
 readonly expected:BoundMirrorCursor;readonly anchor:MirrorCursorAnchor;readonly turn:string;
 readonly channel:bigint;readonly updatedAt:number;readonly operationId:string;
 readonly receipts:readonly ExpectedReceipt[];readonly itemCount:number;
 readonly historyIntegrityVerified:false;
}
export interface MixedMirrorPacket extends AllDeliveredMirrorPacket{readonly deliveryModes:readonly MirrorDeliveryMode[];}
type Profile='AllDelivered'|'Mixed';
const packets=new WeakMap<object,Readonly<{profile:Profile;skipped:readonly MirrorItem[];observation:AnchoredMirrorBatch;receiptSetHash:string;plan:MirrorReceiptPlan}>>();
function authentic(packet:AllDeliveredMirrorPacket,profile:Profile='AllDelivered'){
 if(packet===null||typeof packet!=='object')throw new TypeError('Expected factory-created all-delivered packet');
 const owned=packets.get(packet);if(owned===undefined||owned.profile!==profile)throw new TypeError('Expected factory-created mirror packet with matching profile');return owned;
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
):Promise<AllDeliveredMirrorPacket>{return preparePacket(input,observation,channel,updatedAt,operationId,'AllDelivered',undefined,signal);}
/** Every item is accounted for as Deliver or Skip. Skip decisions are provisional:
 * final native transaction revalidates all of them. Neither this factory nor its
 * chunk plan permits sending without a fresh ownership check by the coordinator. */
export async function prepareMixedMirrorPacket(input:BoundMirrorCursor,observation:AnchoredMirrorBatch,channel:bigint,updatedAt:number,operationId:string,modes:readonly MirrorDeliveryMode[],signal?:AbortSignal):Promise<MixedMirrorPacket>{
 return await preparePacket(input,observation,channel,updatedAt,operationId,'Mixed',modes,signal) as MixedMirrorPacket;
}
async function preparePacket(input:BoundMirrorCursor,observation:AnchoredMirrorBatch,channel:bigint,updatedAt:number,operationId:string,profile:Profile,inputModes:readonly MirrorDeliveryMode[]|undefined,signal?:AbortSignal):Promise<AllDeliveredMirrorPacket>{
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
 const modes=profile==='Mixed'?snapshotMirrorDeliveryModes(inputModes as readonly MirrorDeliveryMode[],batch.items.length):undefined;
 const skipped=modes===undefined?Object.freeze([]):snapshotMirrorSkippedItems(expected.thread,batch.items.filter((_item,index)=>modes[index]==='Skip'));
 const plan=modes===undefined?await planMirrorReceiptsOffThread(observation,channel,signal):await planMixedMirrorReceiptsOffThread(observation,channel,modes,signal),captured=plan.receipts;
 const next=await AnchoredMirrorBatch.prototype.observeNextBoundary.call(observation,signal);
 signal?.throwIfAborted();
 const result:AllDeliveredMirrorPacket=Object.freeze({...(modes===undefined?{}:{deliveryModes:modes}),expected,anchor:next.anchor,turn:batch.currentTurn??'',channel,updatedAt,operationId,receipts:captured,itemCount:batch.items.length,historyIntegrityVerified:false});
 packets.set(result,Object.freeze({profile,skipped,observation,receiptSetHash:plan.receiptSetHash,plan}));
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
export async function reconcileAllDeliveredMirrorPacket(store:NativeMirrorCursorStore,packet:AllDeliveredMirrorPacket,signal?:AbortSignal):Promise<MirrorPacketReconciliation>{return reconcilePacket(store,packet,'AllDelivered',signal);}
export async function reconcileMixedMirrorPacket(store:NativeMirrorCursorStore,packet:MixedMirrorPacket,signal?:AbortSignal):Promise<MirrorPacketReconciliation>{return reconcilePacket(store,packet,'Mixed',signal);}
async function reconcilePacket(store:NativeMirrorCursorStore,packet:AllDeliveredMirrorPacket,profile:Profile,signal?:AbortSignal):Promise<MirrorPacketReconciliation>{
 const owned=authentic(packet,profile);signal?.throwIfAborted();
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

export function mixedMirrorPacketSendPlan(packet:MixedMirrorPacket):MirrorReceiptPlan{return authentic(packet,'Mixed').plan;}
/** Authentic complete partition plus current skip proof, current mapping, delivered
 * receipts and exact cursor CAS. File observation remains non-atomic with DB; an
 * append-only producer contract remains required. No network or automatic resend. */
export async function commitMixedMirrorPacket(store:NativeMirrorCursorStore,packet:MixedMirrorPacket,limits:{readonly maxJobs:bigint;readonly maxValueBytes:bigint},signal?:AbortSignal):Promise<BoundMirrorCursor>{
 const owned=authentic(packet,'Mixed');signal?.throwIfAborted();
 const maxJobs=own(limits,'maxJobs'),maxValueBytes=own(limits,'maxValueBytes');
 if(typeof maxJobs!=='bigint'||maxJobs<1n||maxJobs>4096n||typeof maxValueBytes!=='bigint'||maxValueBytes<1n||maxValueBytes>4194304n)throw new RangeError('Invalid mirror skip queue limits');
 await AnchoredMirrorBatch.prototype.verifyCurrent.call(owned.observation,signal);signal?.throwIfAborted();
 return NativeMirrorCursorStore.prototype.advanceWithSkips.call(store,packet.expected,packet.anchor,packet.turn,packet.updatedAt,packet.operationId,packet.receipts,packet.channel,owned.skipped,{maxJobs,maxValueBytes},signal);
}
