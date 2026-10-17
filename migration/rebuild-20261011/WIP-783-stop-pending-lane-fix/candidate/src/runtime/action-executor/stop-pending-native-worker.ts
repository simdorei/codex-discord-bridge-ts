import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {serializeStopControl} from '../../store/stop-control-dispatch.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('Owned Stop worker required');
const binding={id:q.id,path:q.path,operation:q.operation,after:q.after};
try{if(process.platform==='win32'||q.operation!=='Pending')throw new TypeError('Unsupported Stop profile');const rows=state.pendingStopControlsAfter(q.path,q.after).map(([sequence,control])=>[sequence,serializeStopControl(control)]);const reply={...binding,ok:true,rows};if(boundedSerdeByteCount(reply,4*1024*1024)===null)throw new RangeError('Stop page exceeds native boundary');port.postMessage(reply);}catch{port.postMessage({...binding,ok:false});}finally{port.close();}
