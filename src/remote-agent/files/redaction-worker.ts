import {parentPort,workerData} from 'node:worker_threads';import {redactRemoteTextCpu} from './redaction-cpu.ts';
if(parentPort===null)throw new Error('Remote redaction requires an owned CPU worker');
try{parentPort.postMessage({ok:true,text:redactRemoteTextCpu(workerData)});}catch{parentPort.postMessage({ok:false});}finally{parentPort.close();}
