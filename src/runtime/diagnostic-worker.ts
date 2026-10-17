import {parentPort,workerData} from 'node:worker_threads';
import {diagnosticQueueBlocking,diagnosticReportBlocking} from './diagnostic-report-blocking.ts';
if(parentPort===null)throw new Error('Diagnostic worker requires owned parent');
try{const value=workerData.operation==='queue'?diagnosticQueueBlocking(workerData.path):diagnosticReportBlocking(workerData.paths);parentPort.postMessage({ok:true,value});}catch(error){parentPort.postMessage({ok:false,message:error instanceof Error?error.message:'diagnostic worker failed'});}finally{parentPort.close();}
