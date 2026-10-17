import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {projectNativeStoreReadDiagnostic} from '../native-store-read-diagnostic.ts';
const port=parentPort;if(port===null)throw new Error('Control evidence requires owned worker');
const binding={id:q.id,path:q.path,operation:q.operation,thread:q.thread,turn:q.turn};
try{if(process.platform==='win32'||q.operation!=='Observed')throw new TypeError('Unsupported control evidence profile');const value=state.hasObservedCompletionExisting(q.path,q.thread,q.turn);port.postMessage({...binding,ok:true,value});}
catch(error){const storeDiagnostic=projectNativeStoreReadDiagnostic(error);port.postMessage(storeDiagnostic===null?{...binding,ok:false}:{...binding,ok:false,storeDiagnostic});}finally{port.close();}
