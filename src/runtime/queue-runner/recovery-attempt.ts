import { StateAccessFacade, type IStateAccessFacade } from "../../store/state-access-facade.ts";
import { STARTING_CANDIDATE_HOLD_PREFIX, type StoredQueueJob } from "../../store/queue-read.ts";
import { SystemTimeError } from "../../store/queue-mark-running.ts";

export interface RecoveryTurn { readonly turnId: string; readonly status: "Completed" | "Interrupted" | "Failed" | "InProgress" }
export interface AttemptRecoveryReport { recoveredRunning: number; unresolved: number }
type AttemptState = Pick<IStateAccessFacade,"holdStartingForAmbiguousCandidatesIfClaimed"|"markRunningIfClaimed"|"recordStartFailureIfClaimed">;

/** Caller holds the shared target lock and supplies authoritative thread/read history. No replay/start permission. */
export async function recoverStartingAttempt(path: string,job: StoredQueueJob,generation: bigint,cold: boolean,
  turns: readonly RecoveryTurn[],report: AttemptRecoveryReport,state: AttemptState=StateAccessFacade,
  clock:()=>number=()=>Date.now()/1000): Promise<boolean> {
  const baseline=new Set(job.baselineTurnIds);
  const candidates=[...new Set(turns.filter(t=>!baseline.has(t.turnId)).map(t=>t.turnId))]
    .sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  if(job.lastError.startsWith(STARTING_CANDIDATE_HOLD_PREFIX)) {
    await state.holdStartingForAmbiguousCandidatesIfClaimed(path,job,candidates);
    report.unresolved++;return false;
  }
  if(job.lastError===""&&Number.isFinite(job.updatedAt)) {
    const now=clock();
    if(!Number.isFinite(now)) throw new TypeError("system clock must be finite");
    if(now<0) throw new SystemTimeError(-now*1000);
    if(now<job.updatedAt+120) {report.unresolved++;return false;}
  }
  if(candidates.length===1) {
    const recovered=await state.markRunningIfClaimed(path,job,candidates[0]!)!==null;
    if(recovered) report.recoveredRunning++;
    return recovered;
  }
  if(candidates.length===0&&(cold||job.appServerGeneration!==generation)) {
    if(job.lastError==="") await state.recordStartFailureIfClaimed(path,job,
      "turn/start acceptance remains unknown; empty history does not authorize retry",true);
    report.unresolved++;return false;
  }
  if(candidates.length>1) await state.holdStartingForAmbiguousCandidatesIfClaimed(path,job,candidates);
  report.unresolved++;return false;
}
export function observeRunningAttempt(job: StoredQueueJob,turns: readonly RecoveryTurn[],report: AttemptRecoveryReport): void {
  if(job.turnId===null) {report.unresolved++;return;}
  const status=turns.find(t=>t.turnId===job.turnId)?.status;
  if(status!=="InProgress") report.unresolved++;
  // Terminal history alone never removes the job; final delivery must commit first.
}
