import {randomUUID} from "node:crypto";
import {StateAccessFacade,type IStateAccessFacade} from "../../store/state-access-facade.ts";
import type {AppServerForkHandoff} from "../../store/fork-handoff-by-id.ts";
import {DeadGenerationTargetHeldError} from "../../store/fork-completed-target.ts";
import {BackendFailureError,QueueIntegerRangeError} from "./errors.ts";
import {ForkRuntimeError} from "./fork-errors.ts";
import {TargetLocks} from "./target-locks.ts";
export interface AppServerTarget {threadId:string;forkedFrom:string|null;quarantinedJobId:string|null}
export interface ForkBackend {generation():bigint;requiresAppServerFork?():boolean;forkThread?(source:string):Promise<string>}
type ForkState=Pick<IStateAccessFacade,"deadTargetHeld"|"listFiltered"|"completedAppServerForkTargetForSource"|"unresolvedAppServerForkHandoffForSource"|"isAppServerManagedTarget"|"beginAppServerForkHandoff"|"stageAppServerForkTarget"|"finalizeAppServerForkHandoff"|"recordAppServerForkFailure"|"recordAppServerForkFinalizeFailure"|"recordAndCancelDefiniteForkFailure">;
type Decision={kind:"done";target:AppServerTarget}|{kind:"finalize";source:string;handoff:string;target:string};
const visible=(error:string)=>error===""?"app-server fork handoff was interrupted before a response was durably recorded":error;
const unchanged=(threadId:string):AppServerTarget=>({threadId,forkedFrom:null,quarantinedJobId:null});
/** Durable observation divides source RPC ownership from ordered source/target finalization locks. */
export class QueueForkCoordinator{
  readonly #path:string;readonly #backend:ForkBackend;readonly #state:ForkState;readonly #locks:TargetLocks;
  constructor(path:string,backend:ForkBackend,state:ForkState=StateAccessFacade,locks=new TargetLocks()){this.#path=path;this.#backend=backend;this.#state=state;this.#locks=locks;}
  ensureTarget(source:string):Promise<AppServerTarget>{return this.#handoff(source,false,"app-server-only ownership fork");}
  forceTarget(source:string):Promise<AppServerTarget>{return this.#handoff(source,true,"app-server active-writer ownership fork");}
  #generation():bigint{const value=this.#backend.generation();if(typeof value!=="bigint"||value<0n||value>9223372036854775807n)throw new QueueIntegerRangeError();return value;}
  async #unheld(target:string):Promise<void>{if(await this.#state.deadTargetHeld(this.#path,target))throw new DeadGenerationTargetHeldError(target);}
  async #chain(source:string):Promise<string|null>{
    const seen=new Set([source]);let current=source;
    while(true){const next=await this.#state.completedAppServerForkTargetForSource(this.#path,current);if(next===null)return current===source?null:current;
      await this.#unheld(next);if(seen.has(next))throw new ForkRuntimeError({kind:"ForkTargetCycle",sourceThreadId:source});seen.add(next);current=next;}
  }
  async #unresolved(source:string,h:AppServerForkHandoff):Promise<never>{
    const error=visible(h.lastForkError);await this.#state.recordAppServerForkFailure(this.#path,h.handoffId,error,h.forkFailureAmbiguous||h.lastForkError==="");
    throw new ForkRuntimeError({kind:"UnresolvedForkHandoff",sourceThreadId:source,handoffId:h.handoffId,lastForkError:error});
  }
  async #handoff(source:string,force:boolean,reason:string):Promise<AppServerTarget>{
    await this.#unheld(source);if(!this.#backend.requiresAppServerFork?.())return unchanged(source);
    const decision=await this.#locks.run<Decision>(source,async()=>{
      const completed=await this.#chain(source);if(completed!==null)return {kind:"done",target:{threadId:completed,forkedFrom:source,quarantinedJobId:null}};
      const existing=await this.#state.unresolvedAppServerForkHandoffForSource(this.#path,source);
      if(existing!==null){if(existing.observedTargetThreadId!==null)return {kind:"finalize",source,handoff:existing.handoffId,target:existing.observedTargetThreadId};return this.#unresolved(source,existing);}
      if(!force&&await this.#state.isAppServerManagedTarget(this.#path,source))return {kind:"done",target:unchanged(source)};
      const jobs=await this.#state.listFiltered(this.#path,source,null),ambiguous=jobs.find(j=>j.state==="Starting"),currentGeneration=this.#generation();
      const begun=await this.#state.beginAppServerForkHandoff(this.#path,{handoffId:randomUUID(),ambiguousJobId:ambiguous?.jobId??null,sourceThreadId:source,
        expectedGeneration:ambiguous?.appServerGeneration??currentGeneration,quarantineReason:reason});
      if(!begun.created){
        if(begun.handoff.targetThreadId!==null)return {kind:"done",target:{threadId:begun.handoff.targetThreadId,forkedFrom:source,quarantinedJobId:begun.handoff.ambiguousJobId}};
        if(begun.handoff.observedTargetThreadId!==null)return {kind:"finalize",source,handoff:begun.handoff.handoffId,target:begun.handoff.observedTargetThreadId};
        return this.#unresolved(source,begun.handoff);
      }
      const target=await this.#request(source,begun.handoff);return {kind:"finalize",source,handoff:begun.handoff.handoffId,target};
    });
    if(decision.kind==="done")return decision.target;
    // No source lock is retained while awaiting another target. The durable fence blocks replay;
    // finalize rechecks the exact source/target pair inside its write transaction.
    return this.#locks.runPair(decision.source,decision.target,()=>this.#finalize(decision));
  }
  async #request(source:string,h:AppServerForkHandoff):Promise<string>{
    let target:string;
    try{
      if(this.#backend.forkThread===undefined)throw new BackendFailureError({kind:"Other",ambiguous:false,message:"thread/fork is not supported by this backend"});
      target=await this.#backend.forkThread(source);
    }catch(error){
      // Unknown JS exceptions cannot authorize definite cancellation; retain the unresolved fence.
      if(!(error instanceof BackendFailureError))throw error;const failure=error.failure;
      try{if(failure.ambiguous)await this.#state.recordAppServerForkFailure(this.#path,h.handoffId,failure.message,true);
        else await this.#state.recordAndCancelDefiniteForkFailure(this.#path,h,failure.message);
      }catch(recording){throw new ForkRuntimeError({kind:"ForkFailureRecording",sourceThreadId:source,handoffId:h.handoffId,failure,recording});}
      throw new ForkRuntimeError({kind:"ForkBackend",sourceThreadId:source,handoffId:h.handoffId,failure});
    }
    if(typeof target!=="string")throw new TypeError("Fork backend returned a non-string target; durable handoff remains unresolved");
    try{await this.#state.stageAppServerForkTarget(this.#path,h.handoffId,target);}catch(staging){throw new ForkRuntimeError({kind:"ForkTargetStage",sourceThreadId:source,handoffId:h.handoffId,targetThreadId:target,staging});}
    return target;
  }
  async #finalize(plan:Extract<Decision,{kind:"finalize"}>):Promise<AppServerTarget>{
    const generation=this.#generation();let completed;
    try{completed=await this.#state.finalizeAppServerForkHandoff(this.#path,plan.handoff,generation,{sourceThreadId:plan.source,targetThreadId:plan.target});}
    catch(failure){
      const message=failure instanceof Error?failure.message:"unclassified finalization failure";
      try{await this.#state.recordAppServerForkFinalizeFailure(this.#path,plan.handoff,message);}catch(recording){throw new ForkRuntimeError({kind:"ForkFinalizeRecording",sourceThreadId:plan.source,handoffId:plan.handoff,targetThreadId:plan.target,failure,recording});}
      throw new ForkRuntimeError({kind:"ForkFinalize",sourceThreadId:plan.source,handoffId:plan.handoff,targetThreadId:plan.target,failure});
    }
    return {threadId:plan.target,forkedFrom:plan.source,quarantinedJobId:completed.quarantinedJob?.jobId??null};
  }
}
