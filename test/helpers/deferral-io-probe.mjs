import {parentPort,workerData} from 'node:worker_threads';
import {open} from 'node:fs/promises';
try{const file=await open(workerData.path,'r');await file.close();parentPort.postMessage({blocked:false});}
catch(error){parentPort.postMessage({blocked:String(error).includes('Forbidden held history IO')});}
finally{parentPort.close();}
