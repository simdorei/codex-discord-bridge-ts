import {parentPort,workerData} from 'node:worker_threads';
import {decodeMirrorRecordWindow} from './record-window.ts';
if(parentPort===null)throw new Error('Mirror decode worker requires an owned parent');
try{const {bytes,startOffset,maxWindowBytes,maxRecordBytes,maxRecords}=workerData;parentPort.postMessage({ok:true,value:decodeMirrorRecordWindow(bytes,startOffset,maxWindowBytes,maxRecordBytes,maxRecords)});}
catch(error){parentPort.postMessage({ok:false,message:error instanceof Error?error.message:'Mirror decode failed'});}
finally{parentPort.close();}
