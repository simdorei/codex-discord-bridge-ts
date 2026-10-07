import type {BridgeState} from "../bridge-state.ts";
import type {QueueStartCoordinator} from "../queue-runner/start-coordinator.ts";
import type {Submission} from "../queue-runner/saved-submission.ts";
import {StateAccessFacade,type IStateAccessFacade} from "../../store/state-access-facade.ts";
import {InvalidActionRequestError,type ActionTarget,type PreparedTargetServices} from "./prepared-submission.ts";
type TargetQueue=Pick<QueueStartCoordinator,"requiresAppServerFork"|"ensureAppServerOnlyTarget"|"forceAppServerOnlyTarget"|"recoverTarget"|"replaySubmissionForJob">;
type TargetState=Pick<IStateAccessFacade,"completedAppServerForkTargetForSource"|"mirroredThreadId">;
type PromptServices=Pick<PreparedTargetServices,"preparePrompt"|"busyResult">;
const label=(source:string,forked:boolean)=>!forked||source.includes("app-server fork")?source:`${source} (app-server fork)`;
/** Connects actual queue/state ownership; preparation and verified busy controls remain explicit services. */
export class ActionTargetServices implements PreparedTargetServices {
  readonly #path:string;readonly #bridge:BridgeState;readonly #queue:TargetQueue;readonly #state:TargetState;readonly #prompts:PromptServices;
  constructor(path:string,bridge:BridgeState,queue:TargetQueue,prompts:PromptServices,state:TargetState=StateAccessFacade){this.#path=path;this.#bridge=bridge;this.#queue=queue;this.#prompts=prompts;this.#state=state;}
  requiresAppServerFork():boolean{return this.#queue.requiresAppServerFork();}
  preparePrompt(raw:string,target:string):Promise<string>{return this.#prompts.preparePrompt(raw,target);}
  busyResult(...args:Parameters<PromptServices["busyResult"]>):ReturnType<PromptServices["busyResult"]>{return this.#prompts.busyResult(...args);}
  async canonicalizeCompletedTarget(source:string):Promise<string>{
    if(!this.requiresAppServerFork())return source;
    let current=source;const seen=new Set<string>();
    while(!seen.has(current)){seen.add(current);const target=await this.#state.completedAppServerForkTargetForSource(this.#path,current);
      if(target===null)return current;this.#bridge.applyThreadFork(current,target);current=target;}
    throw new InvalidActionRequestError(`app-server fork handoff cycle detected for ${source}`);
  }
  async prepareActionTarget(sourceThread:string,source:string):Promise<ActionTarget>{
    const canonical=await this.canonicalizeCompletedTarget(sourceThread),target=await this.#queue.ensureAppServerOnlyTarget(canonical);
    if(target.forkedFrom!==null)this.#bridge.applyThreadFork(target.forkedFrom,target.threadId);
    return {threadId:target.threadId,sourceLabel:label(source,canonical!==sourceThread||target.forkedFrom!==null),mirrorMapping:source==="mirror"};
  }
  async currentMirrorTarget(channel:bigint,fallback:string):Promise<readonly [string,string]>{
    const target=await this.#state.mirroredThreadId(this.#path,channel);return target===null?[fallback,"selected"]:[target,"mirror"];
  }
  async recoverActiveWriterSubmission(target:ActionTarget,submission:Submission):Promise<readonly [ActionTarget,Submission]>{
    if(!this.requiresAppServerFork()||submission.warning?.kind!=="ActiveWriter")return [target,submission];
    const moved=await this.#queue.forceAppServerOnlyTarget(target.threadId);if(moved.forkedFrom!==null)this.#bridge.applyThreadFork(moved.forkedFrom,moved.threadId);
    await this.#queue.recoverTarget(moved.threadId);const refreshed=await this.#queue.replaySubmissionForJob(submission.jobId);
    if(refreshed===null)throw new InvalidActionRequestError(`queue job disappeared after app-server fork: ${submission.jobId}`);
    return [{threadId:moved.threadId,sourceLabel:label(target.sourceLabel,true),mirrorMapping:target.mirrorMapping},refreshed];
  }
}
