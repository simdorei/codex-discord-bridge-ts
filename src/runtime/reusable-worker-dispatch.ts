import {workerData} from 'node:worker_threads';
import {storeWorkerClassification,storeWorkerPath} from './store-worker-manifest.ts';
import {loadReusableWorkerOperation,hasReusableWorkerOperation} from './reusable-worker-operations.ts';
import {serveReusableWorker} from './reusable-worker-entry.ts';
import {storeWorkerDispatchEnabled} from './store-worker-authority.ts';

/** The native lifetime is bound to either no writable store or one exact store.
 * Every operation is checked before its literal module is loaded. Its original
 * handler receives the original business input and completes scoped I/O before
 * the shared worker acknowledges it. No connection is cached between requests. */
export async function serveReusableDispatch(writable:boolean):Promise<void>{
 if(!storeWorkerDispatchEnabled())throw new TypeError('Reusable dispatch requires its owned native mode');
 const path=writable?storeWorkerPath(workerData,'path'):null;
 await serveReusableWorker(async(request,reply)=>{
  if(request===null||typeof request!=='object'||Object.keys(request).length!==3||typeof request.entry!=='string'||!Object.hasOwn(request,'input')||request.path!==path)throw new TypeError('Reusable native dispatch binding differs');
  const entry=new URL(request.entry),field=storeWorkerClassification(entry);
  if(!hasReusableWorkerOperation(entry)||field===undefined)throw new TypeError('Unreviewed reusable native operation');
  if(writable?field===null||storeWorkerPath(request.input,field)!==path:field!==null)throw new TypeError('Reusable native writable store differs');
  const operation=await loadReusableWorkerOperation(entry);await operation(request.input,reply);
 },true);
}
