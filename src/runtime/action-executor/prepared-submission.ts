import {randomUUID} from "node:crypto";
import type {QueueStartCoordinator} from "../queue-runner/start-coordinator.ts";
import type {Submission} from "../queue-runner/saved-submission.ts";
import type {PromptIntakeClaim} from "../../store/prompt-intake.ts";
import {snapshotPromptIntakeClaim,PromptIntakeClaimLostError} from "../../store/prompt-intake-write.ts";
import {MirrorMappingChangedError} from "../../store/queue-enqueue.ts";
import {ForkHandoffTargetMovedError} from "../../store/fork-handoff-admission.ts";
import {StateAccessFacade,type IStateAccessFacade} from "../../store/state-access-facade.ts";
import {submissionResult} from "./submission-result.ts";
export interface ActionTarget {readonly threadId:string;readonly sourceLabel:string;readonly mirrorMapping:boolean}
export type PromptActionUi={readonly kind:"Busy";readonly choiceId:string;readonly allowSteer:boolean}|{readonly kind:"ProBusy";readonly choiceId:string};
export interface PromptActionResult {text:string;waitsForFinal:boolean;ui:PromptActionUi|null}
export interface PreparedPromptSubmission {
  readonly channelId:bigint;readonly userId:bigint;readonly discordMessageId:bigint|null;
  readonly autoQueueWhenBusy:boolean;readonly intakeClaim:PromptIntakeClaim|null;readonly rawPrompt:string;
}
export interface PreparedTargetServices {
  requiresAppServerFork():boolean;
  preparePrompt(raw:string,target:string,signal?:AbortSignal):Promise<string>;
  busyResult(target:string,channel:bigint,user:bigint,prompt:string,allowSteer:boolean,mapped:boolean):Promise<PromptActionResult>;
  canonicalizeCompletedTarget(target:string):Promise<string>;
  currentMirrorTarget(channel:bigint,fallback:string):Promise<readonly [string,string]>;
  prepareActionTarget(target:string,source:string):Promise<ActionTarget>;
  recoverActiveWriterSubmission(target:ActionTarget,submission:Submission):Promise<readonly [ActionTarget,Submission]>;
}
export class InvalidActionRequestError extends Error {
  readonly kind="InvalidActionRequest";
  constructor(reason:string){super(`invalid command request: ${reason}`);this.name="InvalidActionRequestError";}
}
type QueuePort=Pick<QueueStartCoordinator,"submit"|"submitMirrorIdentified"|"submitPromptIntake"> & {reads:Pick<QueueStartCoordinator["reads"],"busyStatus">};
const detail=(error:Error)=>error.message;
/** Source-bounded orchestration; real target/fork/preprocessor/control adapters are mandatory dependencies. */
export class PreparedPromptExecutor {
  readonly #path:string;readonly #queue:QueuePort;readonly #services:PreparedTargetServices;
  readonly #state:Pick<IStateAccessFacade,"canonicalizePromptIntakeTarget">;
  constructor(path:string,queue:QueuePort,services:PreparedTargetServices,state:Pick<IStateAccessFacade,"canonicalizePromptIntakeTarget">=StateAccessFacade){
    this.#path=path;this.#queue=queue;this.#services=services;this.#state=state;
  }
  async submit(inputTarget:ActionTarget,request:PreparedPromptSubmission,signal?:AbortSignal):Promise<PromptActionResult>{
    signal?.throwIfAborted();
    let target:ActionTarget={...inputTarget};
    const raw=request.rawPrompt,channel=request.channelId,user=request.userId,event=request.discordMessageId,auto=request.autoQueueWhenBusy,
      claim=request.intakeClaim===null?null:snapshotPromptIntakeClaim(request.intakeClaim);
    for(let attempt=0;attempt<=1;attempt++){
      signal?.throwIfAborted();
      const busy=await this.#queue.reads.busyStatus(target.threadId,signal);
      signal?.throwIfAborted();
      if(busy.busy&&!auto)return this.#services.busyResult(target.threadId,channel,user,raw,busy.allowSteer,target.mirrorMapping);
      const prompt=await this.#services.preparePrompt(raw,target.threadId,signal);
      signal?.throwIfAborted();
      let submission:Submission;
      // Only submission failures are retry-classified; preprocessing and post-submit recovery errors propagate.
      try{
        if(claim!==null){
          const current=await this.#state.canonicalizePromptIntakeTarget(this.#path,claim.intake.jobId);
          signal?.throwIfAborted();
          if(current===null)throw new PromptIntakeClaimLostError(claim.intake.jobId);
          submission=await this.#queue.submitPromptIntake({intake:current,claimToken:claim.claimToken},target.threadId,prompt,signal);
        }else if(target.mirrorMapping){
          submission=await this.#queue.submitMirrorIdentified(randomUUID(),target.threadId,channel,user,event,prompt);
        }else submission=await this.#queue.submit(target.threadId,channel,user,event,prompt);
      }catch(error){
        signal?.throwIfAborted();
        if(target.mirrorMapping&&error instanceof MirrorMappingChangedError){
          if(!this.#services.requiresAppServerFork())throw new InvalidActionRequestError(`original mirror mapping changed; request preserved without retargeting: ${detail(error)}`);
          if(attempt===1)throw new InvalidActionRequestError(`mirror mapping changed again while queueing; no request was queued: ${detail(error)}`);
          await this.#services.canonicalizeCompletedTarget(target.threadId);
          signal?.throwIfAborted();
          const [current,source]=await this.#services.currentMirrorTarget(channel,target.threadId);
          signal?.throwIfAborted();
          if(source!=="mirror")throw new InvalidActionRequestError(`mirror mapping disappeared while queueing; no request was queued: ${detail(error)}`);
          target={...await this.#services.prepareActionTarget(current,source)};continue;
        }
        if(error instanceof ForkHandoffTargetMovedError){
          if(attempt===1)throw new InvalidActionRequestError(`action target changed again while queueing; no request was queued: ${detail(error)}`);
          const mapped=target.mirrorMapping;target={...await this.#services.prepareActionTarget(target.threadId,target.sourceLabel),mirrorMapping:mapped};continue;
        }
        throw error;
      }
      signal?.throwIfAborted();
      const [current,result]=await this.#services.recoverActiveWriterSubmission(target,submission);
      return submissionResult(current.threadId,current.sourceLabel,result,raw);
    }
    throw new Error("unreachable mapping retry state");
  }
}
