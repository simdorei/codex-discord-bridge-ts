import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {usingExistingStore} from '../../../src/store/owned-scope.ts';
import {completeMirrorStartupRecoveryNative} from '../../../src/runtime/session-mirror/startup-intent-recovery-native.ts';
if(parentPort===null)throw new Error('Expected owned test worker');
try{
 let value:unknown=null;
 if(!q.beforeWrite){
  if(q.kind==='Retain')value=usingExistingStore(q.path,db=>state.retainPreparedMirrorStartupIntent(db,state.prepareMirrorStartupIntent(q.intent.thread,q.intent.cutoff,q.intent.createdAt,q.intent.operationId)),100);
  else if(q.kind==='CompleteContext')value=await completeMirrorStartupRecoveryNative(q.path,q.evidence,()=>{});
  else throw new TypeError('Unexpected fault request');
 }
 if(q.stage!==undefined){const stage=new Int32Array(q.stage);if(stage.length>1)Atomics.store(stage,1,Atomics.load(new Int32Array(q.cancel),0));Atomics.store(stage,0,1);}
 if(q.delayMs)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,q.delayMs);
 if(q.loseReply)process.exit(23);
 parentPort.postMessage({ok:true,value});
}catch(error){parentPort.postMessage({ok:false,detail:error instanceof Error?error.message:'Fault worker failure'});}
finally{parentPort.close();}
