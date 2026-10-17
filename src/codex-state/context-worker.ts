import {formatThreadList} from '../runtime/action-executor/thread-list-format.ts';
import {formatContextView} from '../runtime/context-view-format.ts';
import {parentPort,workerData} from 'node:worker_threads';
import {readContextBatchBlocking} from './context-batch.ts';
if(parentPort===null)throw new Error('Context worker requires an owned parent');
try{const batch=workerData.operation==='list'&&workerData.archived?null:readContextBatchBlocking(workerData.targets,workerData.budget,workerData.maxFiles,workerData.recentLimit,workerData.mode);const value=workerData.operation==='list'?formatThreadList(workerData.threads,workerData.selected,workerData.limit,workerData.archived,new Map(workerData.states),batch):workerData.operation==='render'?formatContextView(workerData.threads,batch!,workerData.refresh):batch;parentPort.postMessage({ok:true,value});}catch(error){parentPort.postMessage({ok:false,message:error instanceof Error?error.message:'context worker failed'});}finally{parentPort.close();}
