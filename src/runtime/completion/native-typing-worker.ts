import {serveReusableWorker} from '../reusable-worker-entry.ts';
import type {ReusableNativeOperation} from '../reusable-worker-operations.ts';
import * as stateQueueRead from '../../store/queue-read.ts';
import * as stateObservedCompletion from '../../store/observed-completion.ts';
import {snapshotStoredQueueJob} from '../../store/queue-read.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
export const runNativeOperation:ReusableNativeOperation=(q,port)=>{
try{
 // Preserve both original complete decoders and separate opens, in source order.
 const jobs=stateQueueRead.listFilteredExisting(q.path,null,null).map(snapshotStoredQueueJob);
 const terminals=stateObservedCompletion.pendingObservedCompletionsExisting(q.path);
 const result={ok:true,jobs:jobs.map(j=>({targetThreadId:j.targetThreadId,turnId:j.turnId,state:j.state,goalWaiting:j.goalWaiting,channelId:j.channelId})),terminals:terminals.map(t=>({threadId:t.threadId,turnId:t.turnId}))};
 if(boundedSerdeByteCount(result,16*1024*1024)===null)throw new Error('Typing inventory exceeds native boundary');port.postMessage(result);
}catch{port.postMessage({ok:false});}finally{port.close();}
};
await serveReusableWorker(runNativeOperation);
