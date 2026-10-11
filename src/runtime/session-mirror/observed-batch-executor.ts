import {encodeMirrorCursorAnchor} from '../../core/mirror-cursor-anchor.ts';
import {resolve} from 'node:path';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {snapshotBoundMirrorCursor,type BoundMirrorCursor} from '../../store/mirror-cursor-journal.ts';
import type {DiscordReceiptTransport} from '../completion/receipt-sender.ts';
import {AnchoredMirrorBatch} from './continuity-observation.ts';
import {captureMirrorPollJobs,type MirrorStoreSnapshot} from './store-discovery.ts';
import {observeSourceMirrorDisposition,observeSourceMirrorDispositions,type MirrorOwnershipReadLimits} from './ownership-reader.ts';
import {NativeMirrorCursorStore} from './cursor-store.ts';import {NativeMirrorReceiptStore} from './receipt-store.ts';
import {prepareMixedMirrorPacket,mixedMirrorPacketSendPlan,commitMixedMirrorPacket,type MixedMirrorPacket} from './all-delivered-packet.ts';
import type {MirrorDeliveryMode} from './receipt-plan.ts';import type {MirrorPollCounts} from './execution.ts';
export interface ObservedMirrorBatchRequest{
 readonly databasePath:string;readonly expected:BoundMirrorCursor;readonly observation:AnchoredMirrorBatch;readonly channel:bigint;
 readonly updatedAt:number;readonly operationId:string;readonly pollJobs:MirrorStoreSnapshot['jobs'];readonly ownership:MirrorOwnershipReadLimits;
}
export class MirrorBatchPolicyChangedError extends Error{constructor(){super('Mirror ownership changed or only historical suppression remains; cursor retained');this.name='MirrorBatchPolicyChangedError';}}
/** Retain exact packet for read-only reconciliation after joined work. A failure
 * never grants permission to repeat HTTP or infer that a cursor write was absent. */
export class MirrorBatchExecutionError extends Error{
 readonly packet:MixedMirrorPacket|null;
 constructor(cause:unknown,packet:MixedMirrorPacket|null){super('Observed mirror batch did not finish; retain cursor and reconcile exact packet',{cause});this.name='MirrorBatchExecutionError';this.packet=packet;}
}
/** Execute one already bounded, authentic observed batch under the caller's
 * target/channel owner. Owns and joins both native stores. No schema initialization,
 * automatic retries, cursor adoption, file discovery or service startup.
 * Caller still owes the independent append-only producer contract and live runtime
 * ownership integration: fresh observations are not atomic with external HTTP.
 * Volatile recent-text cache is not advancement evidence; same delivery identity
 * reuses durable receipts instead. Counts.sent means satisfied item deliveries,
 * including reused receipts, not number of outbound HTTP requests. */
export async function executeObservedMirrorBatch(request:ObservedMirrorBatchRequest,transport:DiscordReceiptTransport,signal?:AbortSignal):Promise<Readonly<{packet:MixedMirrorPacket;cursor:BoundMirrorCursor;counts:MirrorPollCounts}>>{
 signal?.throwIfAborted();const rawPath=own(request,'databasePath');requireDiscordText(rawPath);
 if(rawPath.includes('\0')||rawPath.length>32768||Buffer.byteLength(rawPath)>32768)throw new RangeError('Mirror database path exceeds budget');
 const path=resolve(rawPath),expected=snapshotBoundMirrorCursor(own(request,'expected') as BoundMirrorCursor),observation=own(request,'observation') as AnchoredMirrorBatch;
 const {batch,expectedAnchor}=AnchoredMirrorBatch.prototype.captured.call(observation),jobs=own(request,'pollJobs') as MirrorStoreSnapshot['jobs'];captureMirrorPollJobs(path,expected.thread,jobs);
 const channel=own(request,'channel'),updatedAt=own(request,'updatedAt'),operationId=own(request,'operationId'),rawLimits=own(request,'ownership');requireDiscordText(operationId);
 if(typeof channel!=='bigint'||channel<=0n||channel>=(1n<<63n)||typeof updatedAt!=='number'||!Number.isFinite(updatedAt)||updatedAt<0||operationId.length===0||operationId.length>128||Buffer.byteLength(operationId)>128)throw new TypeError('Invalid observed mirror batch request');
 const maxJobs=own(rawLimits,'maxJobs'),maxValueBytes=own(rawLimits,'maxValueBytes'),timeoutMs=own(rawLimits,'timeoutMs');
 if(typeof maxJobs!=='bigint'||maxJobs<1n||maxJobs>4096n||typeof maxValueBytes!=='bigint'||maxValueBytes<1n||maxValueBytes>4194304n||typeof timeoutMs!=='number'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid observed mirror ownership limits');
 const limits=Object.freeze({maxJobs,maxValueBytes,timeoutMs});
 if(batch.thread!==expected.thread||batch.items.length>4096||(batch.priorTurn??'')!==expected.turn||encodeMirrorCursorAnchor(expectedAnchor)!==encodeMirrorCursorAnchor(expected.anchor))throw new TypeError('Observed mirror batch identity or item bound mismatch');
 let bytes=Buffer.byteLength(batch.thread);for(const item of batch.items){for(const value of [item.text,item.digest,item.kind,item.phase,item.turnId??''])bytes+=Buffer.byteLength(value);if(bytes>1048576)throw new RangeError('Observed mirror batch input exceeds one MiB');}
 const cursor=new NativeMirrorCursorStore(path,timeoutMs),receipt=new NativeMirrorReceiptStore(path,expected.thread,channel,timeoutMs);let packet:MixedMirrorPacket|null=null;
 try{
  const modes:MirrorDeliveryMode[]=[];
  for(const disposition of await observeSourceMirrorDispositions(path,expected.thread,batch.items,limits,jobs,signal)){
   signal?.throwIfAborted();
   if(disposition==='HistoricalOwner')throw new MirrorBatchPolicyChangedError();
   modes.push(disposition==='Unclaimed'?'Deliver':'Skip');
  }
  packet=await prepareMixedMirrorPacket(expected,observation,channel,updatedAt,operationId,modes,signal,path);const plan=mixedMirrorPacketSendPlan(packet);let sent=0n;
  for(let index=0;index<modes.length;index++)if(modes[index]==='Deliver'){
   signal?.throwIfAborted();if(plan.itemAlreadyConfirmed(receipt,index)){sent++;continue;}const current=await observeSourceMirrorDisposition(path,expected.thread,batch.items[index]!,limits,jobs,signal);
   if(current!=='Unclaimed')throw new MirrorBatchPolicyChangedError();
   await plan.sendItem(receipt,transport,index,signal);sent++;
  }
  const committed=await commitMixedMirrorPacket(cursor,packet,limits,signal);
  return Object.freeze({packet,cursor:committed,counts:Object.freeze({targets:1n,events:BigInt(batch.eventCount),sent})});
 }catch(error){throw new MirrorBatchExecutionError(error,packet);}
 finally{await Promise.all([receipt.close(),cursor.close()]);}
}
