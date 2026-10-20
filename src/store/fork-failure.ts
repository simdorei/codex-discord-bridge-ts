import {withPromptIntakeWriter} from "./prompt-intake.ts";
import {ensureForkHandoffTable} from "./fork-handoff-admission.ts";
import {forkHandoffByIdIn,snapshotForkHandoff,FORK_HANDOFF_FIELDS,type AppServerForkHandoff} from "./fork-handoff-by-id.ts";
import {ForkHandoffConflictingIntentError,stageDefiniteNoticesIn} from "./fork-definite-stage.ts";
import {stageUnresolvedNoticesIn,FailurePhase} from "./fork-unresolved-stage.ts";
import {boundedForkError} from "./fork-definite-format.ts";
import {validateForkIdentity} from "./fork-begin.ts";
import {ForkTransitionError} from "./fork-transition-validation.ts";
import {AmbiguousForkCannotBeCancelledError,ForkTargetAlreadyObservedError,type RecordedDefiniteForkFailure} from "./fork-legacy-repair.ts";
export async function recordAppServerForkFailure(path:string,id:string,error:string,ambiguous:boolean):Promise<AppServerForkHandoff>{
  validateForkIdentity(id);const bounded=boundedForkError(error);if(typeof ambiguous!=="boolean")throw new TypeError("Expected ambiguity flag");
  return withPromptIntakeWriter(path,db=>{
    ensureForkHandoffTable(db);const h=forkHandoffByIdIn(db,id);if(h===null)throw new ForkHandoffConflictingIntentError(id);
    const target=h.observedTargetThreadId??h.targetThreadId;if(target!==null)throw new ForkTargetAlreadyObservedError(id,target);
    if(BigInt(db.prepare(`UPDATE codex_thread_fork_handoffs SET last_fork_error=?,fork_failure_ambiguous=CASE WHEN fork_failure_ambiguous!=0 OR ?!=0 THEN 1 ELSE 0 END
      WHERE handoff_id=? AND target_thread_id IS NULL AND observed_target_thread_id IS NULL`).run(bounded,Number(ambiguous),id).changes)!==1n)throw new ForkHandoffConflictingIntentError(h.sourceThreadId);
    if(ambiguous)stageUnresolvedNoticesIn(db,id,h.sourceThreadId,h.lastForkError,bounded,FailurePhase.ForkOutcome);
    const recorded=forkHandoffByIdIn(db,id);if(recorded===null)throw new ForkHandoffConflictingIntentError(h.sourceThreadId);return {value:recorded,commit:true};
  },false);
}
export async function recordAppServerForkFinalizeFailure(path:string,id:string,error:string):Promise<AppServerForkHandoff>{
  validateForkIdentity(id);const bounded=boundedForkError(error);
  return withPromptIntakeWriter(path,db=>{
    ensureForkHandoffTable(db);const h=forkHandoffByIdIn(db,id);if(h===null)throw new ForkHandoffConflictingIntentError(id);
    const observed=h.observedTargetThreadId;if(observed===null)throw new ForkTransitionError({kind:"ForkTargetNotObserved",handoffId:id});
    if(h.targetThreadId!==null)throw new ForkTargetAlreadyObservedError(id,observed);
    if(BigInt(db.prepare("UPDATE codex_thread_fork_handoffs SET last_fork_error=? WHERE handoff_id=? AND observed_target_thread_id=? AND target_thread_id IS NULL").run(bounded,id,observed).changes)!==1n)
      throw new ForkHandoffConflictingIntentError(h.sourceThreadId);
    stageUnresolvedNoticesIn(db,id,h.sourceThreadId,h.lastForkError,bounded,FailurePhase.Finalize);
    const recorded=forkHandoffByIdIn(db,id);if(recorded===null)throw new ForkHandoffConflictingIntentError(h.sourceThreadId);return {value:recorded,commit:true};
  },false);
}
/** Full expected handoff identity is compared before definite notices and cancellation share a commit. */
export async function recordAndCancelDefiniteForkFailure(path:string,input:AppServerForkHandoff,error:string):Promise<RecordedDefiniteForkFailure>{
  const expected=snapshotForkHandoff(input);validateForkIdentity(expected.handoffId);validateForkIdentity(expected.sourceThreadId);const bounded=boundedForkError(error);
  return withPromptIntakeWriter(path,db=>{
    ensureForkHandoffTable(db);const h=forkHandoffByIdIn(db,expected.handoffId);if(h===null)throw new ForkHandoffConflictingIntentError(expected.sourceThreadId);
    if(h.forkFailureAmbiguous)throw new AmbiguousForkCannotBeCancelledError(h.handoffId);
    const target=h.observedTargetThreadId??h.targetThreadId;if(target!==null)throw new ForkTargetAlreadyObservedError(h.handoffId,target);
    if(h.completedGeneration!==null||FORK_HANDOFF_FIELDS.some(key=>h[key]!==expected[key]))throw new ForkHandoffConflictingIntentError(h.sourceThreadId);
    if(BigInt(db.prepare(`UPDATE codex_thread_fork_handoffs SET last_fork_error=?,fork_failure_ambiguous=CASE WHEN fork_failure_ambiguous!=0 THEN 1 ELSE 0 END
      WHERE handoff_id=? AND target_thread_id IS NULL AND observed_target_thread_id IS NULL`).run(bounded,h.handoffId).changes)!==1n)throw new ForkHandoffConflictingIntentError(h.sourceThreadId);
    const affectedJobs=stageDefiniteNoticesIn(db,h.handoffId,h.sourceThreadId,bounded);
    if(BigInt(db.prepare("DELETE FROM codex_thread_fork_handoffs WHERE handoff_id=? AND observed_target_thread_id IS NULL AND target_thread_id IS NULL").run(h.handoffId).changes)!==1n)
      throw new ForkHandoffConflictingIntentError(h.sourceThreadId);
    return {value:{handoffId:h.handoffId,sourceThreadId:h.sourceThreadId,lastForkError:bounded,affectedJobs},commit:true};
  },false);
}
