import {NativeBridgeStateOwner} from '../bridge-state-native.ts';
import {types} from 'node:util';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
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
 readonly #nativeBridge:NativeBridgeStateOwner|undefined;
 readonly #mapped:(channel:bigint)=>Promise<string|null>;
  readonly #path:string;readonly #bridge:BridgeState;readonly #queue:TargetQueue;readonly #state:TargetState;readonly #prompts:PromptServices;
  constructor(path:string,bridge:BridgeState,queue:TargetQueue,prompts:PromptServices,state:TargetState=StateAccessFacade,nativeBridge?:NativeBridgeStateOwner){
    requireDiscordText(path);const mapped=gatewayOwnField(state,'mirroredThreadId');if(typeof mapped!=='function'||types.isProxy(mapped)||types.isGeneratorFunction(mapped))throw new TypeError('Expected passive target mapping read function');
    this.#mapped=channel=>{const pending=Reflect.apply(mapped,undefined,[path,channel]);if(!types.isPromise(pending))throw new TypeError('Expected target mapping read Promise');return pending as Promise<string|null>;};
    this.#nativeBridge=nativeBridge;this.#path=path;this.#bridge=bridge;this.#queue=queue;this.#prompts=prompts;this.#state=state;
  }
  requiresAppServerFork():boolean{return this.#queue.requiresAppServerFork();}
  preparePrompt(raw:string,target:string,signal?:AbortSignal):Promise<string>{return this.#prompts.preparePrompt(raw,target,signal);}
  busyResult(...args:Parameters<PromptServices["busyResult"]>):ReturnType<PromptServices["busyResult"]>{return this.#prompts.busyResult(...args);}
  async canonicalizeCompletedTarget(source:string):Promise<string>{
    if(!this.requiresAppServerFork())return source;
    let current=source;const seen=new Set<string>();
    while(!seen.has(current)){seen.add(current);const target=await this.#state.completedAppServerForkTargetForSource(this.#path,current);
      if(target===null)return current;if(this.#nativeBridge===undefined)this.#bridge.applyThreadFork(current,target);else await this.#nativeBridge.execute({kind:'Fork',source:current,target});current=target;}
    throw new InvalidActionRequestError(`app-server fork handoff cycle detected for ${source}`);
  }
  async prepareActionTarget(sourceThread:string,source:string):Promise<ActionTarget>{
    const canonical=await this.canonicalizeCompletedTarget(sourceThread),target=await this.#queue.ensureAppServerOnlyTarget(canonical);
    if(target.forkedFrom!==null){if(this.#nativeBridge===undefined)this.#bridge.applyThreadFork(target.forkedFrom,target.threadId);else await this.#nativeBridge.execute({kind:'Fork',source:target.forkedFrom,target:target.threadId});}
    return {threadId:target.threadId,sourceLabel:label(source,canonical!==sourceThread||target.forkedFrom!==null),mirrorMapping:source==="mirror"};
  }
  async currentMirrorTarget(channel:bigint,fallback:string):Promise<readonly [string,string]>{
    const target=await this.#mapped(channel);if(target!==null)requireDiscordText(target);return target===null?[fallback,"selected"]:[target,"mirror"];
  }
  async recoverActiveWriterSubmission(target:ActionTarget,submission:Submission):Promise<readonly [ActionTarget,Submission]>{
    if(!this.requiresAppServerFork()||submission.warning?.kind!=="ActiveWriter")return [target,submission];
    const moved=await this.#queue.forceAppServerOnlyTarget(target.threadId);if(moved.forkedFrom!==null){if(this.#nativeBridge===undefined)this.#bridge.applyThreadFork(moved.forkedFrom,moved.threadId);else await this.#nativeBridge.execute({kind:'Fork',source:moved.forkedFrom,target:moved.threadId});}
    await this.#queue.recoverTarget(moved.threadId);const refreshed=await this.#queue.replaySubmissionForJob(submission.jobId);
    if(refreshed===null)throw new InvalidActionRequestError(`queue job disappeared after app-server fork: ${submission.jobId}`);
    return [{threadId:moved.threadId,sourceLabel:label(target.sourceLabel,true),mirrorMapping:target.mirrorMapping},refreshed];
  }
}
