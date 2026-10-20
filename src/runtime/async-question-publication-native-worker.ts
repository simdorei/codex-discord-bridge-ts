import {parentPort,workerData as q} from 'node:worker_threads';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {getAsyncQuestionExisting,requireCurrentAsyncQuestionMappingExisting,confirmAsyncQuestionOwnerExisting,bindAsyncQuestionReceiptExisting} from '../store/async-question-delivery-state.ts';
import {recordAsyncQuestionErrorExisting} from '../store/async-question-dispatch.ts';
import {requireAsyncQuestionOccurrence} from '../store/async-question-read.ts';
import {parsePublicationQuestion,questionPublicationBinding,QUESTION_PUBLICATION_BYTES} from './async-question-publication-protocol.ts';
const port=parentPort;if(port===null)throw new Error('Question publication requires owned native worker');
try{
 if(boundedSerdeByteCount(q,QUESTION_PUBLICATION_BYTES)===null)throw new RangeError('Question publication request exceeds native budget');
 const binding=questionPublicationBinding(q.id,q.path,q.operation,q.questionJson,q.detail);
 if(Object.keys(q).length!==Object.keys(binding).length)throw new TypeError('Invalid question publication request');for(const [key,value]of Object.entries(binding))if(!Object.is(q[key],value))throw new TypeError('Crossed question publication request');
 const original=parsePublicationQuestion(q.questionJson);let value:boolean;
 if(q.operation==='Prepare'){
  // Separate existing-only scopes preserve source order and never merge mapping
  // with the owner-confirm transaction. Both sides reject occurrence replacement.
  requireAsyncQuestionOccurrence(getAsyncQuestionExisting(q.path,original.id),original);
  requireCurrentAsyncQuestionMappingExisting(q.path,original);
  value=confirmAsyncQuestionOwnerExisting(q.path,original.id);
  const current=getAsyncQuestionExisting(q.path,original.id);requireAsyncQuestionOccurrence(current,original);if(current.state!=='observed')throw new TypeError('Question is no longer observed');
 }else if(q.operation==='Bind'){bindAsyncQuestionReceiptExisting(q.path,original.id,q.detail,original);value=true;}
 else if(q.operation==='Error'){recordAsyncQuestionErrorExisting(q.path,original.id,q.detail,original);value=true;}
 else throw new TypeError('Unknown question publication operation');
 const reply={...binding,ok:true,value};if(boundedSerdeByteCount(reply,QUESTION_PUBLICATION_BYTES)===null)throw new RangeError('Question publication reply exceeds native budget');port.postMessage(reply);
}catch{port.postMessage({ok:false});}finally{port.close();}
