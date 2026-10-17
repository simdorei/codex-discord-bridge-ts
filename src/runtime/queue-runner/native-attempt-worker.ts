import {parentPort,workerData as q} from 'node:worker_threads';
import * as statePreflight from '../../store/queue-preflight-failure.ts';
import * as stateQueueClaims from '../../store/queue-claims.ts';
import * as stateGoalWaiting from '../../store/queue-goal-waiting.ts';
import * as stateGoalAttach from '../../store/queue-attach-goal.ts';
import * as stateDelivery from '../../store/delivery.ts';
import * as stateGoalProgress from '../../store/goal-progress.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('Queue attempt requires owned worker');
try{
 let value:unknown;
 if(q.operation==='Preflight')value=statePreflight.recordPreflightFailureExisting(q.path,q.jobId,q.generation,q.error);
 else if(q.operation==='Claim')value=stateQueueClaims.tryBeginAttemptExisting(q.path,q.jobId,q.baseline,q.generation);
 else if(q.operation==='Failure')value=stateQueueClaims.recordStartFailureIfClaimedExisting(q.path,q.claim,q.error,q.ambiguous);
 else if(q.operation==='Running')value=stateQueueClaims.markRunningWithResidentIfClaimedExisting(q.path,q.claim,q.turnId,q.residentId);
 else if(q.operation==='GoalWaiting')value=stateGoalWaiting.markGoalWaitingExisting(q.path,q.jobId,q.turnId,q.generation);
 else if(q.operation==='GoalAttach')value=stateGoalAttach.attachGoalTurnObservedIfOwnedExisting(q.path,q.expected,q.turnId,q.observationGeneration);
 else if(q.operation==='StageFinal')value=stateDelivery.stageOwnedQueueCompletionExisting(q.path,q.expected,q.content,q.now,q.release);
 else if(q.operation==='StageGoal')value=stateGoalProgress.stageOwnedGoalProgressExisting(q.path,q.expected,q.content);
 else throw new TypeError('Unknown queue attempt operation');
 const result={ok:true,value};if(boundedSerdeByteCount(result,16*1024*1024)===null)throw new Error('Queue attempt response exceeds wire budget');port.postMessage(result);
}catch{port.postMessage({ok:false});}finally{port.close();}
