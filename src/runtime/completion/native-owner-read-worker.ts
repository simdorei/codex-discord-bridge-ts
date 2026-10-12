import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('Completion owner requires owned worker');
try{
 // Admission decodes the complete target list; finalization decodes the whole
 // queue. Neither may hide malformed rows by filtering state/turn before decode.
 if(q.scope!=='Admission'&&q.scope!=='Finalization'&&q.scope!=='History'&&q.scope!=='Waiting')throw new TypeError('Unknown owner read scope');
 const jobs=state.listFilteredExisting(q.path,q.scope==='Admission'?q.target:null,null),running=jobs.filter(j=>j.targetThreadId===q.target&&j.state==='Running');
 const owner=q.scope==='History'?(running.length===1?running[0]!:null):q.scope==='Waiting'?(running.find(j=>j.goalWaiting)??null):(running.find(j=>j.turnId===q.turn)??null);
 const result={ok:true,owner};if(boundedSerdeByteCount(result,4*1024*1024)===null)throw new Error('Owner result exceeds boundary');port.postMessage(result);
}catch{port.postMessage({ok:false});}finally{port.close();}
