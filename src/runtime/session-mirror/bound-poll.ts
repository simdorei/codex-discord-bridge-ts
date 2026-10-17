import {types} from 'node:util';
import type {QueueStartCoordinator} from '../queue-runner/start-coordinator.ts';
import {captureMirrorMappingLocks,withMirrorMappingLocks} from './mapping-owner.ts';
import {MirrorSnapshotOwner} from './snapshot-owner.ts';
import {runMirrorWorker,type MirrorRunnerObservation} from './runner.ts';
import type {MirrorTargetFinished} from './execution.ts';
import {captureMirrorDiscoveryLimits,type MirrorDiscoveryLimits} from './discovery.ts';
import {captureMirrorStoreDiscoveryLimits,type MirrorStoreDiscoveryLimits} from './store-discovery.ts';
import type {MirrorSnapshotLimits} from './discovery-snapshot.ts';
import type {MirrorReadyLimits} from './ready.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';import {randomUUID} from 'node:crypto';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';import {requireDiscordText} from '../../discord/text.ts';
import type {DiscordReceiptTransport} from '../completion/receipt-sender.ts';
import type {MirrorThreadHint} from './discovery.ts';import type {MirrorPollCounts} from './execution.ts';
import {captureMirrorPollJobs,type MirrorStoreSnapshot} from './store-discovery.ts';
import {NativeMirrorCursorStore} from './cursor-store.ts';import type {MirrorOwnershipReadLimits} from './ownership-reader.ts';
import {snapshotMirrorReadLimits,type MirrorReadLimits} from './read-window.ts';
import {observeAnchoredMirrorBatch} from './continuity-observation.ts';
import {executeObservedMirrorBatch} from './observed-batch-executor.ts';
import {MirrorTargetBootstrapCoordinator} from './bootstrap-coordinator.ts';
import {snapshotMirrorStartupContextLimits,type MirrorStartupContextLimits} from './startup-context-limits.ts';
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
 * Stored detail is read inside the native decoder only after object events
 * exist, preserving the Rust empty-tail short circuit without a second parse.
 * No volatile text-cache skip is treated as durable evidence. */
export async function pollBoundMirrorTarget(databasePath:string,hint:MirrorThreadHint,channel:bigint,jobs:MirrorStoreSnapshot['jobs'],options:BoundMirrorPollOptions,transport:DiscordReceiptTransport,signal?:AbortSignal):Promise<MirrorPollCounts>{
 signal?.throwIfAborted();const path=pinNativeRuntimePath(boundedText(databasePath,32768));boundedText(path,32768);
 const thread=boundedText(own(hint,'id'),16384),rollout=pinNativeRuntimePath(boundedText(own(hint,'rolloutPath'),32768));boundedText(rollout,32768);
 if(typeof channel!=='bigint'||channel<=0n||channel>=(1n<<63n))throw new RangeError('Expected positive i64 mirror channel');
 captureMirrorPollJobs(path,thread,jobs);const {read,ownership}=snapshotBoundMirrorPollOptions(options),timeoutMs=ownership.timeoutMs;const store=new NativeMirrorCursorStore(path,timeoutMs);
 let expected;try{expected=await store.read(thread,signal)}finally{await store.close()}
 if(expected===null)throw new MirrorBoundCursorRequiredError();if(expected.anchor.path!==rollout)throw new MirrorRolloutBindingError();
 const observation=await observeAnchoredMirrorBatch(expected.anchor,read,{thread,detail:{databasePath:path},currentTurn:expected.turn===''?null:expected.turn},signal);
 // An unfinished tail can wait for its producer. Invalid or oversized records
 // must surface to the caller's failure/backoff path, never silently look idle.
 if(observation.batch.nextOffset===expected.anchor.offset){
  if(['OversizedRecord','InvalidUtf8','InvalidJson'].includes(observation.batch.stop))throw new MirrorPollRecordHeldError(observation.batch.stop);
  return Object.freeze({targets:0n,events:0n,sent:0n});
 }
 const result=await executeObservedMirrorBatch({databasePath:path,expected,observation,channel,updatedAt:Date.now(),operationId:randomUUID(),pollJobs:jobs,ownership},transport,signal);
 return result.counts;
}

export function snapshotBoundMirrorPollOptions(options:BoundMirrorPollOptions):BoundMirrorPollOptions{
 const read=snapshotMirrorReadLimits(own(options,'read') as MirrorReadLimits),raw=own(options,'ownership');
 const maxJobs=own(raw,'maxJobs'),maxValueBytes=own(raw,'maxValueBytes'),timeoutMs=own(raw,'timeoutMs');
 if(typeof maxJobs!=='bigint'||maxJobs<1n||maxJobs>4096n||typeof maxValueBytes!=='bigint'||maxValueBytes<1n||maxValueBytes>4194304n||typeof timeoutMs!=='number'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid bound mirror poll ownership limits');
 return Object.freeze({read,ownership:Object.freeze({maxJobs,maxValueBytes,timeoutMs})});
}
export interface MirrorWorkerBootstrapPolicy{
 readonly kind:'SkipExistingHistory';readonly context:MirrorStartupContextLimits;readonly totalTimeoutMs:number;
}
export interface BoundMirrorWorkerConfig{
 readonly stateDatabasePath:string;readonly bridgeDatabasePath:string;
 readonly discovery:MirrorSnapshotLimits;readonly ready:MirrorReadyLimits;readonly poll:BoundMirrorPollOptions;
 /** Explicit opt-in only. Both schemas must be prepared before worker startup.
  * The caller maintains stable DB identity/mapping and append-only production;
  * the worker shares mapping ownership with the original runtime queue. */
 readonly bootstrap?:MirrorWorkerBootstrapPolicy;
}
/** Concrete mirror loop using the same shared runner, native discovery and target
 * owner. Configuration is captured once before any async work and cannot retarget
 * a later epoch. Bindings must be preinitialized unless bootstrap is explicitly
 * selected. Bootstrap and polling share the existing target/channel owner, the
 * original queue target/global mapping locks, and cancellation lifetime without
 * an intermediate release or another loop. Global mapping ownership currently
 * serializes targets; this is a correctness guard, not performance qualification.
 * Requires a validated transport, independent producer contract and stable DB
 * identity/mapping under the caller's application-owned abort lifetime.
 * No service boot, schema creation, account login or independent retry mechanism. */
export async function runBoundMirrorWorker(config:BoundMirrorWorkerConfig,transport:DiscordReceiptTransport,render:(error:unknown)=>string,report:(event:MirrorRunnerObservation)=>void,signal:AbortSignal,queue:QueueStartCoordinator):Promise<readonly MirrorTargetFinished[]>{
 if(types.isProxy(signal)||!(signal instanceof AbortSignal))throw new TypeError('Expected owned abort signal');if(signal.aborted)return [];
 const captured=captureBoundMirrorWorkerConfig(config),locks=captureMirrorMappingLocks(queue,captured.bridgeDatabasePath);
 const {stateDatabasePath:state,bridgeDatabasePath:bridge,discovery,ready,poll,bootstrap}=captured;
 return runMirrorWorker(()=>new MirrorSnapshotOwner(state,bridge,discovery,ready,async(hint,channel,jobs,abort)=>withMirrorMappingLocks(locks,hint.id,abort,async()=>{
  if(bootstrap!==undefined){
   const startup=new MirrorTargetBootstrapCoordinator({databasePath:bridge,thread:hint.id,rolloutPath:hint.rolloutPath,channel,operationId:randomUUID(),createdAt:Date.now()/1000,...bootstrap});
   try{await startup.run(abort);}finally{await startup.close();}
   abort.throwIfAborted();
  }
  return pollBoundMirrorTarget(bridge,hint,channel,jobs,poll,transport,abort);
 }),render),render,report,signal);
}

/** Capture the complete worker configuration before a monitored task is queued. */
export function captureBoundMirrorWorkerConfig(config:BoundMirrorWorkerConfig):BoundMirrorWorkerConfig{
 const state=pinNativeRuntimePath(boundedText(own(config,'stateDatabasePath'),32768)),bridge=pinNativeRuntimePath(boundedText(own(config,'bridgeDatabasePath'),32768));boundedText(state,32768);boundedText(bridge,32768);
 const raw=own(config,'discovery'),discovery=Object.freeze({threads:captureMirrorDiscoveryLimits(own(raw,'threads') as MirrorDiscoveryLimits),store:captureMirrorStoreDiscoveryLimits(own(raw,'store') as MirrorStoreDiscoveryLimits)});
 const readyInput=own(config,'ready'),maxTargets=own(readyInput,'maxTargets'),maxBytes=own(readyInput,'maxBytes');
 if(typeof maxTargets!=='number'||!Number.isSafeInteger(maxTargets)||maxTargets<1||maxTargets>4096||typeof maxBytes!=='number'||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>1048576)throw new RangeError('Invalid mirror ready limits');
 const ready=Object.freeze({maxTargets,maxBytes}),poll=snapshotBoundMirrorPollOptions(own(config,'poll') as BoundMirrorPollOptions);
 const policy=Object.getOwnPropertyDescriptor(config,'bootstrap');
 if(policy!==undefined&&!Object.hasOwn(policy,'value'))throw new TypeError('Expected passive mirror bootstrap policy');
 let bootstrap:MirrorWorkerBootstrapPolicy|undefined;
 if(policy?.value!==undefined){
  const kind=own(policy.value,'kind'),totalTimeoutMs=own(policy.value,'totalTimeoutMs');
  if(kind!=='SkipExistingHistory'||typeof totalTimeoutMs!=='number'||!Number.isSafeInteger(totalTimeoutMs)||totalTimeoutMs<1||totalTimeoutMs>10000)throw new RangeError('Invalid explicit mirror bootstrap policy');
  bootstrap=Object.freeze({kind,totalTimeoutMs,context:snapshotMirrorStartupContextLimits(own(policy.value,'context') as MirrorStartupContextLimits)});
 }
 return Object.freeze({stateDatabasePath:state,bridgeDatabasePath:bridge,discovery,ready,poll,...(bootstrap===undefined?{}:{bootstrap})});
}
