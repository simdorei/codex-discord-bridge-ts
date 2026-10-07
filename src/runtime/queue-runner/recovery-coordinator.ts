import type {QueueStartBackend} from "./start-coordinator.ts";
import {BackendFailureError,QueueIntegerRangeError} from "./errors.ts";
import {QueueRecoveryState,recoveryReport,type RecoveryReport,type UnavailableReport} from "./recovery-state.ts";
import {recoverStartingAttempt,observeRunningAttempt,type RecoveryTurn} from "./recovery-attempt.ts";
import {pendingRetryIsDue} from "./retry-policy.ts";
import {legacyOrCurrentError} from "./saved-submission.ts";
import type {IStateAccessFacade} from "../../store/state-access-facade.ts";
import type {StoredQueueJob} from "../../store/queue-read.ts";
import type {AdmissionGate} from "../../admission/drain-gate.ts";
import type {TargetLocks} from "./target-locks.ts";

function generation(value:bigint):bigint {
  if(typeof value!=="bigint"||value<0n||value>9223372036854775807n)throw new QueueIntegerRangeError();return value;
}
function definite(message:string):BackendFailureError{return new BackendFailureError({kind:"Other",message,ambiguous:false});}
async function budgetRead<T>(deadline:number,read:(signal:AbortSignal)=>Promise<T>,message:string):Promise<T>{
  const remaining=deadline-performance.now();if(remaining<=0)throw definite(message);
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(definite(message));},remaining);});
  try{return await Promise.race([Promise.resolve().then(()=>read(controller.signal)),timeout]);}
  finally{if(timer!==undefined)clearTimeout(timer);controller.abort();}
}

/** One-target authoritative recovery; bulk unmanaged-target/fork orchestration is separate. */
export class QueueRecoveryCoordinator {
  readonly #path:string;readonly #backend:QueueStartBackend;readonly #state:IStateAccessFacade;
  readonly #locks:TargetLocks;readonly #gate:AdmissionGate|null;readonly #recovery:QueueRecoveryState;
  readonly #clock:()=>number;readonly #start:(target:string,generation:bigint,turns:readonly RecoveryTurn[])=>Promise<StoredQueueJob|null>;
  readonly #log:(target:string,report:UnavailableReport)=>void;
  constructor(path:string,backend:QueueStartBackend,state:IStateAccessFacade,locks:TargetLocks,gate:AdmissionGate|null,
    clock:()=>number,start:(target:string,generation:bigint,turns:readonly RecoveryTurn[])=>Promise<StoredQueueJob|null>,
    options:{recovery?:QueueRecoveryState;log?:(target:string,report:UnavailableReport)=>void}={}){
    this.#path=path;this.#backend=backend;this.#state=state;this.#locks=locks;this.#gate=gate;this.#clock=clock;this.#start=start;
    this.#recovery=options.recovery??new QueueRecoveryState();this.#log=options.log??(()=>{});
  }
  async recoverTarget(target:string):Promise<RecoveryReport>{
    if(typeof target!=="string"||/[\uD800-\uDFFF]/u.test(target))throw new TypeError("Expected a well-formed target");
    if(this.#backend.requiresAppServerFork?.()??false)await this.#state.repairLegacyDefiniteForkFailures(this.#path);
    else await this.#state.retireCopyOnlyHandoffs(this.#path);
    this.#recovery.initialize(new Set([target]));const g=generation(this.#backend.generation()),report=recoveryReport();
    // Rust releases the target between observation and mutation passes; writers may interleave.
    await this.#locks.run(target,()=>this.#observe(target,g,report));
    await this.#locks.run(target,()=>this.#mutate(target,g,report));
    return report;
  }
  async #readTurns(target:string):Promise<readonly RecoveryTurn[]>{
    const turns=await this.#backend.readTurns(target);
    return turns.map(turn=>{
      if(typeof turn.turnId!=="string"||/[\uD800-\uDFFF]/u.test(turn.turnId)||
        (turn.status!=="Completed"&&turn.status!=="Interrupted"&&turn.status!=="Failed"&&turn.status!=="InProgress"))
        throw definite("authoritative turn history lacks a typed status");
      return {turnId:turn.turnId,status:turn.status};
    });
  }
  #unavailable(jobs:readonly StoredQueueJob[],target:string,error:BackendFailureError,report:RecoveryReport,operation:"read"|"mutation"):void{
    const notice=this.#recovery.markUnavailable(jobs,target,error.failure,report,operation);if(notice)this.#log(target,notice);
  }
  async #observe(target:string,g:bigint,report:RecoveryReport):Promise<void>{
    const state=this.#state,path=this.#path;
    if(await state.asyncTargetDispatchHeld(path,target)){
      try{report.unresolved+=await this.#history(target);}catch(error){report.unresolved++;report.readUnavailableTargets.add(target);report.unavailableTargets.add(target);
        this.#log(target,{error:error instanceof Error?error.message:"Historical review failed",suppressed:0n});}
      return;
    }
    if(await state.deadTargetHeld(path,target))return;
    const jobs=await state.listFiltered(path,target,null);if(!jobs.some(j=>j.state==="Starting"||j.state==="Running"))return;
    let turns:readonly RecoveryTurn[];
    try{turns=await this.#readTurns(target);}catch(error){if(!(error instanceof BackendFailureError))throw error;this.#unavailable(jobs,target,error,report,"read");return;}
    this.#recovery.clearUnavailable(target);const cold=this.#recovery.isCold(target);
    for(const job of jobs){
      if(job.state==="Starting"&&!await recoverStartingAttempt(path,job,g,cold,turns,report,state,this.#clock))return;
      if(job.state==="Running")observeRunningAttempt(job,turns,report);
    }
    report.adopted+=Number((await state.adoptTargetGeneration(path,target,g)).adoptedCount);this.#recovery.markReconciled(target);
  }
  async #mutate(target:string,g:bigint,report:RecoveryReport):Promise<void>{
    const state=this.#state,path=this.#path;
    if(await state.asyncTargetDispatchHeld(path,target)||await state.deadTargetHeld(path,target))return;
    const jobs=await state.eligibleJobs(path,await state.listFiltered(path,target,null));
    if(jobs.some(j=>j.state==="Starting"||j.state==="Running"))return;
    const pending=jobs.find(j=>j.state==="Pending"&&!legacyOrCurrentError(j.lastError));if(!pending)return;
    const handoff=await state.unresolvedAppServerForkHandoffForSource(path,target);
    if(handoff!==null){this.#unavailable(jobs,target,definite(`app-server fork handoff ${handoff.handoffId} is unresolved; duplicate fork retry is fenced`),report,"mutation");return;}
    if(!pendingRetryIsDue(pending.attemptCount,pending.lastError,pending.updatedAt,this.#clock())||!this.#recovery.retryDue(target))return;
    try{await this.#backend.resumeThread(target);}catch(error){
      if(!(error instanceof BackendFailureError))throw error;
      await state.recordPreflightFailure(path,pending.jobId,pending.appServerGeneration,error.failure.message);
      this.#unavailable(jobs,target,error,report,"mutation");return;
    }
    let turns:readonly RecoveryTurn[];
    try{turns=await this.#readTurns(target);}catch(error){
      if(!(error instanceof BackendFailureError))throw error;
      await state.recordPreflightFailure(path,pending.jobId,pending.appServerGeneration,error.failure.message);
      this.#unavailable(jobs,target,error,report,"read");return;
    }
    report.adopted+=Number((await state.adoptTargetGeneration(path,target,g)).adoptedCount);this.#recovery.markReconciled(target);
    try{if(await this.#start(target,g,turns)!==null)report.started++;this.#recovery.clearUnavailable(target);}
    catch(error){if(!(error instanceof BackendFailureError))throw error;this.#unavailable(await state.listFiltered(path,target,null),target,error,report,"mutation");}
  }
  async #history(target:string):Promise<number>{
    const permit=this.#gate?.tryEnterControl();
    try{
      const deadline=performance.now()+10000,observer=this.#backend.residentInstanceId();if(observer===null)return 0;
      const g=this.#backend.generation(),state=this.#state,path=this.#path;
      const snapshot=await state.captureAsyncHistorySnapshot(path,target);if(snapshot===null)return 0;
      const history=await budgetRead(deadline,signal=>this.#backend.readAsyncHistory?.(target,snapshot.turnIds(),signal)??Promise.resolve(null),"historical review read budget expired");
      if(history===null)return snapshot.obligationCount();
      if(this.#backend.residentInstanceId()!==observer||this.#backend.generation()!==g)throw definite("historical review connection changed; candidate not committed");
      await state.retainAsyncHistoryCandidate(path,snapshot,history,observer,generation(g));
      if(this.#gate===null)return snapshot.obligationCount();
      const terminal=await state.captureTerminalHistorySnapshot(path,target);if(terminal===null)return snapshot.obligationCount();
      const observed=await budgetRead(deadline,signal=>this.#backend.readAsyncTerminal?.(target,terminal.turnIds(),signal)??Promise.resolve(null),"historical terminal read budget expired");
      if(observed===null)return snapshot.obligationCount();
      if(this.#backend.residentInstanceId()!==observer||this.#backend.generation()!==g)throw definite("historical terminal connection changed; no settlement");
      const settled=await state.settleTerminalHistory(path,terminal,observed,observer,generation(g));
      return Math.max(0,snapshot.obligationCount()-settled);
    }finally{permit?.release();}
  }
}
