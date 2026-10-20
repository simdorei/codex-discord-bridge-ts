import {parentPort,workerData as q} from 'node:worker_threads';
import * as stateQuestionRetention from '../store/async-question-retention.ts';
import * as stateQuestionObservation from '../store/async-question-observation.ts';
import * as stateObservedCompletion from '../store/observed-completion.ts';
import * as stateObservedFinalAnswer from '../store/observed-final-answer.ts';
import * as stateObservationLedger from '../store/observation-ledger.ts';
import * as stateObservationProof from '../store/observation-proof.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('Observation ledger requires owned native worker');
try{
 let value:unknown=null;
 switch(q.operation){
  case 'prepareQuestions':stateQuestionRetention.retireOldAsyncQuestionOwnerExisting(q.path,q.runtime,q.generation);stateQuestionObservation.reconcileAsyncQuestionObservationsExisting(q.path,q.runtime,q.generation);stateQuestionRetention.compactTerminalAsyncQuestionsExisting(q.path,Date.now()/1000);break;
  case 'questions':for(const record of q.records)stateQuestionObservation.recordAsyncQuestionObservationExisting(q.path,record);stateQuestionObservation.reconcileAsyncQuestionObservationsExisting(q.path,q.runtime,q.generation);break;
  case 'terminal':value=stateObservedCompletion.recordObservedCompletionForResidentExisting(q.path,q.thread,q.turn,q.generation,q.payload,q.resident);break;
  case 'final':value=stateObservedFinalAnswer.recordObservedFinalAnswerExisting(q.path,q.thread,q.turn,q.generation,q.content);break;
  case 'activate':stateObservationLedger.activateObservationExisting(q.path,q.scope);break;
  case 'discover':stateObservationLedger.discoverObservationExisting(q.path,q.scope,q.upper);break;
  case 'unknown':stateObservationLedger.markUnknownObservationExisting(q.path,q.scope,q.detail);break;
  case 'next':value=stateObservationLedger.nextObservationGapExisting(q.path,q.scope);break;
  case 'certify':value=stateObservationProof.certifyObservationExisting(q.path,q.scope,q.sequence,q.effects);break;
  case 'finish':value=stateObservationProof.finishObservationPageExisting(q.path,q.gap,q.through);break;
  case 'verified':value=stateObservationLedger.observationScopeVerifiedExisting(q.path,q.scope,q.through);break;
  default:throw new TypeError('Unsupported native observation operation');
 }
 if(boundedSerdeByteCount(value,1048500)===null)throw new TypeError('Observation result exceeds native boundary');
 port.postMessage({ok:true,value});
}catch{port.postMessage({ok:false,value:null});}finally{port.close();}
