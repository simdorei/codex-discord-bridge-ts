import {parentPort,workerData as q} from 'node:worker_threads';
import {createMutationCustodyFence} from './mutation-custody-fence.ts';
import {passiveErrorText} from '../core/passive-error-text.ts';
const port=parentPort;if(port===null)throw new Error('Native mutation requires owned worker');
const bounded=(value:string)=>Array.from(value).slice(0,2048).join('');
try{
 const fence=createMutationCustodyFence(q.path,q.runtime,error=>bounded(passiveErrorText(error,'Native mutation failed')));
 // Explicit closed operation set. Original queue/stop validators run inside the
 // existing fence's transaction; no caller callback or arbitrary SQL is accepted.
 let result:unknown;
 switch(q.operation){
  case 'beginMutationWithOrigin':result=fence.beginMutationWithOrigin(q.input);break;
  case 'beginQueueMutation':result=fence.beginQueueMutation!(q.input);break;
  case 'beginStopMutation':result=fence.beginStopMutation!(q.input);break;
  case 'finishMutation':result=fence.finishMutation(q.input);break;
  case 'finishStopMutation':result=fence.finishStopMutation!(q.input);break;
  default:throw new TypeError('Unsupported native mutation operation');
 }
 if(q.operation.startsWith('begin')?result!==true:result!==undefined)throw new TypeError('Unconfirmed native mutation result');
 port.postMessage({ok:true});
}catch(error){port.postMessage({ok:false,detail:bounded(passiveErrorText(error,'Native mutation failed'))});}
finally{port.close();}
