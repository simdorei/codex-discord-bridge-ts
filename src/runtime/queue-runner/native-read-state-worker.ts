import {serveReusableWorker} from '../reusable-worker-entry.ts';
import type {ReusableNativeOperation} from '../reusable-worker-operations.ts';import * as stateRuntimeFenceReads from '../../store/runtime-fence-reads.ts';
import * as stateAsyncAdmission from '../../store/async-resolution-admission.ts';
import * as stateQueueRead from '../../store/queue-read.ts';
import * as stateExecutionHold from '../../store/execution-hold.ts';import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {projectNativeStoreReadDiagnostic} from '../native-store-read-diagnostic.ts';
export const runNativeOperation:ReusableNativeOperation=(q,port)=>{
try{
 let value:unknown;
 if(q.operation==='DeadTarget')value=stateRuntimeFenceReads.deadGenerationTargetHeldExisting(q.path,q.target);
 else if(q.operation==='AsyncDispatch')value=stateAsyncAdmission.asyncQuestionTargetDispatchHeldExisting(q.path,q.target);
 else if(q.operation==='List')value=stateQueueRead.listFilteredExisting(q.path,q.target,q.generation);
 else if(q.operation==='Eligible'){const selected=new Set<unknown>(stateExecutionHold.eligibleJobsExisting(q.path,q.jobs));value=q.jobs.flatMap((job:unknown,index:number)=>selected.has(job)?[index]:[]);}
 else throw new TypeError('Unknown queue read operation');
 const result={ok:true,value};if(boundedSerdeByteCount(result,16*1024*1024)===null)throw new Error('Queue read response exceeds wire budget');port.postMessage(result);
}catch(error){const storeDiagnostic=q.operation==='List'?projectNativeStoreReadDiagnostic(error):null;port.postMessage(storeDiagnostic===null?{ok:false}:{ok:false,operation:'List',target:q.target,generation:q.generation,storeDiagnostic});}finally{port.close();}
};
await serveReusableWorker(runNativeOperation);
