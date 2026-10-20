import {parentPort,workerData} from 'node:worker_threads';
import {setTimeout as sleep} from 'node:timers/promises';
import {OAuthStore,OAuthError,OAuthTransactionBusy} from './oauth-store.ts';
const port=parentPort!;const store=new OAuthStore(workerData);
const active=new Set<Promise<void>>();let closing=false;
async function execute(id:number,operation:string,input:Record<string,unknown>){
 const deadline=performance.now()+5000;
 try{for(;;){
  // A retry timer can resume after its deadline even when the DB lock is free.
  if(closing||performance.now()>=deadline)throw new OAuthError('temporarily_unavailable');
  try{port.postMessage({id,ok:true,value:store.run(operation,input)});return;}
  catch(error){
   // Never replay an admitted transaction, COMMIT, rollback, or an unknown
   // storage failure. The synchronous transaction body contains no await.
   if(!(error instanceof OAuthTransactionBusy))throw error;
   const remaining=deadline-performance.now();if(remaining<=0)throw new OAuthError('temporarily_unavailable');await sleep(Math.min(25,remaining));
  }
 }}catch(error){port.postMessage({id,ok:false,code:error instanceof OAuthError?error.code:'server_error'});}
}
port.on('message',({id,operation,input})=>{
 if(operation==='close'){
  if(closing)return;closing=true;void Promise.allSettled([...active]).then(()=>{try{store.close();}finally{port.close();}});return;
 }
 const task=execute(id,operation,input);active.add(task);void task.finally(()=>active.delete(task)).catch(()=>{});
});
port.postMessage({ready:true});
