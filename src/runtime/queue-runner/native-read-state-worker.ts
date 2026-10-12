import {parentPort,workerData as q} from 'node:worker_threads';import {StateAccessFacade as state} from '../../store/state-access-facade.ts';import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('Queue read requires owned worker');
try{
 let value:unknown;
 if(q.operation==='DeadTarget')value=state.deadGenerationTargetHeldExisting(q.path,q.target);
 else if(q.operation==='AsyncDispatch')value=state.asyncTargetDispatchHeldExisting(q.path,q.target);
 else if(q.operation==='List')value=state.listFilteredExisting(q.path,q.target,q.generation);
 else if(q.operation==='Eligible'){const selected=new Set<unknown>(state.eligibleJobsExisting(q.path,q.jobs));value=q.jobs.flatMap((job:unknown,index:number)=>selected.has(job)?[index]:[]);}
 else throw new TypeError('Unknown queue read operation');
 const result={ok:true,value};if(boundedSerdeByteCount(result,16*1024*1024)===null)throw new Error('Queue read response exceeds wire budget');port.postMessage(result);
}catch{port.postMessage({ok:false});}finally{port.close();}
