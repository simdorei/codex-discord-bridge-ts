import {parentPort,workerData as input} from 'node:worker_threads';
import {usingExistingReadOnlyStore,withStoreTransaction,rollbackStore} from '../../store/owned-scope.ts';
import {archiveRowDigestsIn} from './row-digests.ts';
if(parentPort===null)throw new Error('Archive evidence requires native owner');
try{
 const digests=usingExistingReadOnlyStore(input.path,db=>withStoreTransaction(db,'DEFERRED',()=>rollbackStore(archiveRowDigestsIn(db,input.kind,input.id,{maxRows:input.maxRows,maxBytes:input.maxBytes}))));
 parentPort.postMessage({ok:true,digests});
}catch(error){parentPort.postMessage({ok:false,detail:[...(error instanceof Error?error.message:'Archive evidence failed')].slice(0,2048).join('')});}
finally{parentPort.close();}
