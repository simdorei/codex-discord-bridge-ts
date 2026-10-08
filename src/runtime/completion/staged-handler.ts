import {types} from "node:util";
import {requireDiscordText} from "../../discord/text.ts";
import type {PortableResidentLifecycle} from "../../app-server/portable-resident-lifecycle.ts";
import type {ResidentNotificationEvent} from "../../app-server/resident-forwarders.ts";
import {cloneOwnedSerdeValue} from "../../core/owned-serde-value.ts";
import {parseSerdeValue} from "../../core/serde-json-parse.ts";
import type {TargetLease} from "../../core/keyed-locks.ts";
import {extractThreadId,extractTurnId} from "../../app-server/identity.ts";
import {serdeField} from "../../app-server/value.ts";
import {isAsyncAgentMessage,parseTurnCompletion,parseThreadTurnStates,type TurnCompletion} from "../../app-server/outcomes.ts";
import {parseThreadGoalUpdate,type ThreadGoalStatus} from "../../app-server/goal.ts";
import {readThreadWithTimeout} from "../../app-server/requests.ts";
import {StateAccessFacade as state} from "../../store/state-access-facade.ts";
import {snapshotCompletionEntry,type CompletionEntry} from "../../store/completion-metadata.ts";
import {storedQueueJobsEqual,completionEvidenceGeneration,type StoredQueueJob} from "../../store/queue-read.ts";
import {DrainGateError,type AdmissionPermit} from "../../admission/drain-gate.ts";
import {QueueStartCoordinator,QueueIntegerRangeError} from "../queue-runner/start-coordinator.ts";
import {CommentaryBuffer} from "../commentary-stream.ts";
import {CompletionHistoryContext,type CompletionHistorySleep} from "./history-context.ts";
import {CompletionStateAdmission} from "./scheduler/state-admission.ts";
import {observeCompletionTerminal} from "./observation.ts";
import {completionMessage} from "./message.ts";
import {CompletionHeldError} from "./receipt-sender.ts";
type Server=Pick<PortableResidentLifecycle,"instanceId"|"generation"|"execute"|"activeTurnId">;
const integer=(value:bigint):bigint=>{if(typeof value!=="bigint"||value<0n||value>=(1n<<63n))throw new QueueIntegerRangeError();return value;};
const MISSING_REPLY="ERROR: Codex turn completed, but its exact final reply could not be recovered: thread/read did not contain the requested turn and no matching final-answer event was stored.";
/** Production staged mode only. No inline Discord POST or next-job start. Source
 * receiver and scheduler supply exact live events / revalidated durable entries. */
export class StagedCompletionHandler{
 readonly #server:Server;readonly #queue:QueueStartCoordinator;readonly #path:string;readonly #history:CompletionHistoryContext;readonly #timeout:number;readonly #commentaryEnabled:boolean;readonly #commentary=new CommentaryBuffer();readonly #render:(error:unknown)=>string;
 constructor(server:Server,queue:QueueStartCoordinator,options:{commentaryEnabled:boolean;historyReadTimeoutMs:number;render:(error:unknown)=>string;sleep?:CompletionHistorySleep}){if(typeof options.commentaryEnabled!=="boolean")throw new TypeError("Expected commentary setting");if(typeof options.render!=="function"||types.isProxy(options.render)||types.isAsyncFunction(options.render)||types.isGeneratorFunction(options.render))throw new TypeError("Expected public-safe synchronous state diagnostic renderer");this.#render=options.render;this.#server=server;this.#queue=queue;this.#path=queue.dbPath;this.#timeout=options.historyReadTimeoutMs;this.#history=new CompletionHistoryContext(this.#path,server,this.#timeout,state,options.sleep);this.#commentaryEnabled=options.commentaryEnabled;}
 async handleLive(input:ResidentNotificationEvent,admission:CompletionStateAdmission,signal?:AbortSignal):Promise<void>{
  const event=cloneOwnedSerdeValue(input) as ResidentNotificationEvent;
  await this.#queue.locks.runUnderLease(admission.borrowLease(),async pin=>{
   signal?.throwIfAborted();if(event.kind==="Notification"){const target=extractThreadId(event.notification.params);if(target!==null)pin.requireTarget(target);}
   await observeCompletionTerminal(this.#path,this.#server.instanceId,event);signal?.throwIfAborted();if(event.kind==="Gap")return;if(event.kind!=="Notification")throw new TypeError("Expected resident event");const {notification:n,generation}=event;
   if(n.method==="item/completed"&&isAsyncAgentMessage(serdeField(n.params,"item"))){this.#queue.notifyDeliveryReady();return;}
   if(this.#commentaryEnabled){const block=this.#commentary.observe(n.method,n.params);if(block!==null&&await state.stageCommentary(this.#path,block.threadId,block.turnId,block.text)!==null)this.#queue.notifyDeliveryReady();}
   signal?.throwIfAborted();switch(n.method){
    case "turn/started":{const thread=extractThreadId(n.params),turn=extractTurnId(n.params);if(thread===null||turn===null)return;
     await state.supersedeAsyncQuestions(this.#path,this.#server.instanceId,integer(generation),thread,turn);await this.#queue.goalTurnStartedObservedUnderLease(pin,turn,generation,null);
     await state.reconcileAsyncQuestionObservations(this.#path,this.#server.instanceId,integer(this.#server.generation()));this.#queue.notifyDeliveryReady();return;}
    case "turn/completed":{const c=parseTurnCompletion(n.params,false);await this.#finish(generation,integer(generation),c,null,admission,pin,signal);return;}
    case "thread/goal/updated":{const update=parseThreadGoalUpdate(n.params);if(update.status!=="Active"){const job=(await state.listFiltered(this.#path,null,null)).find(j=>j.state==="Running"&&j.targetThreadId===update.threadId&&j.goalWaiting);if(job)await this.#finishWaiting(generation,job,admission,pin,signal);}return;}
   }
  });
 }
 async handleDurable(input:CompletionEntry,admission:CompletionStateAdmission,signal?:AbortSignal):Promise<void>{
  const entry=snapshotCompletionEntry(input);await this.#queue.locks.runUnderLease(admission.borrowLease(),async pin=>{
   pin.requireTarget(entry.target);signal?.throwIfAborted();if(entry.source==="AsyncOrphan"){await this.#queue.reconcileOrphanHistoryUnderLease(pin);return;}if(entry.source==="Queue"){await this.#recoverLane(entry.target,admission,pin,signal);return;}
   if(entry.source!=="Observed")throw new TypeError("Expected state completion source");const payload=await state.loadCompletionPayload(this.#path,entry,this.#server.instanceId,integer(this.#server.generation()));if(payload===null||payload.kind!=="Observed")return;
   try{const completion=parseTurnCompletion(parseSerdeValue(payload.json),false);await this.#finish(this.#server.generation(),payload.generation,completion,null,admission,pin,signal);}
   catch(error){if(signal?.aborted&&error===signal.reason)throw error;const message=this.#render(error);if(types.isPromise(message))void Promise.prototype.then.call(message,undefined,()=>undefined);requireDiscordText(message);await state.recordObservedCompletionError(this.#path,entry.target,entry.turn,message);throw error;}
  });
 }
 async #finish(generation:bigint,evidence:bigint,c:TurnCompletion,expected:StoredQueueJob|null,admission:CompletionStateAdmission,pin:TargetLease,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();const owner=(await state.listFiltered(this.#path,null,null)).find(j=>j.state==="Running"&&j.targetThreadId===c.threadId&&j.turnId===c.turnId);if(owner===undefined)throw new CompletionHeldError("captured completion owner no longer exists");admission.validateOwner(owner);if(expected!==null&&!storedQueueJobsEqual(expected,owner))throw new CompletionHeldError("captured completion ownership changed");
  this.#commentary.discardTurn(c.threadId,c.turnId);const goal=c.status==="Completed"?await this.#history.goalStatus(generation,c.threadId,signal):null;
  if(owner.goalWaiting&&goal!=="Active"){const confirmed=await this.#history.waitingGoalCompletion(generation,owner,signal);if(confirmed.status!==c.status)throw new CompletionHeldError("waiting terminal status changed");}
  const reply=c.status==="Completed"?await this.#history.exactText(generation,evidence,c,owner,(goal!==null||owner.goalWaiting)&&goal!=="Active",signal):{text:"",needsGoalHandoff:false},continues=goal==="Active"||reply.needsGoalHandoff;
  signal?.throwIfAborted();if(continues){const text=reply.text===null?MISSING_REPLY:reply.text===""?"":`[Goal progress]\n${reply.text}`;if(await this.#queue.stageOwnedGoalProgressUnderLease(pin,owner,text)!==null)this.#queue.notifyDeliveryReady();return;}
  await this.#stageTerminal(owner,c,reply.text===null?MISSING_REPLY:completionMessage(c.status,c.errorMessage,reply.text,goal),evidence,pin);
 }
 async #stageTerminal(owner:StoredQueueJob,c:TurnCompletion,text:string,generation:bigint,pin:TargetLease):Promise<void>{
  const confirmed=await state.hasObservedCompletionResidentEvidence(this.#path,c.threadId,c.turnId,generation,this.#server.instanceId);await this.#queue.stageOwnedTurnCompletionUnderLease(pin,owner,text,confirmed?generation:null);
 }
 async #finishWaiting(generation:bigint,job:StoredQueueJob,admission:CompletionStateAdmission,pin:TargetLease,signal?:AbortSignal):Promise<void>{const completion=await this.#history.waitingGoalCompletion(generation,job,signal);await this.#finish(generation,completionEvidenceGeneration(job),completion,job,admission,pin,signal);}
 async #attachActive(job:StoredQueueJob,pin:TargetLease):Promise<boolean>{const generation=this.#server.generation(),active=await this.#server.activeTurnId(job.targetThreadId);return active===null?false:this.#queue.goalTurnStartedObservedUnderLease(pin,active,generation,job);}
 async #recoverJob(generation:bigint,job:StoredQueueJob,admission:CompletionStateAdmission,pin:TargetLease,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();if(job.goalWaiting){if(await this.#attachActive(job,pin))return;if(await this.#history.goalStatus(generation,job.targetThreadId,signal)!=="Active")await this.#finishWaiting(generation,job,admission,pin,signal);return;}
  if(job.turnId===null){await this.#attachActive(job,pin);return;}const result=await this.#server.execute(readThreadWithTimeout(job.targetThreadId,true,this.#timeout),generation,signal),states=parseThreadTurnStates(result,job.targetThreadId),completion=states.get(job.turnId);if(completion!==undefined&&completion.status!=="InProgress")await this.#finish(generation,completionEvidenceGeneration(job),completion,job,admission,pin,signal);
 }
 async #recoverLane(target:string,admission:CompletionStateAdmission,pin:TargetLease,signal?:AbortSignal):Promise<void>{
  let permit:AdmissionPermit|undefined,draining=false;
  try{try{const admitted=this.#queue.enterBackgroundRecovery();if(admitted!==null){[permit,draining]=admitted;}}catch(error){if(error instanceof DrainGateError&&error.kind==="Sealed")return;throw error;}
   if(!draining){const report=await this.#queue.recoverIncrementalUnderLease(pin);if(report.readUnavailableTargets.has(target))return;}
   const generation=this.#server.generation(),jobs=(await state.listFiltered(this.#path,target,null)).filter(j=>j.state==="Running");let failed=false,first:unknown;
   for(const job of jobs){try{await this.#recoverJob(generation,job,admission,pin,signal);}catch(error){if(signal?.aborted&&error===signal.reason)throw error;if(!failed){failed=true;first=error;}}}if(failed)throw first;
  }finally{permit?.release();}
 }
}
