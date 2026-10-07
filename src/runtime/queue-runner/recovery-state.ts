import { retryDelaySeconds } from "./start-coordinator.ts";
import type { StoredQueueJob } from "../../store/queue-read.ts";
import type { BackendFailure } from "./saved-submission.ts";

export interface RecoveryReport {
  adopted:number; recoveredRunning:number; requeued:number; completed:number; unresolved:number; started:number;
  readUnavailableTargets:Set<string>; mutationUnavailableTargets:Set<string>; unavailableTargets:Set<string>; activeWriterTargets:Set<string>;
}
export function recoveryReport():RecoveryReport {
  return {adopted:0,recoveredRunning:0,requeued:0,completed:0,unresolved:0,started:0,
    readUnavailableTargets:new Set(),mutationUnavailableTargets:new Set(),unavailableTargets:new Set(),activeWriterTargets:new Set()};
}
interface TargetFailure {error:string;suppressed:bigint;nextReport:bigint;failures:bigint;nextRetry:bigint}
export interface UnavailableReport {error:string;suppressed:bigint}
const SECOND=1_000_000_000n;
const I64_MAX=9223372036854775807n,U64_MAX=18446744073709551615n;

/** One coordinator-owned recovery state. Monotonic nanoseconds, never wall-clock time. */
export class QueueRecoveryState {
  readonly #failures=new Map<string,TargetFailure>();
  readonly #cold=new Set<string>();
  #initialized=false;
  readonly #clock:()=>bigint;
  constructor(clock:()=>bigint=()=>process.hrtime.bigint()){this.#clock=clock;}
  initialize(targets:ReadonlySet<string>):void {
    for(const target of this.#failures.keys()) if(!targets.has(target)) this.#failures.delete(target);
    if(!this.#initialized){this.#initialized=true;for(const target of targets)this.#cold.add(target);}
  }
  isCold(target:string):boolean{return this.#cold.has(target);}
  markReconciled(target:string):void{this.#cold.delete(target);}
  retryDue(target:string):boolean {
    const failure=this.#failures.get(target);return failure===undefined||this.#clock()>=failure.nextRetry;
  }
  clearUnavailable(target:string):void{this.#failures.delete(target);}
  onFailure(target:string,error:string):UnavailableReport|null {
    const now=this.#clock();let failure=this.#failures.get(target);
    if(failure===undefined||failure.error!==error){
      failure={error,suppressed:0n,nextReport:now+60n*SECOND,failures:1n,nextRetry:now+30n*SECOND};
      this.#failures.set(target,failure);return {error,suppressed:0n};
    }
    if(failure.failures<I64_MAX) failure.failures++;
    failure.nextRetry=now+BigInt(retryDelaySeconds(failure.failures))*SECOND;
    if(now<failure.nextReport){if(failure.suppressed<U64_MAX)failure.suppressed++;return null;}
    const report={error,suppressed:failure.suppressed};failure.suppressed=0n;failure.nextReport=now+60n*SECOND;return report;
  }
  markUnavailable(jobs:readonly StoredQueueJob[],target:string,error:BackendFailure,report:RecoveryReport,operation:"read"|"mutation"):UnavailableReport|null {
    if(operation==="read") report.readUnavailableTargets.add(target);
    else {report.mutationUnavailableTargets.add(target);if(error.kind==="ActiveWriter")report.activeWriterTargets.add(target);}
    report.unresolved+=jobs.filter(j=>j.targetThreadId===target&&j.state!=="Quarantined").length;
    report.unavailableTargets.add(target);return this.onFailure(target,error.message);
  }
}
