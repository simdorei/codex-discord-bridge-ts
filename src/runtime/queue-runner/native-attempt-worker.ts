import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('Queue attempt requires owned worker');
try{
 let value:unknown;
 if(q.operation==='Preflight')value=state.recordPreflightFailureExisting(q.path,q.jobId,q.generation,q.error);
 else if(q.operation==='Claim')value=state.tryBeginAttemptExisting(q.path,q.jobId,q.baseline,q.generation);
 else if(q.operation==='Failure')value=state.recordStartFailureIfClaimedExisting(q.path,q.claim,q.error,q.ambiguous);
 else if(q.operation==='Running')value=state.markRunningWithResidentIfClaimedExisting(q.path,q.claim,q.turnId,q.residentId);
 else if(q.operation==='GoalWaiting')value=state.markGoalWaitingExisting(q.path,q.jobId,q.turnId,q.generation);
 else if(q.operation==='GoalAttach')value=state.attachGoalTurnObservedIfOwnedExisting(q.path,q.expected,q.turnId,q.observationGeneration);
 else throw new TypeError('Unknown queue attempt operation');
 const result={ok:true,value};if(boundedSerdeByteCount(result,16*1024*1024)===null)throw new Error('Queue attempt response exceeds wire budget');port.postMessage(result);
}catch{port.postMessage({ok:false});}finally{port.close();}
