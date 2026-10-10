import {randomUUID} from "node:crypto";
import {types} from "node:util";
import type {QueueStartCoordinator} from "../queue-runner/start-coordinator.ts";
import {retryDelaySeconds} from "../queue-runner/retry-policy.ts";
import {QueueIntegerRangeError} from "../queue-runner/errors.ts";
import {PreparedPromptExecutor,InvalidActionRequestError,type PreparedTargetServices,type PromptActionResult} from "../action-executor/prepared-submission.ts";
import {submissionResult} from "../action-executor/submission-result.ts";
import {PromptClaimLeaseRunner,type RenewalTicks,type ClaimResult} from "./lease-runner.ts";
import {StateAccessFacade,type IStateAccessFacade} from "../../store/state-access-facade.ts";
import {snapshotNewPromptIntake,snapshotStoredPromptIntake} from "../../store/prompt-intake-write.ts";
import type {StoredPromptIntake,PromptIntakeClaim} from "../../store/prompt-intake.ts";
import {SystemTimeError} from "../../store/queue-mark-running.ts";
export interface PromptAdmission {targetThreadId:string;source:string;channelId:bigint;userId:bigint;discordMessageId:bigint|null;autoQueueWhenBusy:boolean;rawPrompt:string}
export interface IntakeRecoveryEvent {kind:"RecoveredWithWarning"|"Deferred"|"RecordingError"|"ClaimLost";jobId:string;error?:unknown}
const source=(intake:StoredPromptIntake)=>intake.requireCurrentMirror?"mirror":"selected";
function own(value:unknown,key:string):unknown{if(value===null||typeof value!=="object"||types.isProxy(value)||Array.isArray(value))return undefined;const d=Object.getOwnPropertyDescriptor(value,key);return d&&Object.hasOwn(d,"value")?d.value:undefined;}
const display=(error:unknown):string=>typeof error==="string"?error:typeof own(error,"message")==="string"?own(error,"message") as string:"unclassified processing failure";
const missing=(id:string)=>new InvalidActionRequestError(`prompt intake disappeared before processing: ${id}`);
function unsigned(value:bigint):bigint{if(value<0n||value>9223372036854775807n)throw new QueueIntegerRangeError();return value;}
/** Durable intake state machine. Startup lease release and periodic scheduling are deliberately separate. */
export class PromptIntakeProcessor{
  readonly #path:string;readonly #queue:QueueStartCoordinator;readonly #services:PreparedTargetServices;readonly #prepared:PreparedPromptExecutor;
  readonly #state:IStateAccessFacade;readonly #clock:()=>number;readonly #runner:PromptClaimLeaseRunner;readonly #event:(event:IntakeRecoveryEvent)=>void;
  constructor(path:string,queue:QueueStartCoordinator,services:PreparedTargetServices,options:{state?:IStateAccessFacade;clock?:()=>number;ticks?:()=>RenewalTicks;onRecoveryEvent?:(event:IntakeRecoveryEvent)=>void}={}){
    this.#path=path;this.#queue=queue;this.#services=services;this.#state=options.state??StateAccessFacade;this.#clock=options.clock??(()=>Date.now()/1000);
    this.#runner=new PromptClaimLeaseRunner(path,this.#state,()=>this.#now(),options.ticks);this.#prepared=new PreparedPromptExecutor(path,queue,services,this.#state);this.#event=options.onRecoveryEvent??(()=>{});
  }
  #now():number{const now=this.#clock();if(!Number.isFinite(now))throw new TypeError("Expected finite clock");if(now<0)throw new SystemTimeError(-now*1000);return now;}
  async admitPrompt(request:PromptAdmission,signal?:AbortSignal):Promise<PromptActionResult>{
    signal?.throwIfAborted();
    const route=own(request,"source");if(typeof route!=="string"||/[\uD800-\uDFFF]/u.test(route))throw new TypeError("Expected source label");
    const input=snapshotNewPromptIntake({jobId:randomUUID(),targetThreadId:own(request,"targetThreadId"),channelId:own(request,"channelId"),ownerUserId:own(request,"userId"),
      discordMessageId:own(request,"discordMessageId"),rawPrompt:own(request,"rawPrompt"),autoQueueWhenBusy:own(request,"autoQueueWhenBusy"),requireCurrentMirror:route==="mirror",createdAt:0} as Parameters<typeof snapshotNewPromptIntake>[0]);
    unsigned(input.channelId);if(input.ownerUserId===null)throw new QueueIntegerRangeError();unsigned(input.ownerUserId);if(input.discordMessageId!==null)unsigned(input.discordMessageId);
    input.createdAt=this.#now();
    const admitted=await this.#state.admitPromptIntake(this.#path,input);return this.processAdmittedPrompt(admitted.intake,signal);
  }
  async processAdmittedPrompt(input:StoredPromptIntake,signal?:AbortSignal):Promise<PromptActionResult>{
    signal?.throwIfAborted();
    const intake=snapshotStoredPromptIntake(input),claim=await this.#claim(intake);signal?.throwIfAborted();if(claim===null)return this.#replayOrPending(intake);
    const outcome=await this.#runner.run(claim,(owned,ownedSignal)=>this.#process(owned,ownedSignal),signal);
    return outcome.kind==="Lost"?this.#replayOrPending(intake):this.#finish(claim,outcome.result);
  }
  #claim(intake:StoredPromptIntake):Promise<PromptIntakeClaim|null>{const now=this.#now();return this.#state.tryClaimPromptIntake(this.#path,intake.jobId,now,now+600);}
  async #process(claim:PromptIntakeClaim,signal:AbortSignal):Promise<PromptActionResult>{
    signal.throwIfAborted();const intake=await this.#state.canonicalizePromptIntakeTarget(this.#path,claim.intake.jobId);if(intake===null)throw missing(claim.intake.jobId);signal.throwIfAborted();
    let thread=intake.targetThreadId,route="selected";
    if(intake.requireCurrentMirror){[thread,route]=await this.#services.currentMirrorTarget(intake.channelId,intake.targetThreadId);signal.throwIfAborted();
      if(route!=="mirror"||(!this.#services.requiresAppServerFork()&&thread!==intake.targetThreadId))throw new InvalidActionRequestError(`prompt intake ${intake.jobId} lost or changed its original mirror mapping; it remains saved for recovery`);}
    const target=await this.#services.prepareActionTarget(thread,route);signal.throwIfAborted();
    if(intake.ownerUserId===null)throw new InvalidActionRequestError(`prompt intake ${intake.jobId} has no owner user id`);
    return this.#prepared.submit(target,{channelId:unsigned(intake.channelId),userId:unsigned(intake.ownerUserId),discordMessageId:intake.discordMessageId===null?null:unsigned(intake.discordMessageId),
      autoQueueWhenBusy:true,intakeClaim:claim,rawPrompt:intake.rawPrompt},signal);
  }
  async #requirePromotion(id:string):Promise<void>{if(await this.#state.getPromptIntake(this.#path,id)!==null)throw new InvalidActionRequestError(`prompt intake ${id} was not atomically promoted to the durable queue`);}
  async #backoff(claim:PromptIntakeClaim,error:unknown):Promise<void>{
    const next=claim.intake.attemptCount<9223372036854775807n?claim.intake.attemptCount+1n:9223372036854775807n,retry=this.#now()+retryDelaySeconds(next);
    if(await this.#state.recordPromptIntakeFailureIfClaimed(this.#path,claim,display(error),retry)===null)throw new InvalidActionRequestError(`prompt intake ${claim.intake.jobId} processing failed and its durable claim changed: ${display(error)}`);
  }
  async #finish(claim:PromptIntakeClaim,result:ClaimResult<PromptActionResult>):Promise<PromptActionResult>{
    if(result.ok){await this.#requirePromotion(claim.intake.jobId);return result.value;}const error=result.error,id=claim.intake.jobId;
    if(await this.#state.executionHoldReason(this.#path,id)!==null||await this.#state.deadTargetHeld(this.#path,claim.intake.targetThreadId)||own(error,"kind")==="DeadGenerationTargetHeld")
      throw new InvalidActionRequestError(`request ${id} is preserved under a manual hold and will not be retried automatically: ${display(error)}`);
    if(await this.#state.removePromptIntakeIfQueued(this.#path,id)||await this.#state.getPromptIntake(this.#path,id)===null)throw error;
    await this.#backoff(claim,error);throw new InvalidActionRequestError(`request ${id} is saved for automatic recovery and was not started: ${display(error)}`);
  }
  async #replayOrPending(intake:StoredPromptIntake):Promise<PromptActionResult>{
    const saved=await this.#queue.replaySubmissionWithTargetForJob(intake.jobId);if(saved!==null)return submissionResult(saved[0],source(intake),saved[1],intake.rawPrompt);
    if(await this.#state.executionHoldReason(this.#path,intake.jobId)!==null)return {text:`request ${intake.jobId} is preserved under a manual hold and will not be retried automatically\nthread_id: ${intake.targetThreadId}`,waitsForFinal:false,ui:null};
    const current=await this.#state.canonicalizePromptIntakeTarget(this.#path,intake.jobId);
    if(current===null){const raced=await this.#queue.replaySubmissionWithTargetForJob(intake.jobId);if(raced!==null)return submissionResult(raced[0],source(intake),raced[1],intake.rawPrompt);throw missing(intake.jobId);}
    return {text:`Accepted Codex request; durable preparation or retry is already pending\nthread_id: ${current.targetThreadId}\njob_id: ${current.jobId}`,waitsForFinal:true,ui:null};
  }
  async recoverPromptIntakes():Promise<number>{
    for(const intake of await this.#state.listPromptIntakes(this.#path))await this.#state.removePromptIntakeIfQueued(this.#path,intake.jobId);
    const ready=await this.#state.listPromptIntakes(this.#path,this.#now());let recovered=0,recordingError:unknown,hasRecordingError=false;
    for(const intake of ready){
      const claim=await this.#claim(intake);if(claim===null)continue;
      const outcome=await this.#runner.run(claim,(owned,signal)=>this.#process(owned,signal)),id=claim.intake.jobId;
      if(outcome.kind==="Lost"){
        if(await this.#state.removePromptIntakeIfQueued(this.#path,id))recovered++;else this.#event({kind:"ClaimLost",jobId:id});continue;
      }
      if(outcome.result.ok){await this.#requirePromotion(id);recovered++;continue;}
      const error=outcome.result.error;
      if(await this.#state.removePromptIntakeIfQueued(this.#path,id)){recovered++;this.#event({kind:"RecoveredWithWarning",jobId:id,error});}
      else if(await this.#state.getPromptIntake(this.#path,id)===null)recovered++;
      else{try{await this.#backoff(claim,error);}catch(recording){this.#event({kind:"RecordingError",jobId:id,error:recording});if(!hasRecordingError){recordingError=recording;hasRecordingError=true;}continue;}
        this.#event({kind:"Deferred",jobId:id,error});}
    }
    if(hasRecordingError)throw recordingError;return recovered;
  }
}
