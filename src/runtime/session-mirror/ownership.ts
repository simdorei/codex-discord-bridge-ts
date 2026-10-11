import type {DatabaseSync} from 'node:sqlite';
import {boundedQueueJobsIn,boundedQueueJobsInTransaction} from '../../store/queue-snapshot.ts';
import {hasObservedCompletionIn} from '../../store/observed-completion.ts';
import {hasMirrorEventIn,turnOriginMarker} from '../../store/mirror-event-read.ts';
import {types} from 'node:util';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {snapshotStoredQueueJob,type StoredQueueJob} from '../../store/queue-read.ts';
import {userOriginMarker} from '../../store/mirror-origin.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {rustTrim,serdeField} from '../../app-server/value.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {MirrorItem} from './collect.ts';

interface OriginItem {readonly kind:string;readonly text:string;readonly turnId:string|null;}
function snapshot(input:MirrorItem):OriginItem{
 const value=cloneOwnedSerdeValue(input),kind=serdeField(value,'kind'),text=serdeField(value,'text'),turnId=serdeField(value,'turnId');
 requireDiscordText(text);if(turnId!==null)requireDiscordText(turnId);
 if(typeof kind!=='string'||!['User','Commentary','Final','Aborted','Failed'].includes(kind))throw new TypeError('Expected mirror item kind');
 return {kind,text,turnId};
}
function snapshotJobs(jobs:readonly StoredQueueJob[]):StoredQueueJob[]{
 if(types.isProxy(jobs)||!Array.isArray(jobs))throw new TypeError('Expected queue snapshot array');
 const result:StoredQueueJob[]=[];
 for(let i=0;i<jobs.length;i++){const d=Object.getOwnPropertyDescriptor(jobs,String(i));if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Expected own queue entry');result.push(snapshotStoredQueueJob(d.value));}
 return result;
}
function active(thread:string,item:OriginItem,jobs:readonly StoredQueueJob[]):boolean{
 return jobs.some(job=>job.targetThreadId===thread&&(job.state==='Starting'||job.state==='Running')&&item.turnId!==null&&job.turnId===item.turnId);
}
async function origin(path:string,thread:string,item:OriginItem,jobs:readonly StoredQueueJob[]):Promise<boolean>{
 if(item.kind!=='User')return false;
 if(promptOrigin(thread,item,jobs))return true;
 return item.turnId!==null?state.hasMirrorEvent(path,userOriginMarker(thread,item.turnId,item.text),thread):false;
}
export function discordActiveMirrorTurn(thread:string,input:MirrorItem,jobs:readonly StoredQueueJob[]):boolean{
 requireDiscordText(thread);return active(thread,snapshot(input),snapshotJobs(jobs));
}
export async function discordOriginMirrorUser(path:string,thread:string,input:MirrorItem,jobs:readonly StoredQueueJob[]):Promise<boolean>{
 requireDiscordText(thread);return origin(path,thread,snapshot(input),snapshotJobs(jobs));
}
export class MirrorOwnershipPendingError extends Error{
 readonly kind='MirrorOwnershipPending';
 constructor(){super('bot turn ownership is still being recorded; mirror cursor retained for retry');this.name='MirrorOwnershipPendingError';}
}
/** Refresh the poll-wide queue snapshot before considering each item. This is the
 * source's observation gate, not an atomic ownership certificate or cursor commit. */
export async function currentDiscordMirrorOwner(path:string,thread:string,input:MirrorItem):Promise<boolean>{
 requireDiscordText(thread);const item=snapshot(input),jobs=await state.listFiltered(path,thread,null);
 for(const job of jobs)if(job.state==='Running'&&job.turnId!==null&&await state.hasObservedCompletion(path,thread,job.turnId))throw new MirrorOwnershipPendingError();
 if(ownershipPendingState(jobs))throw new MirrorOwnershipPendingError();
 return await origin(path,thread,item,jobs)||(item.kind!=='User'&&active(thread,item,jobs));
}

/** Bounded source-order refresh on an existing readonly worker connection.
 * Queue snapshot is complete for this target; subsequent marker checks remain
 * separate observations as in the original path, not an atomic send certificate. */
export function currentDiscordMirrorOwnerIn(db:DatabaseSync,thread:string,input:MirrorItem,maxJobs:bigint,maxValueBytes:bigint):boolean{
 requireDiscordText(thread);const item=snapshot(input),jobs=boundedQueueJobsIn(db,maxJobs,maxValueBytes,thread);
 return currentOwnerWithJobsIn(db,thread,item,jobs);
}
function currentOwnerWithJobsIn(db:DatabaseSync,thread:string,item:OriginItem,jobs:readonly StoredQueueJob[]):boolean{
 requireSettledOwnershipIn(db,thread,jobs);
 return ownerAfterGateIn(db,thread,item,jobs);
}
function requireSettledOwnershipIn(db:DatabaseSync,thread:string,jobs:readonly StoredQueueJob[]):void{
 for(const job of jobs)if(job.state==='Running'&&job.turnId!==null&&hasObservedCompletionIn(db,thread,job.turnId))throw new MirrorOwnershipPendingError();
 if(ownershipPendingState(jobs))throw new MirrorOwnershipPendingError();
}
function ownerAfterGateIn(db:DatabaseSync,thread:string,item:OriginItem,jobs:readonly StoredQueueJob[]):boolean{
 let userOrigin=false;
 if(item.kind==='User'){
  userOrigin=promptOrigin(thread,item,jobs);
  if(!userOrigin&&item.turnId!==null)userOrigin=hasMirrorEventIn(db,userOriginMarker(thread,item.turnId,item.text),thread);
 }
 return userOrigin||(item.kind!=='User'&&active(thread,item,jobs));
}

function promptOrigin(thread:string,item:OriginItem,jobs:readonly StoredQueueJob[]):boolean{
 return jobs.some(job=>job.targetThreadId===thread&&job.turnId!==null&&rustTrim(job.prompt)===rustTrim(item.text)&&(item.turnId===null||job.turnId===item.turnId));
}
function ownershipPendingState(jobs:readonly StoredQueueJob[]):boolean{
 return jobs.some(job=>job.state==='Starting'||(job.state==='Running'&&job.goalWaiting));
}


export type CurrentMirrorDisposition='CurrentOwner'|'TurnOrigin'|'RecordedEvent'|'Unclaimed';
/** Fresh source gate followed by source's durable turn/event marker tail.
 * Caller still owns poll-snapshot and recent-text policy between those stages.
 * This is a point-in-time observation, not permanent skip/send authorization.
 * Final cursor transaction must revalidate any skipped item's disposition. */
export function currentMirrorDispositionIn(db:DatabaseSync,thread:string,input:MirrorItem,maxJobs:bigint,maxValueBytes:bigint):CurrentMirrorDisposition{
 requireDiscordText(thread);
 const captured=cloneOwnedSerdeValue(input) as MirrorItem,item=snapshot(captured),digest=serdeField(captured,'digest');requireDiscordText(digest);
 if(digest.length>1024||Buffer.byteLength(digest)>1024)throw new RangeError('Mirror digest budget exceeded');
 const owned=db.isTransaction?currentOwnerWithJobsIn(db,thread,item,boundedQueueJobsInTransaction(db,maxJobs,maxValueBytes,thread)):currentDiscordMirrorOwnerIn(db,thread,captured,maxJobs,maxValueBytes);
 if(owned)return 'CurrentOwner';
 if(item.kind!=='User'&&item.turnId!==null&&hasMirrorEventIn(db,turnOriginMarker(thread,item.turnId),thread))return 'TurnOrigin';
 if(hasMirrorEventIn(db,digest,thread))return 'RecordedEvent';
 return 'Unclaimed';
}

export class MirrorSkipUnprovenError extends Error{
 readonly itemIndex:number;
 constructor(itemIndex:number){super('Mirror skipped item no longer has current ownership or durable marker proof');this.itemIndex=itemIndex;this.name='MirrorSkipUnprovenError';}
}
/** Complete bounded skipped-item proof in the caller's active transaction.
 * Reads the complete target queue ONCE and checks unresolved ownership ONCE.
 * Caller supplies the authentic skipped subset; this leaf cannot prove coverage.
 * No cursor write, network, transaction lifecycle, or persistent permission.
 * Pending ownership fails before marker checks; every unclaimed item holds. */
export function requireCurrentMirrorSkipsIn(db:DatabaseSync,thread:string,input:readonly MirrorItem[],maxJobs:bigint,maxValueBytes:bigint):void{
 requireDiscordText(thread);
 if(types.isProxy(input)||!Array.isArray(input)||input.length>4096)throw new TypeError('Expected bounded skipped mirror item array');
 const items:{item:OriginItem;digest:string}[]=[];let bytes=Buffer.byteLength(thread);
 if(bytes>16384)throw new RangeError('Mirror skip target exceeds budget');
 for(let i=0;i<input.length;i++){
  const value=own(input,String(i)),kind=own(value,'kind'),text=own(value,'text'),turnId=own(value,'turnId'),digest=own(value,'digest');
  requireDiscordText(text);requireDiscordText(digest);if(turnId!==null)requireDiscordText(turnId);
  if(typeof kind!=='string'||!['User','Commentary','Final','Aborted','Failed'].includes(kind))throw new TypeError('Expected mirror item kind');
  if(text.length>1048576||digest.length>1024||(turnId!==null&&turnId.length>16384))throw new RangeError('Mirror skipped item exceeds budget');
  const textBytes=Buffer.byteLength(text),digestBytes=Buffer.byteLength(digest),turnBytes=Buffer.byteLength(turnId??'');bytes+=textBytes+digestBytes+turnBytes;
  if(bytes>1048576||digestBytes>1024||turnBytes>16384)throw new RangeError('Mirror skip batch exceeds budget');
  items.push({item:{kind,text,turnId},digest});
 }
 if(!db.isTransaction)throw new TypeError('Mirror skip proof requires active caller transaction');
 if(items.length===0)return;
 const jobs=boundedQueueJobsInTransaction(db,maxJobs,maxValueBytes,thread);
 requireSettledOwnershipIn(db,thread,jobs);
 for(let i=0;i<items.length;i++){
  const {item,digest}=items[i]!;
  if(ownerAfterGateIn(db,thread,item,jobs))continue;
  if(item.kind!=='User'&&item.turnId!==null&&hasMirrorEventIn(db,turnOriginMarker(thread,item.turnId),thread))continue;
  if(hasMirrorEventIn(db,digest,thread))continue;
  throw new MirrorSkipUnprovenError(i);
 }
}
