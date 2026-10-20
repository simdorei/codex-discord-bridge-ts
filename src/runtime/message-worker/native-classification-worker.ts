import {serveReusableWorker} from '../reusable-worker-entry.ts';
import type {ReusableNativeOperation} from '../reusable-worker-operations.ts';
import {newThreadOriginExisting,pendingNewPromptExisting} from '../../store/message-classification-read.ts';
import {abandonmentCommandTarget} from '../../store/abandonment-routing.ts';
import {SelectedReadBudget} from '../../store/selected-read-budget.ts';
import {StoreIntegrityError} from '../../store/schema-assembly.ts';
import {needsNewPromptArm,messageSqlId,frozenMessagePlan,discardClassificationJob} from './classification-plan.ts';
import {captureNativeMessageClassificationLimits,captureClassificationReadResult,classificationReadFailure} from './classification-wire.ts';
export const runNativeOperation:ReusableNativeOperation=(q,parentPort)=>{
try{
 const limits=captureNativeMessageClassificationLimits(q.limits),budget=new SelectedReadBudget(limits.maxRows,limits.maxValueBytes);
 const origin=newThreadOriginExisting(q.path,q.channel,budget);
 // Do not prefetch: actor remains u64 until a selected source branch needs SQL.
 const arm=needsNewPromptArm(q.facts,origin.target)?pendingNewPromptExisting(q.path,q.channel,messageSqlId(q.actor),q.event,budget):null;
 const plan=frozenMessagePlan(q.facts,origin.target,arm),job=discardClassificationJob(plan);
 const abandonmentTarget=job===null?null:abandonmentCommandTarget(q.path,job,q.channel,messageSqlId(q.actor),budget);
 if(job!==null&&origin.target!==abandonmentTarget)throw new StoreIntegrityError('discard-request mapping changed during classification; no proposal created');
 const value=captureClassificationReadResult({origin,arm,abandonmentTarget},q.channel,limits);
 parentPort.postMessage({ok:true,value});
}catch(error){parentPort.postMessage({ok:false,error:classificationReadFailure(error)});}
finally{parentPort.close();}
};
await serveReusableWorker(runNativeOperation);
