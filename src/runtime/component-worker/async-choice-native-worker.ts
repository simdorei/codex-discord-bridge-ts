import {parentPort,workerData as q} from 'node:worker_threads';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {getAsyncQuestionExisting,requireCurrentAsyncQuestionMappingExisting} from '../../store/async-question-delivery-state.ts';
import {beginAsyncQuestionDispatchExisting,confirmAsyncQuestionDispatchExisting,rejectDefiniteAsyncQuestionExisting,recordAsyncQuestionErrorExisting} from '../../store/async-question-dispatch.ts';
import {validateAsyncDispatchGuardsExisting} from '../../store/async-question-guard.ts';
import {requireAsyncQuestionOccurrence} from '../../store/async-question-read.ts';
import {captureAsyncChoiceClick,asyncChoiceBinding,parseAsyncChoiceQuestion,parseAsyncChoiceClaim,snapshotAsyncChoiceQuestion,ASYNC_CHOICE_REQUEST_BYTES,ASYNC_CHOICE_REPLY_BYTES} from './async-choice-native-snapshot.ts';
const port=parentPort;if(port===null)throw new Error('AsyncChoice requires owned native worker');
try{

 if(boundedSerdeByteCount(q,ASYNC_CHOICE_REQUEST_BYTES)===null)throw new RangeError('AsyncChoice request exceeds native budget');
 const click=captureAsyncChoiceClick(q),binding=asyncChoiceBinding(q.id,q.path,q.operation,click,q.questionJson,q.claimJson,q.detail);
 if(Object.keys(q).length!==Object.keys(binding).length)throw new TypeError('Invalid AsyncChoice request');for(const [key,value]of Object.entries(binding))if(!Object.is(q[key],value))throw new TypeError('Crossed AsyncChoice request');
 const original=q.questionJson===null?null:parseAsyncChoiceQuestion(q.questionJson);let value:string|boolean;
 switch(q.operation){
  case 'Get':{const current=getAsyncQuestionExisting(q.path,click.questionId);if(original!==null)requireAsyncQuestionOccurrence(current,original);value=serializeSerdeValue(snapshotAsyncChoiceQuestion(current));break;}
  case 'Mapping':requireCurrentAsyncQuestionMappingExisting(q.path,original!);value=true;break;
  case 'Begin':value=serializeSerdeValue(snapshotAsyncChoiceQuestion(beginAsyncQuestionDispatchExisting(q.path,parseAsyncChoiceClaim(q.claimJson),original!)));break;
  case 'Guard':validateAsyncDispatchGuardsExisting(q.path,original!.threadId);value=true;break;
  case 'Confirm':confirmAsyncQuestionDispatchExisting(q.path,click.questionId,q.detail,original!);value=true;break;
  case 'Reject':rejectDefiniteAsyncQuestionExisting(q.path,click.questionId,q.detail,original!);value=true;break;
  case 'Error':recordAsyncQuestionErrorExisting(q.path,click.questionId,q.detail);value=true;break;
  default:throw new TypeError('Unknown AsyncChoice operation');
 }
 const reply={...binding,ok:true,value};if(boundedSerdeByteCount(reply,ASYNC_CHOICE_REPLY_BYTES)===null)throw new RangeError('AsyncChoice reply exceeds native budget');port.postMessage(reply);
}catch{port.postMessage({ok:false});}finally{port.close();}
