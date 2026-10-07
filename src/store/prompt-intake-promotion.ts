import type {DatabaseSync,SQLInputValue} from "node:sqlite";
import {getPromptIntakeIn,withPromptIntakeWriter,InvalidPromptIntakeLeaseError,type PromptIntakeClaim,type StoredPromptIntake} from "./prompt-intake.ts";
import {snapshotPromptIntakeClaim,PromptIntakeClaimLostError,PromptIntakeIdentityConflictError} from "./prompt-intake-write.ts";
import {snapshotNewQueueJob,enqueueInTransaction,ensureMirrorMatches,type NewQueueJob,type QueueEnqueueResult} from "./queue-enqueue.ts";
import {selectJob,type StoredQueueJob} from "./queue-read.ts";
import {requireUnheldIn} from "./execution-hold.ts";
import {targetIsHeldIn} from "./dead-generation-admission.ts";
import {DeadGenerationTargetHeldError} from "./fork-completed-target.ts";
import {ForkHandoffTargetMovedError} from "./fork-handoff-admission.ts";
import {recordNewEvidenceIn} from "./ingress-prompt-ownership.ts";
import {decodeTextField,textDecoderFor} from "./sqlite-values.ts";

function conflict(intake:StoredPromptIntake):never{throw new PromptIntakeIdentityConflictError(intake.jobId,intake.discordMessageId);}
function currentClaim(current:StoredPromptIntake,claim:PromptIntakeClaim,now:number):void{
  const original=claim.intake;
  if(current.targetThreadId!==original.targetThreadId)throw new ForkHandoffTargetMovedError(original.targetThreadId,current.targetThreadId);
  if(current.jobId!==original.jobId||current.channelId!==original.channelId||current.ownerUserId!==original.ownerUserId||
    current.discordMessageId!==original.discordMessageId||current.rawPrompt!==original.rawPrompt||current.autoQueueWhenBusy!==original.autoQueueWhenBusy||
    current.requireCurrentMirror!==original.requireCurrentMirror||current.claimToken!==claim.claimToken||original.claimToken!==claim.claimToken||current.claimExpiresAt<=now)
    throw new PromptIntakeClaimLostError(current.jobId);
}
function queueIdentity(intake:StoredPromptIntake,job:NewQueueJob):void{
  if(!intake.requireCurrentMirror&&job.targetThreadId!==intake.targetThreadId)throw new ForkHandoffTargetMovedError(job.targetThreadId,intake.targetThreadId);
  if(job.jobId!==intake.jobId||job.channelId!==intake.channelId||job.ownerUserId!==intake.ownerUserId||job.discordMessageId!==intake.discordMessageId)conflict(intake);
}
function storedIdentity(intake:StoredPromptIntake,expected:NewQueueJob,stored:StoredQueueJob):void{
  if(stored.jobId!==intake.jobId||stored.targetThreadId!==expected.targetThreadId||stored.channelId!==intake.channelId||
    stored.ownerUserId!==intake.ownerUserId||stored.discordMessageId!==intake.discordMessageId||stored.prompt!==expected.prompt)conflict(intake);
}
function occurrence(db:DatabaseSync,column:"job_id"|"discord_message_id",value:SQLInputValue):StoredQueueJob|null{
  const row=db.prepare(`SELECT job_id,CAST(job_id AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM codex_turn_queue WHERE ${column}=?`).get(value);
  return row===undefined?null:selectJob(db,decodeTextField(row.job_id,row.raw,"job_id",false,textDecoderFor(row.encoding))!);
}
/** Atomically transfers a current intake lease into the durable queue. Prepared prompt may differ from raw input. */
export async function promotePromptIntakeToQueue(path:string,input:PromptIntakeClaim,newJob:NewQueueJob,now:number):Promise<QueueEnqueueResult>{
  const claim=snapshotPromptIntakeClaim(input),job=snapshotNewQueueJob(newJob);
  if(typeof now!=="number")throw new TypeError("Expected numeric timestamp");
  if(!Number.isFinite(now))throw new InvalidPromptIntakeLeaseError(now,claim.intake.claimExpiresAt);
  return withPromptIntakeWriter(path,db=>{
    requireUnheldIn(db,claim.intake.jobId);
    const current=getPromptIntakeIn(db,claim.intake.jobId);if(current===null)throw new PromptIntakeClaimLostError(claim.intake.jobId);
    for(const target of [current.targetThreadId,job.targetThreadId])if(targetIsHeldIn(db,target))throw new DeadGenerationTargetHeldError(target);
    currentClaim(current,claim,now);queueIdentity(current,job);
    const byJob=occurrence(db,"job_id",job.jobId),byMessage=job.discordMessageId===null?null:occurrence(db,"discord_message_id",job.discordMessageId);
    for(const existing of [byJob,byMessage])if(existing!==null)storedIdentity(current,job,existing);
    if(byJob!==null&&byMessage!==null&&byJob.jobId!==byMessage.jobId)conflict(current);
    if(current.requireCurrentMirror)ensureMirrorMatches(db,job,{discordChannelId:current.channelId,targetThreadId:job.targetThreadId});
    const enqueued=enqueueInTransaction(db,job);storedIdentity(current,job,enqueued.job);
    recordNewEvidenceIn(db,job);
    const removed=db.prepare("DELETE FROM codex_prompt_intakes WHERE job_id=? AND claim_token=? AND claim_expires_at>?").run(current.jobId,claim.claimToken,now).changes;
    if(BigInt(removed)!==1n)throw new PromptIntakeClaimLostError(current.jobId);
    return {value:enqueued,commit:true};
  });
}
