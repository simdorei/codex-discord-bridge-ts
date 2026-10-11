import {AnchoredMirrorBatch} from './continuity-observation.ts';
import {encodeMirrorCursorAnchor,type MirrorCursorAnchor} from '../../core/mirror-cursor-anchor.ts';
import {snapshotBoundMirrorCursor,type BoundMirrorCursor} from '../../store/mirror-cursor-journal.ts';
import {snapshotExpectedReceiptBatch,type ExpectedReceipt} from '../../store/confirmed-receipt-batch.ts';
import {formatMirrorItem} from './collect.ts';
import {sessionMirrorIdentity,sessionMirrorReceiptExpectations} from './sender.ts';
import {requireDiscordText} from '../../discord/text.ts';
export interface AllDeliveredMirrorPacket{
 readonly expected:BoundMirrorCursor;readonly anchor:MirrorCursorAnchor;readonly turn:string;
 readonly channel:bigint;readonly updatedAt:number;readonly operationId:string;
 readonly receipts:readonly ExpectedReceipt[];readonly itemCount:number;
 readonly historyIntegrityVerified:false;
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
 if(batch.items.length>4096)throw new RangeError('Mirror packet item budget exceeded');
 let textBytes=0,keyBytes=0;const receipts:ExpectedReceipt[]=[];
 for(const item of batch.items){
  const text=formatMirrorItem(item);textBytes+=Buffer.byteLength(text);
  if(textBytes>1048576)throw new RangeError('Mirror packet text budget exceeded');
  for(const receipt of sessionMirrorReceiptExpectations(channel,sessionMirrorIdentity(batch.thread,item),text)){
   keyBytes+=Buffer.byteLength(receipt.key)+64;
   if(receipts.length>=4096||keyBytes>1048576)throw new RangeError('Mirror packet receipt budget exceeded');
   receipts.push(receipt);
  }
 }
 const captured=snapshotExpectedReceiptBatch(receipts);
 const next=await AnchoredMirrorBatch.prototype.observeNextBoundary.call(observation,signal);
 signal?.throwIfAborted();
 return Object.freeze({expected,anchor:next.anchor,turn:batch.currentTurn??'',channel,updatedAt,operationId,receipts:captured,itemCount:batch.items.length,historyIntegrityVerified:false});
}
