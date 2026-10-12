import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('Final state requires owned native worker');
try{
 let value:unknown;
 switch(q.operation){
  case 'Confirmed':value=state.completeConfirmedDelivery(q.path,q.pending,q.chunks);break;
  case 'Preflight':value=state.finalDeliveryPreflight(q.path,q.pending);break;
  case 'Failure':state.recordDeliveryFailureExisting(q.path,q.id,q.display,q.now);value=true;break;
  case 'Complete':value=state.completeDeliveryExisting(q.path,q.id);break;
  default:throw new TypeError('Unknown final state operation');
 }
 // Original failure writer fully selects/decodes before its ignored return is reduced.
 const result={ok:true,value};if(boundedSerdeByteCount(result,16*1024*1024)===null)throw new Error('Final state result exceeds native wire budget');port.postMessage(result);
}catch{port.postMessage({ok:false});}finally{port.close();}
