import {formatContextView} from '../runtime/context-view-format.ts';
import {parentPort,workerData} from 'node:worker_threads';
import {readContextBatchBlocking} from './context-batch.ts';
if(parentPort===null)throw new Error('Context worker requires an owned parent');
try{const batch=readContextBatchBlocking(workerData.targets,workerData.budget,workerData.maxFiles,workerData.recentLimit,workerData.mode);parentPort.postMessage({ok:true,value:workerData.operation==='render'?formatContextView(workerData.threads,batch,workerData.refresh):batch});}catch(error){parentPort.postMessage({ok:false,message:error instanceof Error?error.message:'context worker failed'});}finally{parentPort.close();}
