import {setTimeout as delay} from "node:timers/promises";
import type {PortableResidentLifecycle} from "../../app-server/portable-resident-lifecycle.ts";
import {readThreadWithTimeout,getGoal} from "../../app-server/requests.ts";
import {parseThreadGoalStatus,type ThreadGoalStatus} from "../../app-server/goal.ts";
import {parseThreadTurnStates,extractTurnText,TurnOutcomeError,type TurnCompletion} from "../../app-server/outcomes.ts";
import {serdeField} from "../../app-server/value.ts";
import {cloneOwnedSerdeValue} from "../../core/owned-serde-value.ts";
import {snapshotStoredQueueJob,storedQueueJobsEqual,type StoredQueueJob} from "../../store/queue-read.ts";
import {turnOriginMarker} from "../../store/mirror-event-read.ts";
import {StateAccessFacade,type IStateAccessFacade} from "../../store/state-access-facade.ts";
import {CompletionHeldError} from "./receipt-sender.ts";
type Server=Pick<PortableResidentLifecycle,"generation"|"execute">;
type Store=Pick<IStateAccessFacade,"listFiltered"|"deadTargetHeld"|"hasMirrorEvent"|"getObservedFinalAnswer">;
export interface ExactCompletionReply{readonly text:string|null;readonly needsGoalHandoff:boolean}
export type CompletionHistorySleep=(milliseconds:number,signal?:AbortSignal)=>Promise<void>;
/** Exact original history only. A successor blocks Final or permits progress; it never
 * becomes a selected owner here. Native execute retains expected generation and timeout. */
export class CompletionHistoryContext{
 readonly #path:string;readonly #server:Server;readonly #timeout:number;readonly #state:Store;readonly #sleep:CompletionHistorySleep;
 constructor(path:string,server:Server,historyReadTimeoutMs:number,state:Store=StateAccessFacade,sleep:CompletionHistorySleep=(ms,signal)=>delay(ms,undefined,{signal})){readThreadWithTimeout("",true,historyReadTimeoutMs);this.#path=path;this.#server=server;this.#timeout=historyReadTimeoutMs;this.#state=state;this.#sleep=sleep;}
 async goalStatus(generation:bigint,thread:string,signal?:AbortSignal):Promise<ThreadGoalStatus|null>{const result=await this.#server.execute(getGoal(thread),generation,signal);return parseThreadGoalStatus(result,thread);}
 async #history(generation:bigint,thread:string,signal?:AbortSignal):Promise<unknown>{signal?.throwIfAborted();return cloneOwnedSerdeValue(await this.#server.execute(readThreadWithTimeout(thread,true,this.#timeout),generation,signal));}
 #states(result:unknown,thread:string,held:(reason:string)=>Error):Map<string,TurnCompletion>{
  const states=parseThreadTurnStates(result,thread),turns=serdeField(serdeField(result,"thread"),"turns");if(!Array.isArray(turns)||turns.length!==states.size)throw held("duplicate history turn identity");return states;
 }
 async requireOwner(generation:bigint,input:StoredQueueJob):Promise<void>{
  const expected=snapshotStoredQueueJob(input),owners=(await this.#state.listFiltered(this.#path,null,null)).filter(job=>job.targetThreadId===expected.targetThreadId&&job.state==="Running");
  if(generation!==this.#server.generation()||owners.length!==1||!storedQueueJobsEqual(owners[0]!,expected)||await this.#state.deadTargetHeld(this.#path,expected.targetThreadId))throw new CompletionHeldError("resident or completion ownership changed during history read");
 }
 async waitingGoalCompletion(generation:bigint,input:StoredQueueJob,signal?:AbortSignal):Promise<TurnCompletion>{
  const expected=snapshotStoredQueueJob(input),held=(reason:string)=>new CompletionHeldError(`Goal completion held for ${expected.targetThreadId}: ${reason}; original progress owner retained`);
  if(!expected.goalWaiting||expected.state!=="Running")throw held("not the exact waiting owner");if(expected.turnId===null)throw held("missing prior turn");
  const result=await this.#history(generation,expected.targetThreadId,signal),states=this.#states(result,expected.targetThreadId,held),completion=states.get(expected.turnId);
  if(completion===undefined)throw held("prior turn absent from history");if(completion.status==="InProgress")throw held("prior turn is not terminal");
  for(const [id,status] of states){signal?.throwIfAborted();if(id===expected.turnId||expected.baselineTurnIds.includes(id))continue;if(status.status==="InProgress"||!await this.#state.hasMirrorEvent(this.#path,turnOriginMarker(expected.targetThreadId,id),expected.targetThreadId))throw held("unattached turn requires an exact start observation");}
  const owners=(await this.#state.listFiltered(this.#path,null,null)).filter(job=>job.targetThreadId===expected.targetThreadId&&job.state==="Running");
  if(generation!==this.#server.generation()||owners.length!==1||!storedQueueJobsEqual(owners[0]!,expected)||await this.#state.deadTargetHeld(this.#path,expected.targetThreadId))throw held("resident or waiting ownership changed during history read");return completion;
 }
 async goalHistoryHasUnattachedTurn(result:unknown,input:StoredQueueJob,inputCompletion:TurnCompletion,signal?:AbortSignal):Promise<boolean>{
  const expected=snapshotStoredQueueJob(input),completion=cloneOwnedSerdeValue(inputCompletion) as TurnCompletion,states=this.#states(result,expected.targetThreadId,reason=>new CompletionHeldError(reason));
  const original=states.get(completion.turnId);if(original!==undefined&&original.status!==completion.status)throw new CompletionHeldError("owned terminal status changed in history");
  for(const [id,status]of states){signal?.throwIfAborted();if(id===completion.turnId||expected.baselineTurnIds.includes(id))continue;if(status.status==="InProgress"||!await this.#state.hasMirrorEvent(this.#path,turnOriginMarker(expected.targetThreadId,id),expected.targetThreadId))return true;}return false;
 }
 async exactText(serverGeneration:bigint,evidenceGeneration:bigint,inputCompletion:TurnCompletion,inputOwner:StoredQueueJob,inspectGoalHistory:boolean,signal?:AbortSignal):Promise<ExactCompletionReply>{
  if(typeof inspectGoalHistory!=="boolean")throw new TypeError("Expected Goal history inspection flag");const completion=cloneOwnedSerdeValue(inputCompletion) as TurnCompletion,owner=snapshotStoredQueueJob(inputOwner);if(owner.targetThreadId!==completion.threadId||owner.turnId!==completion.turnId)throw new CompletionHeldError("completion context original owner mismatch");let text:string|null=null,needsGoalHandoff=false;
  for(let attempt=0;attempt<3;attempt++){
   const result=await this.#history(serverGeneration,completion.threadId,signal);
   if(inspectGoalHistory){const found=await this.goalHistoryHasUnattachedTurn(result,owner,completion,signal);needsGoalHandoff=needsGoalHandoff||found;if(owner.goalWaiting&&needsGoalHandoff)throw new CompletionHeldError("unattached turn requires an exact start observation; waiting owner retained");}
   try{const observed=extractTurnText(result,completion.threadId,completion.turnId);text=observed.text;if(observed.explicitFinal)break;}catch(error){if(!(error instanceof TurnOutcomeError)||error.kind!=="TurnNotFound")throw error;}
   const stored=await this.#state.getObservedFinalAnswer(this.#path,completion.threadId,completion.turnId,evidenceGeneration);if(stored!==null){text=stored;break;}
   if(attempt+1<3)await this.#sleep(100,signal);
  }
  signal?.throwIfAborted();await this.requireOwner(serverGeneration,owner);return Object.freeze({text,needsGoalHandoff});
 }
}
