import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('History read requires owned worker');
try{
 let value:boolean|string|null;
 switch(q.operation){
  case 'Hold':value=state.deadGenerationTargetHeldExisting(q.path,q.target);break;
  case 'Marker':value=state.hasMirrorEventExisting(q.path,q.digest,q.target);break;
  case 'ResidentProof':value=state.hasObservedCompletionResidentEvidenceExisting(q.path,q.target,q.turn,q.generation,q.resident);break;
  case 'Final':value=state.getObservedFinalAnswerExisting(q.path,q.target,q.turn,q.generation);break;
  default:throw new TypeError('Unsupported completion history read');
 }
 const result={ok:true,value};if(boundedSerdeByteCount(result,4*1024*1024)===null)throw new Error('History result exceeds native boundary');port.postMessage(result);
}catch{port.postMessage({ok:false});}finally{port.close();}
