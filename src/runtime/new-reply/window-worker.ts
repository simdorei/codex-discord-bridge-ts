import {parentPort,workerData} from 'node:worker_threads';
import {scanNewReplyWindow} from './window.ts';
if(parentPort===null)throw new Error('New reply scan requires owned native worker');
try{const q=workerData;parentPort.postMessage({ok:true,value:scanNewReplyWindow(q.bytes,q.offset,q.identity,q.state,q.limits)});}
catch(error){parentPort.postMessage({ok:false,message:error instanceof Error?error.message:'New reply scan failed'});}
finally{parentPort.close();}
