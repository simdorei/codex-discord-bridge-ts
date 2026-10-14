import {parentPort,workerData as q} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {appendFileSync,copyFileSync,renameSync} from 'node:fs';
import {completeMirrorStartupRecoveryNative} from '../../../src/runtime/session-mirror/startup-intent-recovery-native.ts';
if(parentPort===null)throw new Error('Expected test worker owner');
let checks=0;
try{
 const check=()=>{if(++checks!==q.changeAt)return;
  if(q.change==='Pending'){const db=new DatabaseSync(q.path);try{db.exec(q.sql);}finally{db.close();}}
  if(q.change==='File')appendFileSync(q.evidence.context.anchor.path,'{}\n');
  if(q.change==='Database'){copyFileSync(q.path,q.path+'.copy');renameSync(q.path,q.path+'.old');renameSync(q.path+'.copy',q.path);}
 };
 const value=await completeMirrorStartupRecoveryNative(q.path,q.evidence,check);
 if(q.stage!==undefined)Atomics.store(new Int32Array(q.stage),0,1);
 if(q.exitAfterCommit)process.exit(23);
 if(q.delayAfterMs)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,q.delayAfterMs);
 parentPort.postMessage({ok:true,checks,value:q.badReply?{...value,cursor:{...value.cursor,turn:'forged'}}:value});
}catch(error){parentPort.postMessage({ok:false,checks,name:error instanceof Error?error.name:'Unknown',detail:error instanceof Error?error.message:'Unknown'});}
finally{parentPort.close();}
