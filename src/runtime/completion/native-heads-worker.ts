import {serveReusableWorker} from '../reusable-worker-entry.ts';
import type {ReusableNativeOperation} from '../reusable-worker-operations.ts';
import * as stateCompletionMetadata from '../../store/completion-metadata.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
export const runNativeOperation:ReusableNativeOperation=(q,port)=>{
try{const entries=stateCompletionMetadata.completionHeadsForTargetExisting(q.path,q.target,q.runtime,q.generation);if(entries.length>5||boundedSerdeByteCount(entries,65000)===null)throw new Error('Completion head result exceeds budget');port.postMessage({ok:true,entries});}catch{port.postMessage({ok:false,entries:null});}finally{port.close();}
};
await serveReusableWorker(runNativeOperation);
