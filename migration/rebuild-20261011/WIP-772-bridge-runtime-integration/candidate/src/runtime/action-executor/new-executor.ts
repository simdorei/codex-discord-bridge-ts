import {NativeBridgeStateOwner} from '../bridge-state-native.ts';
import {directNewProjectLookup,type NewProjectLookup} from './new-project-cwd.ts';
import {newStateFunction,newStatePromise} from './new-state-call.ts';
import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {startThread} from '../../app-server/requests.ts';
import {extractThreadId} from '../../app-server/identity.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {newExecutionPrompt,newCommandPrompt} from '../../store/ingress-new-input.ts';
import type {StoredIngress} from '../../store/ingress-read.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {AppServerTurnBackend} from '../app-server-turn-backend.ts';
import {QueueStartCoordinator} from '../queue-runner/start-coordinator.ts';
import {PromptIntakeProcessor} from '../prompt-intake/processor.ts';
import {BridgeState} from '../bridge-state.ts';
import {NewThreadJournal,type NewActionContext,type NewJournalState} from './new-journal.ts';
import {NewThreadProject} from './new-project.ts';
import {NewFirstReply} from './new-first-reply.ts';
import {beginNewThreadAttempt,type NewAttemptReport,type NewAttemptState} from './new-attempt.ts';
import {InvalidActionRequestError,MissingActionAppServerError,ActionIntegerRangeError} from './errors.ts';
import {submissionResult} from './submission-result.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
export type NewThreadState=NewJournalState & NewAttemptState & Pick<typeof state,'getPromptIntake'|'recordIngressNewCreation'|'recordIngressCreatedThread'>;
function captureThreadState(port:NewThreadState):NewThreadState {return Object.freeze({ingressByOrigin:newStateFunction(port,'ingressByOrigin'),admitIngress:newStateFunction(port,'admitIngress'),holdIngress:newStateFunction(port,'holdIngress'),getIngress:newStateFunction(port,'getIngress'),beginIngressThreadStart:newStateFunction(port,'beginIngressThreadStart'),getPromptIntake:newStateFunction(port,'getPromptIntake'),recordIngressNewCreation:newStateFunction(port,'recordIngressNewCreation'),recordIngressCreatedThread:newStateFunction(port,'recordIngressCreatedThread')});}
export interface NewMirrorLink {linkNewThread(channel:bigint,thread:string,prompt:string,cwd:string|null,signal?:AbortSignal):Promise<bigint>}
/** Composes real resident creation, durable original custody and first intake.
 * null mirror is an explicit headless profile, never an uncertain-create fallback.
 * A concrete production mirror-link implementation is still required separately. */
export class NewThreadExecutor {
 readonly #nativeBridge:NativeBridgeStateOwner|undefined;
 readonly #state:NewThreadState;
 readonly #database:string;readonly #journal:NewThreadJournal;readonly #project:NewThreadProject;readonly #reply:NewFirstReply;readonly #queue:QueueStartCoordinator;readonly #intake:PromptIntakeProcessor;readonly #bridge:BridgeState;readonly #server:PortableResidentLifecycle|null;readonly #backend:AppServerTurnBackend|null;readonly #mirror:NewMirrorLink|null;readonly #link:NewMirrorLink['linkNewThread']|null;readonly #report:(value:NewAttemptReport)=>void;readonly #now:()=>number;
 constructor(database:string,statePath:string,queue:QueueStartCoordinator,intake:PromptIntakeProcessor,bridge:BridgeState,server:PortableResidentLifecycle|null,backend:AppServerTurnBackend|null,mirror:NewMirrorLink|null,report:(value:NewAttemptReport)=>void,now:()=>number=systemNow,admit:typeof state.admitPromptIntakeWithIngress=state.admitPromptIntakeWithIngress,finishRead:typeof state.getNewFirstReplyFinish=state.getNewFirstReplyFinish,journalState:NewThreadState=state,projectLookup:NewProjectLookup=directNewProjectLookup,nativeBridge?:NativeBridgeStateOwner){this.#nativeBridge=nativeBridge;
  requireDiscordText(database);requireDiscordText(statePath);if((server===null)!==(backend===null))throw new TypeError('Expected matching resident/backend availability');
  if(server!==null&&backend!==null&&backend.residentInstanceId()!==server.instanceId)throw new TypeError('New executor resident/backend mismatch');
  for(const fn of [report,now])if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected synchronous new executor callback');
  if(mirror!==null&&(typeof mirror!=='object'||types.isProxy(mirror)))throw new TypeError('Expected mirror-link object');
  const link=mirror===null?null:Object.getOwnPropertyDescriptor(mirror,'linkNewThread');if(mirror!==null&&(link===null||link===undefined||!Object.hasOwn(link,'value')||typeof link.value!=='function'||types.isProxy(link.value)))throw new TypeError('Expected owned mirror-link function');
  this.#state=captureThreadState(journalState);this.#database=database;this.#queue=queue;this.#intake=intake;this.#bridge=bridge;this.#server=server;this.#backend=backend;this.#mirror=mirror;this.#link=link?.value??null;this.#report=report;this.#now=now;
  this.#journal=new NewThreadJournal(database,now,this.#state);this.#project=new NewThreadProject(database,statePath,this.#journal,mirror!==null,now,this.#state,projectLookup);this.#reply=new NewFirstReply(database,statePath,this.#journal,mirror!==null,()=>QueueStartCoordinator.prototype.notifyDeliveryReady.call(queue),admit,finishRead);Object.freeze(this);
 }
 async #replay(ingress:StoredIngress,signal?:AbortSignal):Promise<ActionResult|null>{
  if(ingress.ownerId===null)return null;const intake=await newStatePromise(Reflect.apply(this.#state.getPromptIntake,undefined,[this.#database,ingress.ownerId]));signal?.throwIfAborted();if(intake!==null)return this.#intake.processAdmittedPrompt(intake,signal);
  const saved=await this.#queue.replaySubmissionWithTargetForJob(ingress.ownerId);signal?.throwIfAborted();if(saved!==null){const prompt=newCommandPrompt(ingress);if(prompt===null)throw new InvalidActionRequestError('saved new request has no verified original prompt');return submissionResult(saved[0],'new',saved[1],prompt);}
  return {text:`This /new request was already accepted; no new thread or prompt was created.\nthread_id: ${ingress.targetThreadId??'recorded'}\njob_id: ${ingress.ownerId}`,waitsForFinal:false,ui:null};
 }
 async execute(input:NewActionContext,prompt:string,signal?:AbortSignal):Promise<ActionResult>{
  const context=cloneOwnedSerdeValue(input) as NewActionContext;requireDiscordText(prompt);signal?.throwIfAborted();const ingress=await this.#journal.admit(context,prompt,signal);
  const replay=await this.#replay(ingress,signal);if(replay!==null)return this.#reply.finish(ingress,replay);
  const executionPrompt=newExecutionPrompt(ingress);if(executionPrompt===null)throw new InvalidActionRequestError('new request has no original execution input');
  const server=this.#server,backend=this.#backend;if(server===null||backend===null)throw await this.#journal.hold(ingress,new MissingActionAppServerError(),true);
  const generation=server.generation();if(generation<0n||generation>=(1n<<63n))throw new ActionIntegerRangeError();
  const attempt=await beginNewThreadAttempt(this.#database,this.#journal,ingress,generation,this.#report,this.#now,signal,this.#state);
  try{return await attempt.run(async()=>{
   const cwd=await this.#project.freeze(ingress,context.channelId,generation,signal);signal?.throwIfAborted();let value:unknown;
   try{value=await server.execute(startThread(cwd),generation,signal);}catch(error){throw await this.#journal.hold(ingress,error,false);}
   const thread=extractThreadId(value);if(thread===null)throw await this.#journal.hold(ingress,new InvalidActionRequestError('thread/start returned no thread id'),false);
   backend.rememberNewThread(thread,generation);
   try{await newStatePromise(Reflect.apply(this.#state.recordIngressCreatedThread,undefined,[this.#database,ingress.ingressId,generation,thread,readCustodyTimestamp(this.#now)]));}catch(error){throw await this.#journal.hold(ingress,new InvalidActionRequestError(`thread ${thread} was created but recording its known identity failed: ${passiveErrorText(error,'recording failed')}`),false);}
   signal?.throwIfAborted();let destination=context.channelId;
   if(this.#link!==null){try{const linked=Reflect.apply(this.#link,this.#mirror,[context.channelId,thread,prompt,cwd,signal]);if(!types.isPromise(linked))throw new TypeError('Expected native mirror-link Promise');destination=await linked as bigint;}catch(error){throw await this.#journal.hold(ingress,error,false);}}
   signal?.throwIfAborted();let admitted;
   try{admitted=await this.#reply.admit({jobId:randomUUID(),targetThreadId:thread,channelId:destination,ownerUserId:context.userId,discordMessageId:context.discordMessageId,rawPrompt:executionPrompt,autoQueueWhenBusy:context.autoQueueWhenBusy,requireCurrentMirror:this.#mirror!==null,createdAt:readCustodyTimestamp(this.#now)},ingress,generation);}catch(error){throw await this.#journal.hold(ingress,new InvalidActionRequestError(`thread ${thread} was created but its prompt ownership could not be saved: ${passiveErrorText(error,'ownership failed')}`),false);}
   if(this.#nativeBridge===undefined)BridgeState.prototype.setSelectedThreadId.call(this.#bridge,thread);else await this.#nativeBridge.execute({kind:'Select',id:thread},signal);const result=await this.#intake.processAdmittedPrompt(admitted.intake,signal);return this.#reply.finish(ingress,result);
  });}finally{await attempt.dispose();}
 }
}
Object.freeze(NewThreadExecutor.prototype);
