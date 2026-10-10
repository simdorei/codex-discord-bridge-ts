import {types} from 'node:util';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {snapshotStoredQueueJob,type StoredQueueJob} from '../../store/queue-read.ts';
import {userOriginMarker} from '../../store/mirror-origin.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {rustTrim,serdeField} from '../../app-server/value.ts';
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
 if(jobs.some(job=>job.targetThreadId===thread&&job.turnId!==null&&rustTrim(job.prompt)===rustTrim(item.text)&&(item.turnId===null||job.turnId===item.turnId)))return true;
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
 if(jobs.some(job=>job.state==='Starting'||(job.state==='Running'&&job.goalWaiting)))throw new MirrorOwnershipPendingError();
 return await origin(path,thread,item,jobs)||(item.kind!=='User'&&active(thread,item,jobs));
}
