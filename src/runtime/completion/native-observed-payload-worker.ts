import {parentPort,workerData as q} from 'node:worker_threads';
import * as stateCompletionPayload from '../../store/completion-payload.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('Observed payload requires owned worker');
try{
 if(q.entry?.source!=='Observed')throw new TypeError('Expected Observed source');
 const payload=stateCompletionPayload.loadCompletionPayloadExisting(q.path,q.entry,q.runtime,q.generation);
 if(payload!==null&&payload.kind!=='Observed')throw new Error('Unexpected completion payload');
 const result={ok:true,payload};if(boundedSerdeByteCount(result,16*1024*1024)===null)throw new Error('Observed payload envelope exceeds boundary');port.postMessage(result);
}catch{port.postMessage({ok:false});}finally{port.close();}
