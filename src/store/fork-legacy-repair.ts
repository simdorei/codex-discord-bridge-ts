import {openInitialized} from "./owned-driver.ts";
import {ensureForkHandoffTable} from "./fork-handoff-admission.ts";
import {forkHandoffByIdIn} from "./fork-handoff-by-id.ts";
import {boundedForkError} from "./fork-definite-format.ts";
import {stageDefiniteNoticesIn,ForkHandoffConflictingIntentError} from "./fork-definite-stage.ts";
import {decodeTextField,textDecoderFor} from "./sqlite-values.ts";
export interface RecordedDefiniteForkFailure {handoffId:string;sourceThreadId:string;lastForkError:string;affectedJobs:bigint}
export class AmbiguousForkCannotBeCancelledError extends Error {
  readonly kind="AmbiguousForkCannotBeCancelled";readonly handoffId:string;
  constructor(id:string){super(`ambiguous fork handoff cannot be cancelled: ${id}`);this.name="AmbiguousForkCannotBeCancelledError";this.handoffId=id;}
}
export class ForkTargetAlreadyObservedError extends Error {
  readonly kind="ForkTargetAlreadyObserved";readonly handoffId:string;readonly targetThreadId:string;
  constructor(id:string,target:string){super(`fork target ${target} was already observed for handoff ${id}`);this.name="ForkTargetAlreadyObservedError";this.handoffId=id;this.targetThreadId=target;}
}
/** Only legacy definite failures with no observed target; no new fork or queue replay. */
export async function repairLegacyDefiniteForkFailures(path:string):Promise<RecordedDefiniteForkFailure[]>{
  const db=await openInitialized(path);let committed=false;
  try{
    db.exec("BEGIN IMMEDIATE");ensureForkHandoffTable(db);
    const rows=db.prepare(`SELECT handoff_id,CAST(handoff_id AS BLOB) AS raw,
      (SELECT encoding FROM pragma_encoding) AS encoding FROM codex_thread_fork_handoffs
      WHERE observed_target_thread_id IS NULL AND target_thread_id IS NULL
        AND fork_failure_ambiguous=0 AND last_fork_error!='' ORDER BY created_at,handoff_id`).all();
    const ids=rows.map(row=>decodeTextField(row.handoff_id,row.raw,"handoff_id",false,textDecoderFor(row.encoding))!);
    const result:RecordedDefiniteForkFailure[]=[];
    for(const id of ids){
      const handoff=forkHandoffByIdIn(db,id);if(handoff===null)throw new ForkHandoffConflictingIntentError(id);
      if(handoff.forkFailureAmbiguous)throw new AmbiguousForkCannotBeCancelledError(handoff.handoffId);
      const target=handoff.observedTargetThreadId??handoff.targetThreadId;
      if(target!==null)throw new ForkTargetAlreadyObservedError(handoff.handoffId,target);
      if(handoff.completedGeneration!==null)throw new ForkHandoffConflictingIntentError(handoff.sourceThreadId);
      const error=boundedForkError(handoff.lastForkError);
      if(BigInt(db.prepare(`UPDATE codex_thread_fork_handoffs SET last_fork_error=?,
        fork_failure_ambiguous=CASE WHEN fork_failure_ambiguous!=0 THEN 1 ELSE 0 END
        WHERE handoff_id=? AND target_thread_id IS NULL AND observed_target_thread_id IS NULL`).run(error,id).changes)!==1n)
        throw new ForkHandoffConflictingIntentError(handoff.sourceThreadId);
      const affectedJobs=stageDefiniteNoticesIn(db,id,handoff.sourceThreadId,error);
      if(BigInt(db.prepare("DELETE FROM codex_thread_fork_handoffs WHERE handoff_id=? AND observed_target_thread_id IS NULL AND target_thread_id IS NULL").run(id).changes)!==1n)
        throw new ForkHandoffConflictingIntentError(handoff.sourceThreadId);
      result.push({handoffId:id,sourceThreadId:handoff.sourceThreadId,lastForkError:error,affectedJobs});
    }
    db.exec("COMMIT");committed=true;return result;
  }finally{if(!committed&&db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close rolls back */}}db.close();}
}
