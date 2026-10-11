import {parentPort,workerData as input} from 'node:worker_threads';
import {usingExistingReadOnlyStore} from '../../store/owned-scope.ts';
import {boundedHistoryPollTargetsIn} from '../../store/history-targets.ts';
if(parentPort===null)throw new Error('History target read requires owned native worker');
try{const targets=usingExistingReadOnlyStore(input.path,db=>boundedHistoryPollTargetsIn(db,new Set(input.allowed),input.startup,input.maxRows));parentPort.postMessage({ok:true,targets});}
catch(error){parentPort.postMessage({ok:false,detail:[...(error instanceof Error?error.message:'Native history target read failed')].slice(0,2048).join('')});}
finally{parentPort.close();}
