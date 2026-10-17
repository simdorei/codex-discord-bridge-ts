import {parentPort,workerData} from 'node:worker_threads';
import {usingExistingReadOnlyStore} from '../../store/owned-scope.ts';
import {boundedMirrorTargetsIn} from '../../store/mirror-target-snapshot.ts';
import {boundedQueueJobsIn} from '../../store/queue-snapshot.ts';
if(parentPort===null)throw new Error('Mirror store discovery requires owned worker');
try{
 const snapshot=usingExistingReadOnlyStore(workerData.path,db=>{
  // Source performs the mapping query before the queue read. Separate bounded
  // read transactions preserve that order; no cross-query atomicity is claimed.
  const targets=boundedMirrorTargetsIn(db,workerData.maxTargets,workerData.maxValueBytes);
  const jobs=boundedQueueJobsIn(db,workerData.maxJobs,workerData.maxValueBytes);
  let bytes=0;const add=(n:number)=>{bytes+=n;if(bytes>workerData.maxOutputBytes)throw new RangeError('Complete mirror store output budget exceeded');};
  for(const target of targets){if(Buffer.byteLength(target.codexThreadId)>16384)throw new RangeError('Mirror target identity budget exceeded');add(Buffer.byteLength(target.codexThreadId)+Buffer.byteLength(target.threadTitle)+32);}
  for(const job of jobs){add(256);for(const value of [job.jobId,job.targetThreadId,job.prompt,job.turnId,job.lastError])if(value!==null)add(Buffer.byteLength(value));for(const value of job.baselineTurnIds)add(Buffer.byteLength(value)+8);}
  return {targets,jobs};
 });
 parentPort.postMessage({ok:true,...snapshot});
}catch(error){parentPort.postMessage({ok:false,detail:[...(error instanceof Error?error.message:'Mirror store discovery failed')].slice(0,2048).join('')});}
finally{parentPort.close();}
