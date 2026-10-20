import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {intakeNumberFromWire,intakeToWire} from './native-wire.ts';
import {DeadGenerationTargetHeldError} from '../../store/fork-completed-target.ts';
const port=parentPort;if(port===null)throw new Error('Intake state requires owned native worker');
try{
 let value:unknown;
 if(q.operation==='ReleaseAll')value=state.releaseAllPromptIntakeClaimsExisting(q.path);
 else if(q.operation==='Admit'){const valueIn=state.admitPromptIntakeExisting(q.path,{...q.request,createdAt:intakeNumberFromWire(q.request.createdAt)});value={created:valueIn.created,intake:intakeToWire(valueIn.intake)};}
 else if(q.operation==='Canonicalize'){const row=state.canonicalizePromptIntakeTargetExisting(q.path,q.id);value=row===null?null:intakeToWire(row);}
 else if(q.operation==='Get'){const row=state.getPromptIntakeExisting(q.path,q.id);value=row===null?null:intakeToWire(row);}
 else if(q.operation==='List')value=state.listPromptIntakesExisting(q.path,q.readyAt===null?null:intakeNumberFromWire(q.readyAt)).map(intakeToWire);
 else if(q.operation==='DurableOwner')value=state.promptIntakeHasDurableOwnerExisting(q.path,q.id);
 else if(q.operation==='RecordFailure'){const row=state.recordPromptIntakeFailureExisting(q.path,q.id,q.token,q.error,q.retryAfter);value=row===null?null:intakeToWire(row);}
 else if(q.operation==='RemoveQueued')value=state.removePromptIntakeIfQueuedExisting(q.path,q.id);
 else if(q.operation==='Claim'||q.operation==='Renew'){
  const claim=q.operation==='Claim'?state.tryClaimPromptIntakeExisting(q.path,q.id,q.now,q.expires):state.renewPromptIntakeClaimExisting(q.path,q.id,q.token,q.now,q.expires);
  value=claim===null?null:{claimToken:claim.claimToken,intake:intakeToWire(claim.intake)};
 }else throw new TypeError('Unknown intake operation');
 const result={ok:true,operation:q.operation,value};if(boundedSerdeByteCount(result,16*1024*1024)===null)throw new Error('Intake output exceeds native wire boundary');port.postMessage(result);
}catch(error){
 // Only this worker's exact nominal pre-commit refusal preserves manual-hold authority.
 if((q.operation==='Admit'||q.operation==='Canonicalize')&&error instanceof DeadGenerationTargetHeldError&&Object.getPrototypeOf(error)===DeadGenerationTargetHeldError.prototype){
  const refusal={ok:false,operation:q.operation,kind:'DeadTargetHeld',id:q.id,target:error.targetThreadId};
  port.postMessage(boundedSerdeByteCount(refusal,16*1024*1024)===null?{ok:false}:refusal);
 }else port.postMessage({ok:false});
}finally{port.close();}
