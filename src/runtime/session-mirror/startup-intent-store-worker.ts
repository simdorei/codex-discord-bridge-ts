import {parentPort,workerData as q} from 'node:worker_threads';
import {usingExistingReadOnlyStore,usingExistingStore} from '../../store/owned-scope.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
if(parentPort===null)throw new Error('Mirror startup intent store requires an owned native worker');
try{
 const run=(db:Parameters<typeof state.readPendingMirrorStartupIntent>[0])=>{
  switch(q.kind){
   case 'Schema':state.initializeMirrorStartupIntentJournal(db);return null;
   case 'Read':return state.readPendingMirrorStartupIntent(db,q.thread);
   case 'Retain':return state.retainPreparedMirrorStartupIntent(db,state.prepareMirrorStartupIntent(q.intent.thread,q.intent.cutoff,q.intent.createdAt,q.intent.operationId));
   default:throw new TypeError('Unsupported mirror startup intent request');
  }
 };
 const value=q.kind==='Read'?usingExistingReadOnlyStore(q.path,run):usingExistingStore(q.path,run,100);parentPort.postMessage({ok:true,value});
}catch(error){parentPort.postMessage({ok:false,detail:[...(error instanceof Error?error.message:'Mirror startup intent operation failed')].slice(0,2048).join('')});}
finally{parentPort.close();}
