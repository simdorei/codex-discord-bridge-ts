import {createNativeQueueReadState} from './native-read-state.ts';
import type {IStateAccessFacade} from '../../store/state-access-facade.ts';
import {snapshotNewQueueJob,snapshotExpectedMirrorMapping,MirrorMappingChangedError,type NewQueueJob,type ExpectedMirrorMapping,type QueueEnqueueResult} from '../../store/queue-enqueue.ts';
import {ForkHandoffTargetMovedError} from '../../store/fork-handoff-admission.ts';
import {snapshotStoredQueueJob,type StoredQueueJob} from '../../store/queue-read.ts';
import {OwnedWorkerSlot} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';

const LIMIT=16*1024*1024;
export class NativeQueueSubmissionUnconfirmedError extends Error {
 constructor(cause:unknown){super('Queue submission result unconfirmed after actual native join; no automatic retry',{cause});this.name='NativeQueueSubmissionUnconfirmedError';}
}

/** Only a completed, joined response from our fixed worker may restore either
 * pre-insert retarget refusal. Diagnostic error classification is not authority.
 * Missing/late/malformed responses stay unconfirmed, even if a write committed. */
export function createNativeQueueSubmissionState(path:string,timeoutMs=5000):IStateAccessFacade {
 const reads=createNativeQueueReadState(path,timeoutMs),fixed=pinNativeRuntimePath(path);
 async function submit(given:string,input:NewQueueJob,mappingInput:ExpectedMirrorMapping|null):Promise<QueueEnqueueResult>{
  if(given!==path)throw new TypeError('Queue facade differs from original installation binding');
  const job=snapshotNewQueueJob(input),mapping=mappingInput===null?null:snapshotExpectedMirrorMapping(mappingInput);
  const data={path:fixed,job,mapping};
  if(boundedSerdeByteCount(data,LIMIT)===null)throw new RangeError('Queue submission exceeds native wire boundary');
  const slot=new OwnedWorkerSlot('Control');let admitted=false,raw:unknown;
  try{
   const pending=slot.run(new URL('./native-submission-worker.ts',import.meta.url),data,timeoutMs);admitted=slot.busy;
   try{raw=await pending;}finally{await slot.join();}
  }catch(error){if(admitted)throw new NativeQueueSubmissionUnconfirmedError(error);throw error;}
  let refusal:MirrorMappingChangedError|ForkHandoffTargetMovedError|undefined;
  try{
   if(boundedSerdeByteCount(raw,LIMIT)===null)throw new TypeError('Queue submission acknowledgement exceeds wire boundary');
   const kind=own(raw,'kind');
   if(kind==='Enqueued'){
    const value=own(raw,'value'),created=own(value,'created');if(typeof created!=='boolean')throw new TypeError('Expected enqueue created boolean');
    const stored=snapshotStoredQueueJob(own(value,'job') as StoredQueueJob);
    // A duplicate message intentionally returns the older full persisted job.
    // Only the newly-created branch is bound to this request identity.
    if(created&&(stored.jobId!==job.jobId||stored.targetThreadId!==job.targetThreadId||stored.channelId!==job.channelId||stored.discordMessageId!==job.discordMessageId))throw new TypeError('Inserted queue acknowledgement differs from request');
    return {created,job:stored};
   }
   if(kind==='MirrorChanged'){
    const channel=own(raw,'channel'),expected=own(raw,'expected'),actual=own(raw,'actual');
    if(mapping===null||channel!==mapping.discordChannelId||expected!==mapping.targetThreadId)throw new TypeError('Mirror refusal differs from captured request');
    if(actual!==null)requireDiscordText(actual);
    refusal=new MirrorMappingChangedError(mapping.discordChannelId,mapping.targetThreadId,actual);
   }else if(kind==='SourceMoved'){
    const source=own(raw,'source'),target=own(raw,'target');requireDiscordText(target);
    if(source!==job.targetThreadId)throw new TypeError('Source refusal differs from captured request');
    refusal=new ForkHandoffTargetMovedError(job.targetThreadId,target);
   }else throw new TypeError('No complete native queue submission acknowledgement');
  }catch(error){throw new NativeQueueSubmissionUnconfirmedError(error);}
  throw refusal;
 }
 return Object.freeze({...reads,
  enqueue:(given:string,input:NewQueueJob)=>submit(given,input,null),
  enqueueIfMirrorMatches:(given:string,input:NewQueueJob,mapping:ExpectedMirrorMapping)=>submit(given,input,mapping),
 });
}
