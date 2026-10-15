import {parentPort,workerData as q} from 'node:worker_threads';
import {createBusyChoiceExisting} from '../../store/busy-choice-store.ts';
import {bindBusyControlExisting} from '../../store/control-binding.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {captureBusyCreate,busyCreateBinding,BUSY_CREATE_REQUEST_BYTES,BUSY_CREATE_REPLY_BYTES} from './busy-create-snapshot.ts';
const port=parentPort;if(port===null)throw new Error('Owned busy creation worker required');
let binding:ReturnType<typeof busyCreateBinding>|undefined;
try{
 if(process.platform==='win32')throw new TypeError('Windows busy creation is unqualified');
 if(boundedSerdeByteCount(q,BUSY_CREATE_REQUEST_BYTES)===null)throw new RangeError('Busy creation envelope exceeds budget');
 const op=captureBusyCreate(q.input);binding=busyCreateBinding(q.id,q.path,q.choiceId,op);
 for(const [key,value] of Object.entries(binding))if(!Object.is(q[key],value))throw new TypeError('Crossed busy creation request');
 // Original, separate commits. No cancellation check or asynchronous handoff
 // between them: a committed insertion must attempt its original binding.
 const input={ownerUserId:op.ownerUserId,channelId:op.channelId,targetThreadId:op.thread,prompt:op.prompt,allowSteer:op.allowSteer,now:op.now,timeToLive:1800};
 createBusyChoiceExisting(q.path,input,op.mapped,q.choiceId);
 bindBusyControlExisting(q.path,q.choiceId,op.thread,op.turn,op.job,input,op.mapped);
 const reply={...binding,ok:true};if(boundedSerdeByteCount(reply,BUSY_CREATE_REPLY_BYTES)===null)throw new RangeError('Busy acknowledgement exceeds budget');port.postMessage(reply);
}catch{port.postMessage({...binding,ok:false});}finally{port.close();}
