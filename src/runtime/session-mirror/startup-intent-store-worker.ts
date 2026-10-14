import {performance} from 'node:perf_hooks';
import {recoverMirrorStartupContextNative,verifyMirrorStartupRecoveryNative,completeMirrorStartupRecoveryNative} from './startup-intent-recovery-native.ts';
import {MirrorStartupContextHeldError,snapshotMirrorStartupContextLimits} from './startup-context-limits.ts';
import {MirrorFileChangedError} from './file-window.ts';
import {parentPort,workerData as q} from 'node:worker_threads';
import {usingExistingReadOnlyStore,usingExistingStore} from '../../store/owned-scope.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
if(parentPort===null)throw new Error('Mirror startup intent store requires an owned native worker');
try{
 const started=performance.now(),cancel=new Int32Array(q.cancel);
 const check=()=>{if(Atomics.load(cancel,0)!==0)throw new MirrorStartupContextHeldError('Cancelled');if(performance.now()-started>=q.timeoutMs)throw new MirrorStartupContextHeldError('Deadline');};
 if(q.kind==='RecoverContext'){
  const value=await recoverMirrorStartupContextNative(q.path,q.thread,q.operationId,snapshotMirrorStartupContextLimits(q.limits),check);check();parentPort.postMessage({ok:true,value});
 }else if(q.kind==='CompleteContext'){
  const value=await completeMirrorStartupRecoveryNative(q.path,q.evidence,check);check();parentPort.postMessage({ok:true,value});
 }else if(q.kind==='VerifyContext'){
  await verifyMirrorStartupRecoveryNative(q.path,q.evidence,check);check();parentPort.postMessage({ok:true,value:null});
 }else{
 const run=(db:Parameters<typeof state.readPendingMirrorStartupIntent>[0])=>{
  switch(q.kind){
   case 'Schema':state.initializeMirrorStartupIntentJournal(db);return null;
   case 'Read':return state.readPendingMirrorStartupIntent(db,q.thread);
   case 'Retain':return state.retainPreparedMirrorStartupIntent(db,state.prepareMirrorStartupIntent(q.intent.thread,q.intent.cutoff,q.intent.createdAt,q.intent.operationId));
   default:throw new TypeError('Unsupported mirror startup intent request');
  }
 };
 const value=q.kind==='Read'?usingExistingReadOnlyStore(q.path,run):usingExistingStore(q.path,run,100);parentPort.postMessage({ok:true,value});
 }
}catch(error){parentPort.postMessage({ok:false,reason:error instanceof MirrorStartupContextHeldError?error.reason:error instanceof MirrorFileChangedError?'ChangedFile':null,detail:[...(error instanceof Error?error.message:'Mirror startup intent operation failed')].slice(0,2048).join('')});}
finally{parentPort.close();}
