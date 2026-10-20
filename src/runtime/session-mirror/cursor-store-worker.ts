import {advanceMirrorCursorWithSkips} from './mixed-cursor-transaction.ts';
import {serveReusableWorker} from '../reusable-worker-entry.ts';
import type {ReusableNativeOperation} from '../reusable-worker-operations.ts';
import {usingExistingStore} from '../../store/owned-scope.ts';
import {usingExistingReadOnlyStore} from '../../store/owned-scope.ts';
import {initializeMirrorCursorJournal,readBoundMirrorCursor,initializeFreshMirrorCursor,advanceBoundMirrorCursor,advanceMappedMirrorCursor} from '../../store/mirror-cursor-journal.ts';
export const runNativeOperation:ReusableNativeOperation=(q,parentPort)=>{
try{
 const run=(db:Parameters<typeof readBoundMirrorCursor>[0])=>{
  switch(q.kind){
   case 'Read':return readBoundMirrorCursor(db,q.thread);
   case 'Schema':initializeMirrorCursorJournal(db);return null;
   case 'Initialize':return initializeFreshMirrorCursor(db,q.thread,q.anchor,q.turn,q.updatedAt,q.operationId);
   case 'MixedAdvance':return advanceMirrorCursorWithSkips(db,q.expected,q.anchor,q.turn,q.updatedAt,q.operationId,q.receipts,q.channel,q.skipped,q.maxJobs,q.maxValueBytes);
   case 'MappedAdvance':return advanceMappedMirrorCursor(db,q.expected,q.anchor,q.turn,q.updatedAt,q.operationId,q.receipts,q.channel);
   case 'Advance':return advanceBoundMirrorCursor(db,q.expected,q.anchor,q.turn,q.updatedAt,q.operationId,q.receipts);
   default:throw new TypeError('Unsupported mirror cursor request');
  }
 };
 const value=q.kind==='Read'?usingExistingReadOnlyStore(q.path,run):usingExistingStore(q.path,run,100);
 parentPort.postMessage({ok:true,value});
}catch(error){parentPort.postMessage({ok:false,detail:[...(error instanceof Error?error.message:'Mirror cursor operation failed')].slice(0,2048).join('')});}
finally{parentPort.close();}
};
await serveReusableWorker(runNativeOperation);
