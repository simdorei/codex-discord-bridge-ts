import {resolve} from 'node:path';import {randomUUID} from 'node:crypto';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';import {requireDiscordText} from '../../discord/text.ts';
import type {DiscordReceiptTransport} from '../completion/receipt-sender.ts';
import type {MirrorThreadHint} from './discovery.ts';import type {MirrorPollCounts} from './execution.ts';
import {captureMirrorPollJobs,type MirrorStoreSnapshot} from './store-discovery.ts';
import {NativeMirrorCursorStore} from './cursor-store.ts';import {observeMirrorDetailMode,type MirrorOwnershipReadLimits} from './ownership-reader.ts';
import {snapshotMirrorReadLimits,type MirrorReadLimits} from './read-window.ts';
import {observeAnchoredMirrorBatch} from './continuity-observation.ts';
import {executeObservedMirrorBatch} from './observed-batch-executor.ts';
export interface BoundMirrorPollOptions{readonly read:MirrorReadLimits;readonly ownership:MirrorOwnershipReadLimits;}
export class MirrorBoundCursorRequiredError extends Error{constructor(){super('Mirror polling requires an explicitly initialized, generation-bound cursor; no adoption or reset performed');this.name='MirrorBoundCursorRequiredError';}}
export class MirrorPollRecordHeldError extends Error{readonly stop:string;constructor(stop:string){super('Mirror record held at current cursor: '+stop);this.name='MirrorPollRecordHeldError';this.stop=stop;}}
export class MirrorRolloutBindingError extends Error{constructor(){super('Discovered rollout differs from persisted mirror cursor path');this.name='MirrorRolloutBindingError';}}
function boundedText(value:unknown,max:number):string{requireDiscordText(value);if(value.includes('\0')||value.length>max||Buffer.byteLength(value)>max)throw new RangeError('Mirror poll identity exceeds budget');return value;}
/** One bounded poll under the caller's target/channel owner. This adapter joins
 * native cursor/detail/decode/receipt work; it never initializes a schema, adopts
 * a legacy cursor or resets on changed files. Missing bindings require a separate
 * explicit startup/reconciliation policy. The independent append-only producer
 * contract and real HTTP/queue ownership integration are still required.
 * Detail is validated before reading the window (including empty windows), a
 * conservative TS preflight rather than the Rust empty-tail error order.
 * No volatile text-cache skip is treated as durable evidence. */
export async function pollBoundMirrorTarget(databasePath:string,hint:MirrorThreadHint,channel:bigint,jobs:MirrorStoreSnapshot['jobs'],options:BoundMirrorPollOptions,transport:DiscordReceiptTransport,signal?:AbortSignal):Promise<MirrorPollCounts>{
 signal?.throwIfAborted();const path=resolve(boundedText(databasePath,32768));boundedText(path,32768);
 const thread=boundedText(own(hint,'id'),16384),rollout=resolve(boundedText(own(hint,'rolloutPath'),32768));boundedText(rollout,32768);
 if(typeof channel!=='bigint'||channel<=0n||channel>=(1n<<63n))throw new RangeError('Expected positive i64 mirror channel');
 captureMirrorPollJobs(path,thread,jobs);const read=snapshotMirrorReadLimits(own(options,'read') as MirrorReadLimits),raw=own(options,'ownership');
 const maxJobs=own(raw,'maxJobs'),maxValueBytes=own(raw,'maxValueBytes'),timeoutMs=own(raw,'timeoutMs');
 if(typeof maxJobs!=='bigint'||maxJobs<1n||maxJobs>4096n||typeof maxValueBytes!=='bigint'||maxValueBytes<1n||maxValueBytes>4194304n||typeof timeoutMs!=='number'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid bound mirror poll ownership limits');
 const ownership=Object.freeze({maxJobs,maxValueBytes,timeoutMs});const store=new NativeMirrorCursorStore(path,timeoutMs);
 let expected;try{expected=await store.read(thread,signal)}finally{await store.close()}
 if(expected===null)throw new MirrorBoundCursorRequiredError();if(expected.anchor.path!==rollout)throw new MirrorRolloutBindingError();
 const detail=await observeMirrorDetailMode(path,thread,timeoutMs,signal);
 const observation=await observeAnchoredMirrorBatch(expected.anchor,read,{thread,detail,currentTurn:expected.turn===''?null:expected.turn},signal);
 // An unfinished tail can wait for its producer. Invalid or oversized records
 // must surface to the caller's failure/backoff path, never silently look idle.
 if(observation.batch.nextOffset===expected.anchor.offset){
  if(['OversizedRecord','InvalidUtf8','InvalidJson'].includes(observation.batch.stop))throw new MirrorPollRecordHeldError(observation.batch.stop);
  return Object.freeze({targets:0n,events:0n,sent:0n});
 }
 const result=await executeObservedMirrorBatch({databasePath:path,expected,observation,channel,updatedAt:Date.now(),operationId:randomUUID(),pollJobs:jobs,ownership},transport,signal);
 return result.counts;
}
