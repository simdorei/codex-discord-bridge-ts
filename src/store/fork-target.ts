import type {DatabaseSync} from "node:sqlite";
import {withPromptIntakeWriter} from "./prompt-intake.ts";
import {ensureForkHandoffTable} from "./fork-handoff-admission.ts";
import {forkHandoffByIdIn,type AppServerForkHandoff} from "./fork-handoff-by-id.ts";
import {ForkHandoffConflictingIntentError} from "./fork-definite-stage.ts";
import {ForkTransitionError,validateForkStartingIn,validateForkNoOtherInflightIn,forkMappingSnapshotIn} from "./fork-transition-validation.ts";
import {validateForkIdentity,forkNow} from "./fork-begin.ts";
import {targetIsHeldIn} from "./dead-generation-admission.ts";
import {DeadGenerationTargetHeldError} from "./fork-completed-target.ts";
import {managedTargetIn} from "./fork-managed-query.ts";
import {clearUnresolvedNoticesIn} from "./fork-clear-notices.ts";
import {selectJob,QUARANTINED_TURN_PREFIX,QUARANTINED_ERROR_PREFIX,type StoredQueueJob} from "./queue-read.ts";
import {decodeI64,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {trimUnicodeWhitespace as trim,takeUnicodeScalarChars} from "./queue-preflight-failure.ts";
import {migratePromptIntake} from "./schema-extensions-b1.ts";
import {UNRESOLVED_FORK_ERROR_PREFIX} from "./fork-definite-format.ts";
import {AmbiguousForkCannotBeCancelledError,ForkTargetAlreadyObservedError} from "./fork-legacy-repair.ts";
export interface CompletedAppServerForkHandoff {handoff:AppServerForkHandoff;quarantinedJob:StoredQueueJob|null;retargetedJobs:StoredQueueJob[];applied:boolean}
function required(db:DatabaseSync,id:string):AppServerForkHandoff{const h=forkHandoffByIdIn(db,id);if(h===null)throw new ForkHandoffConflictingIntentError(id);return h;}
export async function stageAppServerForkTarget(path:string,id:string,target:string):Promise<AppServerForkHandoff>{
  validateForkIdentity(id);validateForkIdentity(target);
  return withPromptIntakeWriter(path,db=>{
    ensureForkHandoffTable(db);const h=required(db,id),existing=h.targetThreadId??h.observedTargetThreadId;
    if(existing!==null){if(existing!==target)throw new ForkTransitionError({kind:"TargetConflict",targetThreadId:target});return {value:h,commit:true};}
    // Record even a colliding observed response. Finalization, not this evidence write, validates target custody.
    if(BigInt(db.prepare("UPDATE codex_thread_fork_handoffs SET observed_target_thread_id=? WHERE handoff_id=? AND observed_target_thread_id IS NULL AND target_thread_id IS NULL").run(target,id).changes)!==1n)
      throw new ForkTransitionError({kind:"TargetConflict",targetThreadId:target});
    return {value:required(db,id),commit:true};
  },false);
}
function validateCompletion(db:DatabaseSync,h:AppServerForkHandoff,target:string):void{
  const [channel,thread]=forkMappingSnapshotIn(db,h.sourceThreadId);
  if(channel!==h.discordChannelId||thread!==h.discordThreadId)throw new ForkTransitionError({kind:"MissingOrStaleMapping",sourceThreadId:h.sourceThreadId});
  const used=db.prepare(`SELECT EXISTS(SELECT 1 FROM mirror_threads WHERE codex_thread_id=?) OR EXISTS(SELECT 1 FROM codex_turn_queue WHERE target_thread_id=?)
    OR EXISTS(SELECT 1 FROM session_mirror_details WHERE codex_thread_id=?) OR EXISTS(SELECT 1 FROM codex_prompt_intakes WHERE target_thread_id=?)
    OR EXISTS(SELECT 1 FROM codex_thread_fork_handoffs WHERE handoff_id!=? AND (observed_target_thread_id=? OR target_thread_id=?)) AS used`);used.setReadBigInts(true);
  if(decodeI64(used.get(target,target,target,target,h.handoffId,target,target)?.used,"target used")!==0n||managedTargetIn(db,target))throw new ForkTransitionError({kind:"TargetConflict",targetThreadId:target});
  validateForkNoOtherInflightIn(db,h.sourceThreadId,h.ambiguousJobId);validateForkStartingIn(db,h.ambiguousJobId,h.sourceThreadId,h.expectedGeneration,null);
}
function quarantine(db:DatabaseSync,h:AppServerForkHandoff,now:number):StoredQueueJob|null{
  const id=h.ambiguousJobId;if(id===null)return null;const before=selectJob(db,id),turn=`${QUARANTINED_TURN_PREFIX}${h.handoffId}`,
    previous=takeUnicodeScalarChars(trim(before.lastError),1000),suffix=previous===""?"":`\nPrevious error: ${previous}`;
  const changed=db.prepare("UPDATE codex_turn_queue SET state='running',turn_id=?,last_error=?,updated_at=? WHERE job_id=? AND target_thread_id=? AND app_server_generation=? AND state='starting' AND turn_id IS NULL")
    .run(turn,`${QUARANTINED_ERROR_PREFIX}${h.quarantineReason}${suffix}`,now,id,h.sourceThreadId,h.expectedGeneration).changes;
  if(BigInt(changed)!==1n)throw new ForkTransitionError({kind:"StaleStartingJob",jobId:id});
  const content=`Codex request start result is uncertain, so it was not retried to prevent a duplicate response.\nQuarantine reason: ${h.quarantineReason}${suffix}`;
  db.prepare(`INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(delivery_id) DO NOTHING`).run(`quarantine:${id}`,id,h.sourceThreadId,turn,before.channelId,content,now,now);
  return selectJob(db,id);
}
export async function finalizeAppServerForkHandoff(path:string,id:string,generation:bigint,expectedRouting?:Readonly<{sourceThreadId:string;targetThreadId:string}>):Promise<CompletedAppServerForkHandoff>{
  const routing=expectedRouting===undefined?undefined:{sourceThreadId:expectedRouting.sourceThreadId,targetThreadId:expectedRouting.targetThreadId};
  if(routing!==undefined){validateForkIdentity(routing.sourceThreadId);validateForkIdentity(routing.targetThreadId);}
  validateForkIdentity(id);if(typeof generation!=="bigint"||generation<-(1n<<63n)||generation>=(1n<<63n))throw new TypeError("Expected i64 generation");
  return withPromptIntakeWriter<CompletedAppServerForkHandoff>(path,db=>{
    ensureForkHandoffTable(db);const h=required(db,id);
    if(routing!==undefined&&(h.sourceThreadId!==routing.sourceThreadId||(h.targetThreadId??h.observedTargetThreadId)!==routing.targetThreadId))throw new ForkHandoffConflictingIntentError(id);
    if(h.targetThreadId!==null)return {value:{handoff:h,quarantinedJob:h.ambiguousJobId===null?null:selectJob(db,h.ambiguousJobId),retargetedJobs:[],applied:false},commit:true};
    const target=h.observedTargetThreadId;if(target===null)throw new ForkTransitionError({kind:"ForkTargetNotObserved",handoffId:id});
    for(const t of [h.sourceThreadId,target])if(targetIsHeldIn(db,t))throw new DeadGenerationTargetHeldError(t);
    if(h.sourceThreadId===target)throw new ForkTransitionError({kind:"InvalidIdentity"});validateCompletion(db,h,target);
    // Runtime-only pair-lock safety extension: a returned fresh target cannot itself
    // be another durable fork source. Otherwise crossing replies can form A -> B -> A.
    // Legacy store entrypoints without expected routing retain the pinned SQL contract.
    if(routing!==undefined){
      const sourceUse=db.prepare("SELECT EXISTS(SELECT 1 FROM codex_thread_fork_handoffs WHERE handoff_id!=? AND source_thread_id=?) AS used");sourceUse.setReadBigInts(true);
      if(decodeI64(sourceUse.get(id,target)?.used,"fork source target conflict")!==0n)throw new ForkTransitionError({kind:"TargetConflict",targetThreadId:target});
    }
    const now=forkNow(),pending:string[]=[];
    for(const row of db.prepare(`SELECT job_id,CAST(job_id AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM codex_turn_queue
      WHERE target_thread_id=? AND state='pending' ORDER BY created_at,job_id`).iterate(h.sourceThreadId))pending.push(decodeTextField(row.job_id,row.raw,"job_id",false,textDecoderFor(row.encoding))!);
    clearUnresolvedNoticesIn(db,h.sourceThreadId);const quarantinedJob=quarantine(db,h,now);
    db.prepare("UPDATE codex_turn_queue SET target_thread_id=?,app_server_generation=?,last_error='',updated_at=? WHERE target_thread_id=? AND state='pending'").run(target,generation,now,h.sourceThreadId);
    migratePromptIntake(db);db.prepare("UPDATE codex_prompt_intakes SET target_thread_id=?,last_error=CASE WHEN instr(last_error,?)=1 THEN '' ELSE last_error END,updated_at=? WHERE target_thread_id=?").run(target,UNRESOLVED_FORK_ERROR_PREFIX,now,h.sourceThreadId);
    if(h.discordChannelId!==0n||h.discordThreadId!==0n){
      db.prepare("UPDATE session_mirror_details SET codex_thread_id=? WHERE codex_thread_id=?").run(target,h.sourceThreadId);
      if(BigInt(db.prepare("UPDATE mirror_threads SET codex_thread_id=?,updated_at=? WHERE codex_thread_id=? AND discord_channel_id=? AND discord_thread_id=?").run(target,now,h.sourceThreadId,h.discordChannelId,h.discordThreadId).changes)!==1n)
        throw new ForkTransitionError({kind:"MissingOrStaleMapping",sourceThreadId:h.sourceThreadId});
    }
    if(BigInt(db.prepare("UPDATE codex_thread_fork_handoffs SET target_thread_id=?,completed_generation=?,completed_at=? WHERE handoff_id=? AND target_thread_id IS NULL AND observed_target_thread_id=?").run(target,generation,now,id,target).changes)!==1n)
      throw new ForkHandoffConflictingIntentError(id);
    const completed=required(db,id),jobs=pending.map(job=>selectJob(db,job));return {value:{handoff:completed,quarantinedJob,retargetedJobs:jobs,applied:true},commit:true};
  },false);
}
export async function completeAppServerForkHandoff(path:string,id:string,target:string,generation:bigint):Promise<CompletedAppServerForkHandoff>{
  await stageAppServerForkTarget(path,id,target);return finalizeAppServerForkHandoff(path,id,generation);
}
export async function cancelAppServerForkHandoffAfterDefiniteFailure(path:string,id:string):Promise<boolean>{
  validateForkIdentity(id);return withPromptIntakeWriter(path,db=>{
    ensureForkHandoffTable(db);const h=forkHandoffByIdIn(db,id);if(h===null)return {value:false,commit:true};
    if(h.forkFailureAmbiguous)throw new AmbiguousForkCannotBeCancelledError(id);
    const target=h.observedTargetThreadId??h.targetThreadId;if(target!==null)throw new ForkTargetAlreadyObservedError(id,target);
    if(BigInt(db.prepare("DELETE FROM codex_thread_fork_handoffs WHERE handoff_id=? AND observed_target_thread_id IS NULL AND target_thread_id IS NULL").run(id).changes)!==1n)
      throw new ForkHandoffConflictingIntentError(h.sourceThreadId);
    return {value:true,commit:true};
  },false);
}
