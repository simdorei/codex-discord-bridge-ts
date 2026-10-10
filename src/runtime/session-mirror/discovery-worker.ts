import {parentPort,workerData} from 'node:worker_threads';
import {CodexThreadStore} from '../../codex-state/store.ts';
if(parentPort===null)throw new Error('Mirror discovery requires owned worker');
try{
 const rows=CodexThreadStore.open(workerData.path).loadRecentThreadsBounded(workerData.maxRows,workerData.maxValueBytes);let bytes=0;const hints=[];
 for(const row of rows){const idBytes=Buffer.byteLength(row.id),pathBytes=Buffer.byteLength(row.rolloutPath);if(idBytes>16384||pathBytes>32768)throw new RangeError('Mirror thread/path identity budget exceeded');bytes+=idBytes+pathBytes+16;if(bytes>workerData.maxOutputBytes)throw new RangeError('Complete mirror discovery output budget exceeded');hints.push({id:row.id,rolloutPath:row.rolloutPath});}
 parentPort.postMessage({ok:true,hints});
}catch(error){parentPort.postMessage({ok:false,detail:[...(error instanceof Error?error.message:'Mirror discovery failed')].slice(0,2048).join('')});}
finally{parentPort.close();}
