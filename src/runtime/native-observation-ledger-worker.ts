import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade as state} from '../store/state-access-facade.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('Observation ledger requires owned native worker');
try{
 let value:unknown=null;
 switch(q.operation){
  case 'terminal':value=state.recordObservedCompletionForResidentExisting(q.path,q.thread,q.turn,q.generation,q.payload,q.resident);break;
  case 'final':value=state.recordObservedFinalAnswerExisting(q.path,q.thread,q.turn,q.generation,q.content);break;
  case 'activate':state.activateObservationExisting(q.path,q.scope);break;
  case 'discover':state.discoverObservationExisting(q.path,q.scope,q.upper);break;
  case 'unknown':state.markUnknownObservationExisting(q.path,q.scope,q.detail);break;
  case 'next':value=state.nextObservationGapExisting(q.path,q.scope);break;
  case 'certify':value=state.certifyObservationExisting(q.path,q.scope,q.sequence,q.effects);break;
  case 'finish':value=state.finishObservationPageExisting(q.path,q.gap,q.through);break;
  case 'verified':value=state.observationScopeVerifiedExisting(q.path,q.scope,q.through);break;
  default:throw new TypeError('Unsupported native observation operation');
 }
 if(boundedSerdeByteCount(value,1048500)===null)throw new TypeError('Observation result exceeds native boundary');
 port.postMessage({ok:true,value});
}catch{port.postMessage({ok:false,value:null});}finally{port.close();}
