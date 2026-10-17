import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('Completion heads require owned worker');
try{const entries=state.completionHeadsForTargetExisting(q.path,q.target,q.runtime,q.generation);if(entries.length>5||boundedSerdeByteCount(entries,65000)===null)throw new Error('Completion head result exceeds budget');port.postMessage({ok:true,entries});}catch{port.postMessage({ok:false,entries:null});}finally{port.close();}
