import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade as state} from '../store/state-access-facade.ts';
import {passiveErrorText} from '../core/passive-error-text.ts';
const port=parentPort;if(port===null)throw new Error('Idle admission requires owned worker');
try{const value=state.beforeIdleMutationExisting(q.path,q.owner,q.generation,q.thread);port.postMessage({ok:true,value});}
catch(error){port.postMessage({ok:false,detail:Array.from(passiveErrorText(error,'Native idle admission failed')).slice(0,2048).join('')});}
finally{port.close();}
