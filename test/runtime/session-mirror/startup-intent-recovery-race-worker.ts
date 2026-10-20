import {parentPort,workerData as q} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {appendFileSync,copyFileSync,renameSync} from 'node:fs';
import {recoverMirrorStartupContextNative,verifyMirrorStartupRecoveryNative} from '../../../src/runtime/session-mirror/startup-intent-recovery-native.ts';
if(parentPort===null)throw new Error('Expected test worker owner');
let checks=0;
try{
 const check=()=>{if(++checks!==q.changeAt)return;
  if(q.change==='Exit')process.exit(23);
  if(q.change==='Pending'){const db=new DatabaseSync(q.path);try{db.exec(q.sql);}finally{db.close();}}
  if(q.change==='File')appendFileSync(q.file,'{}\n');
  if(q.change==='Database'){copyFileSync(q.path,q.path+'.copy');renameSync(q.path,q.path+'.old');renameSync(q.path+'.copy',q.path);}
 };
 const value=q.kind==='VerifyContext'?await verifyMirrorStartupRecoveryNative(q.path,q.evidence,check):await recoverMirrorStartupContextNative(q.path,q.thread,q.operationId,q.limits,check);
 parentPort.postMessage({ok:true,checks,value});
}catch(error){parentPort.postMessage({ok:false,checks,name:error instanceof Error?error.name:'Unknown'});}
finally{parentPort.close();}
