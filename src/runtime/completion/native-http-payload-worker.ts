import {parentPort,workerData as q} from 'node:worker_threads';
import * as stateCompletionPayload from '../../store/completion-payload.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('HTTP payload read requires owned worker');
try{
 if(!['Commentary','Goal','StartFailure','Question','Final'].includes(q.entry.source))throw new TypeError('Unexpected HTTP payload source');
 const payload=stateCompletionPayload.loadCompletionPayloadExisting(q.path,q.entry,q.runtime,q.generation),result={ok:true,payload};
 if(boundedSerdeByteCount(result,16*1024*1024)===null)throw new Error('HTTP payload response exceeds boundary');port.postMessage(result);
}catch{port.postMessage({ok:false});}finally{port.close();}
