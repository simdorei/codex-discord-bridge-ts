import {parentPort,workerData as q} from 'node:worker_threads';
import {recordUserOriginExisting} from '../../store/mirror-origin-existing.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {captureSteerOrigin,steerOriginBinding,STEER_ORIGIN_REQUEST_BYTES,STEER_ORIGIN_REPLY_BYTES} from './steer-origin-snapshot.ts';
const port=parentPort;if(port===null)throw new Error('Owned Steer origin worker required');
try{
 if(process.platform==='win32')throw new TypeError('Windows Steer origin writer unqualified');
 if(boundedSerdeByteCount(q,STEER_ORIGIN_REQUEST_BYTES)===null)throw new RangeError('Steer origin request exceeds native budget');
 const op=captureSteerOrigin(q.input),binding=steerOriginBinding(q.id,q.path,op);
 if(Object.keys(q).length!==Object.keys(binding).length+1)throw new TypeError('Invalid Steer origin request');
 for(const [key,value] of Object.entries(binding))if(q[key]!==value)throw new TypeError('Crossed Steer origin request');
 recordUserOriginExisting(q.path,op.thread,op.turn,op.prompt,op.now);
 const reply={...binding,ok:true};if(boundedSerdeByteCount(reply,STEER_ORIGIN_REPLY_BYTES)===null)throw new RangeError('Steer origin reply exceeds native budget');port.postMessage(reply);
}catch{port.postMessage({ok:false});}finally{port.close();}
