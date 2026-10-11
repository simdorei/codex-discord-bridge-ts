import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade as state} from '../store/state-access-facade.ts';
import {passiveErrorText} from '../core/passive-error-text.ts';
const port=parentPort;if(port===null)throw new Error('Idle admission requires owned worker');
try{let value:unknown;switch(q.operation){case 'before':value=state.beforeIdleMutationExisting(q.path,q.owner,q.generation,q.thread);break;case 'transition':value=state.transitionIdleIntentExisting(q.path,q.token,q.state,q.detail);break;default:throw new TypeError('Unsupported native idle operation');}port.postMessage({ok:true,value});}
catch(error){port.postMessage({ok:false,detail:Array.from(passiveErrorText(error,'Native idle admission failed')).slice(0,2048).join('')});}
finally{port.close();}
