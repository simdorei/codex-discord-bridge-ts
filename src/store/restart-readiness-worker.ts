import {parentPort,workerData} from 'node:worker_threads';
import {restartReadinessSnapshotBlocking} from './restart-readiness-blocking.ts';
if(parentPort===null)throw new Error('Restart snapshot requires an owned worker');
try{parentPort.postMessage({ok:true,value:restartReadinessSnapshotBlocking(workerData.path)});}
catch(error){parentPort.postMessage({ok:false,name:error instanceof Error?error.name:'UnknownError',message:error instanceof Error?error.message:'Restart snapshot failed'});}
finally{parentPort.close();}
