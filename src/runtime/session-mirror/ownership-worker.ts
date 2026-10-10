import {parentPort,workerData} from 'node:worker_threads';
import {usingExistingReadOnlyStore} from '../../store/owned-scope.ts';
import {currentDiscordMirrorOwnerIn,MirrorOwnershipPendingError} from './ownership.ts';
if(parentPort===null)throw new Error('Mirror ownership requires owned worker');
try{
 const owned=usingExistingReadOnlyStore(workerData.path,db=>currentDiscordMirrorOwnerIn(db,workerData.thread,workerData.item,workerData.maxJobs,workerData.maxValueBytes));
 parentPort.postMessage({ok:true,owned});
}catch(error){
 parentPort.postMessage({ok:false,pending:error instanceof MirrorOwnershipPendingError,detail:[...(error instanceof Error?error.message:'Mirror ownership read failed')].slice(0,2048).join('')});
}finally{parentPort.close();}
