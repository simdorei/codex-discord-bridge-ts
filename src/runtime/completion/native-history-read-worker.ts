import {serveReusableWorker} from '../reusable-worker-entry.ts';
import type {ReusableNativeOperation} from '../reusable-worker-operations.ts';
import * as stateRuntimeFenceReads from '../../store/runtime-fence-reads.ts';
import * as stateMirrorEventRead from '../../store/mirror-event-read.ts';
import * as stateObservedCompletion from '../../store/observed-completion.ts';
import * as stateObservedFinalAnswer from '../../store/observed-final-answer.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
export const runNativeOperation:ReusableNativeOperation=(q,port)=>{
try{
 let value:boolean|string|null;
 switch(q.operation){
  case 'Hold':value=stateRuntimeFenceReads.deadGenerationTargetHeldExisting(q.path,q.target);break;
  case 'Marker':value=stateMirrorEventRead.hasMirrorEventExisting(q.path,q.digest,q.target);break;
  case 'ResidentProof':value=stateObservedCompletion.hasObservedCompletionResidentEvidenceExisting(q.path,q.target,q.turn,q.generation,q.resident);break;
  case 'Final':value=stateObservedFinalAnswer.getObservedFinalAnswerExisting(q.path,q.target,q.turn,q.generation);break;
  default:throw new TypeError('Unsupported completion history read');
 }
 const result={ok:true,value};if(boundedSerdeByteCount(result,4*1024*1024)===null)throw new Error('History result exceeds native boundary');port.postMessage(result);
}catch{port.postMessage({ok:false});}finally{port.close();}
};
await serveReusableWorker(runNativeOperation);
