import {AppServerInvalidReplyError} from "./client-errors.ts";
import {ResponseAttempt,type ResponseResult} from "./response-attempt.ts";
import {responseValue,errorValue,type RpcErrorPayload,type RequestId,ServerRequestOccurrence} from "../protocol/rpc.ts";
import {DispatchAttempt,type DispatchResult} from "./dispatch-attempt.ts";
import {WrittenRequestGuard} from "./written-request-guard.ts";
import {ownedRequestFailure} from "./request-client.ts";
import {isOwnedMutationOutcomeUnknown} from "./maintenance-attempt.ts";
import {cloneAppRequest,isObservationalRequest,type AppRequest} from "./requests.ts";
import {serdeField,rustTrim} from "./value.ts";
import {serdeValueEqual} from "../core/serde-value-equal.ts";
import {currentStopOrigin,hasStopOriginScope,withoutStopOriginScope,withStopOrigin} from "./dispatch-origin.ts";
import {extractThreadId} from "./identity.ts";
import {IdleMaintenanceWork} from "./idle-maintenance.ts";
import {MaintenanceTransport,pinResidentMaintenanceOptions,type ResidentMaintenanceOptions} from "./maintenance-transport.ts";
import {IdleTargetGate,type TargetExclusivePermit,type TargetMutationPermit} from "./idle-target-gate.ts";
import {cloneIdleReleaseToken,pinIdleReleaseJournal,type IdleReleaseToken,type IdleReleaseJournal} from "./idle-release-journal.ts";
import {IdleObservationError,type AppNotification} from "./notification-state.ts";
import {runRestartSupervisor,type RestartFailureReporter} from "./restart-supervisor.ts";
import {randomUUID} from "node:crypto";
import {types} from "node:util";
import {TargetLocks} from "../core/keyed-locks.ts";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {invokeSynchronousVoid} from "../core/synchronous-void.ts";
import {PortableAppServerSession,PortableSessionCleanupPendingError,isOwnedPortableResidentClientPort,type PortableResidentClientPort,type PortableSessionConfig,type SessionDiagnosticRenderer} from "./portable-session.ts";
import {ResidentAdmissionState,ResidentStateError,type ResidentAdmission,type ReplacementCleanup} from "./resident-state.ts";
import {ResidentForwarders,type ResidentNotificationEvent,type ResidentServerRequestEvent} from "./resident-forwarders.ts";
import {GenerationWatch} from "./generation-watch.ts";
import {BoundedBroadcast} from "./broadcast.ts";
import type {DeadGenerationWork} from "./dead-generation-work.ts";
export type PreparedTargetMutation={readonly kind:"Ready";readonly permit:TargetMutationPermit|null}|{readonly kind:"Completed";readonly value:unknown};
interface DispatchContext{readonly check:(()=>void)|null;readonly queueClaim:unknown|null;readonly stopClaim:unknown|null;readonly clientPin:PortableResidentClientPort|null}
/** Cancel only the caller's wait, while disposing a late Ready permit if preparation
 * was already handed to managed resume. The managed operation itself keeps running. */
function awaitPrepared(task:Promise<PreparedTargetMutation>,signal?:AbortSignal):Promise<PreparedTargetMutation>{
  if(signal===undefined)return task;
  return new Promise((resolve,reject)=>{
    let abandoned=false;
    const abort=()=>{if(abandoned)return;abandoned=true;signal.removeEventListener("abort",abort);reject(signal.reason);};
    if(signal.aborted)abort();else signal.addEventListener("abort",abort,{once:true});
    void task.then(prepared=>{signal.removeEventListener("abort",abort);if(abandoned){if(prepared.kind==="Ready")prepared.permit?.release();}else resolve(prepared);},error=>{signal.removeEventListener("abort",abort);if(!abandoned)reject(error);});
  });
}
export interface ResidentPersistence{
  /** Return only after exact work is durably captured for this resident instance. */
  persistDeadWork(instanceId:string,work:DeadGenerationWork):void;
  /** Called only for this exact owned client after its closer confirms native exit. */
  oldChildExited(instanceId:string,generation:bigint):void;
}
function syncFunction(value:unknown):asserts value is Function{if(typeof value!=="function"||types.isProxy(value)||types.isAsyncFunction(value)||types.isGeneratorFunction(value))throw new TypeError("Expected synchronous resident hook");}
function pinPersistence(input:ResidentPersistence):ResidentPersistence{
  if(input===null||typeof input!=="object"||types.isProxy(input))throw new TypeError("Expected resident persistence adapter");
  const get=(key:string):Function=>{const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own persistence hook");syncFunction(d.value);return d.value;};
  const persist=get("persistDeadWork"),exited=get("oldChildExited");return Object.freeze({persistDeadWork:(id:string,work:DeadGenerationWork)=>invokeSynchronousVoid(persist,input,[id,work]),oldChildExited:(id:string,generation:bigint)=>invokeSynchronousVoid(exited,input,[id,generation])});
}
function throwErrors(errors:unknown[],message:string):void{if(errors.length===1)throw errors[0];if(errors.length>1)throw new AggregateError(errors,message);}
/** Non-Windows owned lifecycle/replacement and bounded idle-maintenance coordinator.
 * Raw admission is internal; ordinary queue/mutation dispatch still needs its durable coordinator.
 * Persistence ports are mandatory, explicit and trusted; no no-op default exists.
 * Supervisor is explicit owner-started/joined; no 45s startup envelope or descendant-pipe cleanup. */
export class PortableResidentLifecycle{
  readonly #targetGate=new IdleTargetGate();
  readonly #maintenance:ResidentMaintenanceOptions|null;readonly #managedIdle=new Set<Promise<unknown>>();
  readonly instanceId=randomUUID();readonly #config:PortableSessionConfig;readonly #render:SessionDiagnosticRenderer;readonly #persistence:ResidentPersistence;
  readonly #lock=new TargetLocks();readonly #generation=new GenerationWatch(1n);
  readonly #notifications=new BoundedBroadcast<ResidentNotificationEvent>(1000);readonly #requests=new BoundedBroadcast<ResidentServerRequestEvent>(500);
  readonly #sessions=new Map<PortableResidentClientPort,PortableAppServerSession>();#state!:ResidentAdmissionState<PortableResidentClientPort>;#forwarders:ResidentForwarders|null=null;#disposed=false;
  private constructor(config:PortableSessionConfig,render:SessionDiagnosticRenderer,persistence:ResidentPersistence,maintenance:ResidentMaintenanceOptions|null){this.#maintenance=maintenance===null?null:pinResidentMaintenanceOptions(maintenance);syncFunction(render);this.#config=cloneOwnedSerdeValue(config) as PortableSessionConfig;this.#render=render;this.#persistence=pinPersistence(persistence);}
  static async start(config:PortableSessionConfig,render:SessionDiagnosticRenderer,persistence:ResidentPersistence,signal?:AbortSignal,maintenance:ResidentMaintenanceOptions|null=null):Promise<PortableResidentLifecycle>{
    const owner=new PortableResidentLifecycle(config,render,persistence,maintenance);let staged:ResidentForwarders|undefined,ready:PortableAppServerSession|undefined;
    try{
      const started=await PortableAppServerSession.startObserved(owner.#config,session=>{owner.#sessions.set(session.residentClient(),session);staged=owner.#prepare(session,1n);return {value:staged,dispose(){}};},render,signal);
      ready=started.session;signal?.throwIfAborted();owner.#state=new ResidentAdmissionState(started.session.residentClient());owner.#forwarders=started.observer.value;owner.#forwarders.activate();return owner;
    }catch(primary){const errors=[primary];if(staged)try{await staged.join();}catch(error){errors.push(error);}if(ready)try{await ready.dispose();}catch(error){errors.push(error);}if(ready&&!ready.resourcesClosed)throw new PortableSessionCleanupPendingError(ready,new AggregateError(errors,"Resident initial startup cleanup failed"));throwErrors(errors,"Resident initial startup cleanup failed");throw primary;}
  }
  #prepare(session:PortableAppServerSession,generation:bigint):ResidentForwarders{return new ResidentForwarders(session,generation,this.#notifications,this.#requests,this.#generation.subscribe(),{waitClosed:signal=>session.waitClosed(signal),onClosed:()=>this.#state.markCurrentClosed(session.residentClient(),generation)});}
  #session(port:PortableResidentClientPort):PortableAppServerSession{const session=this.#sessions.get(port);if(!session)throw new ResidentStateError({kind:"ReplacementState",message:"owned native session is missing"});return session;}
  generation():bigint{return this.#state.generation();}
  /** Install once before target intake. The native client capability is internal;
   * callers must not use its raw prefix setter as substitute for this journal proof. */
  installIdleReleaseJournal(input:IdleReleaseJournal):void{
    const journal=pinIdleReleaseJournal(input),tracked=journal.tracksObservations();
    this.#targetGate.install(journal);
    if(tracked){const admission=this.#state.admitResponse(this.generation());try{admission.client.requireObservationLedger();}finally{admission.release();}}
  }
  observationTrackingEnabled():boolean{return this.#targetGate.journal()?.tracksObservations()??false;}
  /** Managed promise retains exact resident + target ownership until completion.
   * No caller AbortSignal may cancel a request after durable permission is recorded. */
  releaseIdleSubscription(input:IdleReleaseToken):Promise<void>{
    const token=cloneIdleReleaseToken(input),options=this.#maintenance;
    if(options===null)return Promise.reject(new IdleObservationError("maintenance adapter is not installed"));
    if(token.state!=="Candidate"&&token.state!=="AwaitUnload")return Promise.reject(new IdleObservationError("only Candidate or known-ACK AwaitUnload may run maintenance"));
    const origin=options.fence?.requestOrigin("thread/unsubscribe",{threadId:token.threadId})??null;
    const permit=this.#targetGate.reserve(token);
    return this.#runIdle(permit,token,origin,work=>work.release());
  }
  #runIdle<T>(permit:TargetExclusivePermit,token:IdleReleaseToken,origin:unknown|null,run:(work:IdleMaintenanceWork)=>Promise<T>,dispatchCheck:()=>void=()=>{}):Promise<T>{
    const task=withoutStopOriginScope(async()=>{
      let admission;
      try{
        const options=this.#maintenance;if(options===null)throw new IdleObservationError("maintenance adapter is not installed");
        if(token.ownerId!==this.instanceId)throw new IdleObservationError("idle release owner mismatch");
        admission=this.#state.admitRequest(token.generation);
        const transport=new MaintenanceTransport(this.#state,admission,this.#targetGate,permit,token,options.fence,origin,options.renderError,dispatchCheck);
        return await run(new IdleMaintenanceWork(token,permit,transport.port()));
      }finally{try{admission?.release();}finally{permit.release();}}
    });
    this.#managedIdle.add(task);void task.then(()=>this.#managedIdle.delete(task),()=>this.#managedIdle.delete(task));return task;
  }
  /** Internal preparation only: caller retains/releases Ready.permit and invokes
   * checkActualTargetMutation at the actual writer. It is not permission to bypass
   * original queue/stop authority. an existing task scope wins over an explicit origin; otherwise origin is the first captured snapshot. */
  async prepareTargetMutation(method:string,input:unknown,generation:bigint,origin:unknown|null=null,check:()=>void=()=>{}):Promise<PreparedTargetMutation>{
    if(typeof method!=="string"||/[\uD800-\uDFFF]/u.test(method)||typeof generation!=="bigint"||generation<0n||generation>=(1n<<64n))throw new TypeError("Expected target preparation identity");
    const params=cloneOwnedSerdeValue(input),frozenOrigin=hasStopOriginScope()?currentStopOrigin():origin===null?null:cloneOwnedSerdeValue(origin);syncFunction(check);invokeSynchronousVoid(check,{},[]);
    if(["thread/read","thread/turns/list","thread/goal/get","thread/list","thread/loaded/list","model/list","account/rateLimits/read","account/usage/read","thread/start"].includes(method))return Object.freeze({kind:"Ready",permit:null});
    const options=this.#maintenance;
    if(options===null&&this.#targetGate.journal()!==null)throw new IdleObservationError("maintenance adapter is not installed");
    options?.fence?.checkRequest(generation,method,params);
    const target=extractThreadId(params),admitted=this.#targetGate.admit(this.instanceId,generation,target);
    if(admitted.kind==="Ordinary")return Object.freeze({kind:"Ready",permit:admitted.permit});
    const resume=method==="thread/resume"?params:{threadId:admitted.token.threadId};
    const value=await this.#runIdle(admitted.permit,admitted.token,frozenOrigin,work=>work.resubscribe(resume),check);
    if(method==="thread/resume")return Object.freeze({kind:"Completed" as const,value});
    const next=this.#targetGate.admit(this.instanceId,generation,target);
    if(next.kind==="Resubscribe"){next.permit.release();throw new IdleObservationError("unexpected second resubscription; target remains held");}
    return Object.freeze({kind:"Ready",permit:next.permit});
  }
  /** Ordinary resident dispatch, bound to this exact native admission and the
   * first stop origin. Queue/stop metadata is local and never merged into RPC params. */
  request(method:string,params:unknown,waitMs:number,expectedGeneration:bigint|null=null,signal?:AbortSignal):Promise<unknown>{
    return this.#requestScoped(method,params,waitMs,expectedGeneration,false,{check:null,queueClaim:null,stopClaim:null,clientPin:null},signal);
  }
  /** Caller must hold its exact target queue lock through an indeterminate repair.
   * A fully flushed scoped tool timeout cannot fence an unrelated target. */
  requestForToolRepair(method:string,params:unknown,waitMs:number,generation:bigint,signal?:AbortSignal):Promise<unknown>{return this.requestForToolRepairChecked(method,params,waitMs,generation,()=>{},signal);}
  requestForToolRepairChecked(method:string,input:unknown,waitMs:number,generation:bigint,check:()=>void,signal?:AbortSignal):Promise<unknown>{
    const params=cloneOwnedSerdeValue(input),thread=serdeField(params,"threadId"),scoped=typeof thread==="string"&&thread!=="";
    const allowed=method==="thread/read"||method==="mcpServerStatus/list"||(method==="mcpServer/tool/call"&&serdeField(params,"server")==="node_repl"&&["js","js_reset"].includes(serdeField(params,"tool") as string));
    if(!scoped||!allowed)throw new AppServerInvalidReplyError("tool repair requires a scoped node_repl request");syncFunction(check);
    return this.#requestScoped(method,params,waitMs,generation,true,{check,queueClaim:null,stopClaim:null,clientPin:null},signal);
  }
  /** Internal native recovery collector only: exact currently-held client capability,
   * not a serialized DTO or permission to inspect arbitrary recovered targets. */
  requestForRecoveryObservation(pinned:ResidentAdmission<PortableResidentClientPort>,request:AppRequest,signal?:AbortSignal):Promise<unknown>{
    const own=cloneAppRequest(request),thread=serdeField(own.params,"threadId");
    if(!["thread/read","thread/turns/list","thread/goal/get"].includes(own.method)||typeof thread!=="string"||thread==="")throw new AppServerInvalidReplyError("recovery observation only supports exact read-only requests");
    if(pinned===null||typeof pinned!=="object"||types.isProxy(pinned)||!Object.isFrozen(pinned))throw new TypeError("Expected frozen recovery admission");
    const field=(key:string):unknown=>{const d=Object.getOwnPropertyDescriptor(pinned,key);if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own recovery admission field");return d.value;};
    const client=field("client"),generation=field("generation"),permit=field("permit") as ResidentAdmission<PortableResidentClientPort>["permit"];
    if(!isOwnedPortableResidentClientPort(client)||typeof generation!=="bigint"||generation<0n||generation>=(1n<<64n))throw new TypeError("Expected native recovery client and generation");
    client.requireOwnedAdmission(permit);
    const check=()=>{client.requireOwnedAdmission(permit);this.#state.withRecoveryCurrent(client,generation,()=>{});};
    return this.#requestScoped(own.method,own.params,own.timeoutMs,generation,false,{check,queueClaim:null,stopClaim:null,clientPin:client},signal);
  }
  execute(request:AppRequest,expectedGeneration:bigint|null=null,signal?:AbortSignal):Promise<unknown>{const own=cloneAppRequest(request);return this.request(own.method,own.params,own.timeoutMs,expectedGeneration,signal);}
  executeQueueTurn(request:AppRequest,generation:bigint,inputClaim:unknown,signal?:AbortSignal):Promise<unknown>{
    request=cloneAppRequest(request);
    const claim=cloneOwnedSerdeValue(inputClaim),params=cloneOwnedSerdeValue(request.params),target=serdeField(params,"threadId"),claimedGeneration=serdeField(claim,"app_server_generation");
    if(request.method!=="turn/start"||typeof target!=="string"||rustTrim(target)===""||serdeField(claim,"target_thread_id")!==target||typeof claimedGeneration!=="bigint"||claimedGeneration<0n||claimedGeneration>=(1n<<64n)||claimedGeneration!==generation)throw new ResidentStateError({kind:"MutationHeld",message:"queue dispatch does not match its original claim"});
    return this.#requestScoped(request.method,params,request.timeoutMs,generation,false,{check:null,queueClaim:claim,stopClaim:null,clientPin:null},signal);
  }
  executeStopControl(request:AppRequest,generation:bigint,inputClaim:unknown,check:()=>void,signal?:AbortSignal):Promise<unknown>{
    request=cloneAppRequest(request);
    const claim=cloneOwnedSerdeValue(inputClaim),params=cloneOwnedSerdeValue(request.params),control=serdeField(claim,"control"),g=serdeField(control,"generation");
    if(this.#maintenance?.fence==null||request.method!=="turn/interrupt"||!serdeValueEqual(serdeField(control,"target")??null,serdeField(params,"threadId")??null)||!serdeValueEqual(serdeField(control,"turn")??null,serdeField(params,"turnId")??null)||typeof g!=="bigint"||g<0n||g>=(1n<<64n)||g!==generation||serdeField(control,"resident")!==this.instanceId)throw new ResidentStateError({kind:"MutationHeld",message:"stop dispatch does not match original durable authority"});
    syncFunction(check);return this.#requestScoped(request.method,params,request.timeoutMs,generation,false,{check,queueClaim:null,stopClaim:claim,clientPin:null},signal);
  }
  respond(id:RequestId,occurrence:ServerRequestOccurrence,result:unknown,generation:bigint,signal?:AbortSignal):Promise<void>{
    const payload=responseValue(id,result);return this.#respond(payload.id,occurrence,payload,false,generation,signal);
  }
  respondError(id:RequestId,occurrence:ServerRequestOccurrence,error:RpcErrorPayload,generation:bigint,signal?:AbortSignal):Promise<void>{
    const payload=errorValue(id,error);return this.#respond(payload.id,occurrence,payload,true,generation,signal);
  }
  async #respond(id:RequestId,occurrence:ServerRequestOccurrence,input:unknown,isError:boolean,generation:bigint,signal:AbortSignal|undefined):Promise<void>{
    signal?.throwIfAborted();const options=this.#maintenance;if(options===null)throw new ResidentStateError({kind:"MutationHeld",message:"resident response adapter is not installed"});
    const payload=cloneOwnedSerdeValue(input),ownedOccurrence=ServerRequestOccurrence.fromBytes(ServerRequestOccurrence.prototype.asBytes.call(occurrence));
    const admission=this.#state.admitResponse(generation);let target:TargetMutationPermit|null=null,written:WrittenRequestGuard|undefined;
    try{
      const original=admission.client.serverResponseCandidate(id,ownedOccurrence);
      const authority=options.fence?.responseAuthority?.(Object.freeze({ownerId:this.instanceId,generation:admission.generation,request:original}))??null;
      const prepared=await awaitPrepared(this.prepareTargetMutation("server/response",original.params,admission.generation),signal);
      if(prepared.kind!=="Ready")throw new IdleObservationError("unexpected response admission");target=prepared.permit;signal?.throwIfAborted();
      const attempt=new ResponseAttempt(this.instanceId,admission.generation,original,authority,payload,options.fence,()=>this.checkActualTargetMutation(target,admission.generation,"server/response",original.params),options.renderError);
      written=new WrittenRequestGuard(this.#state,admission.generation);const guard=written;let result:ResponseResult;
      try{
        const hooks={preflight:()=>attempt.begin(),writeStarted:()=>{attempt.writeStarted();guard.confirmWriteStarted();}};
        if(isError)await admission.client.respondErrorAdmitted(admission.permit,id,ownedOccurrence,serdeField(payload,"error") as RpcErrorPayload,hooks,signal);
        else await admission.client.respondAdmitted(admission.permit,id,ownedOccurrence,serdeField(payload,"result"),hooks,signal);
        guard.finish("Success");result={ok:true};
      }catch(error){if(signal?.aborted&&error===signal.reason)throw error;const failure=ownedRequestFailure(error);if(failure!==null)guard.finish(failure.kind==="Remote"?"OtherError":failure.kind);result={ok:false,error};}
      const finished=attempt.finish(result);if(!finished.ok)throw finished.error;
    }finally{try{written?.dispose();}finally{try{target?.release();}finally{admission.release();}}}
  }
  #requestScoped(method:string,input:unknown,waitMs:number,expectedGeneration:bigint|null,isolate:boolean,context:DispatchContext,signal?:AbortSignal):Promise<unknown>{
    signal?.throwIfAborted();
    const params=cloneOwnedSerdeValue(input),options=this.#maintenance;
    if(options===null)return Promise.reject(new ResidentStateError({kind:"MutationHeld",message:"resident dispatch adapter is not installed"}));
    if(typeof method!=="string"||/[\uD800-\uDFFF]/u.test(method)||!Number.isSafeInteger(waitMs)||waitMs<0||waitMs>2147483647)throw new TypeError("Expected resident request fields");
    if(hasStopOriginScope())return this.#requestInner(method,params,waitMs,expectedGeneration,isolate,context,signal);
    const origin=options.fence?.requestOrigin(method,params)??null;
    return withStopOrigin(origin,()=>this.#requestInner(method,params,waitMs,expectedGeneration,isolate,context,signal));
  }
  async #requestInner(method:string,params:unknown,waitMs:number,expectedGeneration:bigint|null,isolate:boolean,context:DispatchContext,signal:AbortSignal|undefined):Promise<unknown>{
    signal?.throwIfAborted();const options=this.#maintenance!,check=context.check??(()=>{});invokeSynchronousVoid(check,{},[]);
    const admission=this.#state.admitRequest(expectedGeneration);let target:TargetMutationPermit|null=null,written:WrittenRequestGuard|undefined;
    try{
      if(context.clientPin!==null&&context.clientPin.identity!==admission.client.identity)throw new ResidentStateError({kind:"MutationHeld",message:"recovery observation admission changed client identity"});
      const prepared=await awaitPrepared(this.prepareTargetMutation(method,params,admission.generation,currentStopOrigin(),check),signal);
      if(prepared.kind==="Completed")return prepared.value;target=prepared.permit;signal?.throwIfAborted();
      options.fence?.checkRequest(admission.generation,method,params);
      written=new WrittenRequestGuard(this.#state,admission.generation);const guard=written,flushed=guard.isolateAfterFlush(),observational=isObservationalRequest(method);
      const attempt=new DispatchAttempt({ownerId:this.instanceId,generation:admission.generation,method,params,repair:isolate,queueClaim:context.queueClaim,stopClaim:context.stopClaim,origin:currentStopOrigin()},options.fence,options.renderError);
      let result:DispatchResult;
      try{
        const value=await admission.client.requestAdmitted(admission.permit,method,params,waitMs,{
          preflight:wire=>{invokeSynchronousVoid(check,{},[]);this.checkActualTargetMutation(target,admission.generation,method,params);attempt.begin(wire);invokeSynchronousVoid(check,{},[]);},
          writeStarted:()=>{attempt.writeStarted();guard.confirmWriteStarted();},
          writeComplete:()=>{if(isolate||observational||attempt.isolatesTarget())flushed.confirmFlushed();},
        },signal);
        guard.finish("Success");result={ok:true,value};
      }catch(error){
        // Future-drop equivalent: no completion write on caller cancellation.
        if(signal?.aborted&&error===signal.reason)throw error;
        const failure=ownedRequestFailure(error);
        if(failure?.kind==="Timeout"&&!observational&&attempt.wasStarted()&&!guard.isIsolated())this.#state.markTimeout(admission.generation);
        if(failure!==null)guard.finish(failure.kind==="Remote"?"OtherError":failure.kind);
        result={ok:false,error};
      }
      const outcome=attempt.finish(result);
      if(!outcome.ok){if(isOwnedMutationOutcomeUnknown(outcome.error)&&attempt.wasStarted()&&!guard.isIsolated())this.#state.markTimeout(admission.generation);throw outcome.error;}return outcome.value;
    }finally{try{written?.dispose();}finally{try{target?.release();}finally{admission.release();}}}
  }
  checkActualTargetMutation(permit:TargetMutationPermit|null,generation:bigint,method:string,input:unknown):void{
    if(typeof generation!=="bigint"||generation<0n||generation>=(1n<<64n)||typeof method!=="string"||/[\uD800-\uDFFF]/u.test(method))throw new TypeError("Expected actual target mutation identity");
    const params=cloneOwnedSerdeValue(input),actual=this.generation();
    if(actual!==generation)throw new ResidentStateError({kind:"GenerationMismatch",expected:generation,actual});
    permit?.preflight();this.#maintenance?.fence?.checkRequest(generation,method,params);
  }

  observationWindow(generation:bigint,after:bigint,upper:bigint|null=null){
    const admission=this.#state.admitResponse(generation);try{
      const page=admission.client.observationWindow(after,upper);return Object.freeze({...page,ownerId:this.instanceId,generation});
    }finally{admission.release();}
  }
  confirmIdleObservation(generation:bigint,notification:AppNotification):void{
    const own=cloneOwnedSerdeValue(notification) as unknown as AppNotification;
    let admission;try{admission=this.#state.admitResponse(generation);}catch{return;}
    try{admission.client.confirmIdleObservation(own);}finally{admission.release();}
  }
  /** Gap-report failures do not authorize release and are reported through the
   * caller's central handler; source treats these as nonfatal observation failures. */
  markIdleObservationGap(report:(error:unknown)=>void):void{
    syncFunction(report);this.#targetGate.markGap();const journal=this.#targetGate.journal();
    if(journal?.tracksObservations())this.#targetGate.holdUnattributedGap();
    if(journal?.tracksObservations())try{journal.recordObservationGap(this.instanceId,this.generation());}catch(error){invokeSynchronousVoid(report,{},[error]);}
  }
  markSourceObservationGap(generation:bigint,report:(error:unknown)=>void):void{
    syncFunction(report);this.#targetGate.markGap();try{
      const journal=this.#targetGate.journal();if(journal===null)throw new IdleObservationError("observation journal absent");
      const upper=this.observationWindow(generation,0n,0n).sourceUpper;journal.observeSourceUpper(this.instanceId,generation,upper);
    }catch(error){this.markIdleObservationGap(report);invokeSynchronousVoid(report,{},[error]);}
  }
  reconcileIdleObservationPrefix(generation:bigint,through:bigint):boolean{
    const epoch=this.#targetGate.gapEpoch(),journal=this.#targetGate.journal();if(journal===null)return false;
    if(!journal.observationScopeVerified(this.instanceId,generation,through))return false;
    const admission=this.#state.admitResponse(generation);try{return admission.client.certifyObservationPrefix(through)&&this.#targetGate.clearGap(epoch);}finally{admission.release();}
  }

  lifecycleSnapshot(){const state=this.#state.snapshot(),child=state.client===null?null:this.#session(state.client).lifecycleSnapshot();return Object.freeze({generation:state.generation,healthy:state.accepting&&child?.healthy===true&&!state.quarantined,quarantined:state.quarantined,restartPending:state.restartPending,processId:child?.processId??null});}
  subscribeNotifications(){return this.#notifications.subscribe();}
  subscribeServerRequests(){return this.#requests.subscribe();}
  subscribeLifecycleChanges(){return this.#state.subscribeLifecycleChanges();}
  /** Internal owner capability; does not supply durable mutation/queue/stop authorization. */
  admitRequest(expected:bigint|null=null){return this.#state.admitRequest(expected);}
  admitResponse(expected:bigint){return this.#state.admitResponse(expected);}
  /** Caller owns and joins this supervisor; shutdown waits for any active restart. */
  runRestartSupervisor(shutdown:AbortSignal,report:RestartFailureReporter):Promise<void>{return runRestartSupervisor(this.#state.subscribeLifecycleChanges(),shutdown,generation=>this.restartGenerationIfQuiescent(generation),report);}
  requestRestart():void{this.#state.requestRestart();}
  markTimeout(generation:bigint):void{this.#state.markTimeout(generation);}
  async #stopForwarders():Promise<void>{this.#generation.replace(0n);const forwarders=this.#forwarders;this.#forwarders=null;if(forwarders)await forwarders.join();}
  #journalExit(session:PortableAppServerSession,generation:bigint):void{if(session.processExitConfirmed){this.#persistence.oldChildExited(this.instanceId,generation);this.#targetGate.journal()?.oldChildExited(this.instanceId,generation);}}
  async #cleanupDebt(debt:ReplacementCleanup<PortableResidentClientPort>):Promise<void>{await this.#session(debt.client).dispose();this.#state.finishReplacementCleanup(debt);this.#sessions.delete(debt.client);}
  restartIfQuiescent(signal?:AbortSignal,observe:(session:PortableAppServerSession)=>void=()=>{}):Promise<boolean>{return this.#restart(null,null,signal,observe).then(value=>value==="Restarted");}
  forceRestartIfQuiescent(signal?:AbortSignal):Promise<boolean>{const generation=this.generation();return this.#restart(generation,generation,signal,()=>{}).then(value=>value==="Restarted");}
  restartGenerationIfQuiescent(expected:bigint,signal?:AbortSignal):Promise<boolean>{return this.#restart(expected,null,signal,()=>{}).then(value=>value!=="Deferred");}
  async #restart(expected:bigint|null,forced:bigint|null,signal:AbortSignal|undefined,observe:(session:PortableAppServerSession)=>void):Promise<"Restarted"|"Settled"|"Deferred">{
    syncFunction(observe);return this.#lock.run("restart",async()=>{
      signal?.throwIfAborted();if(forced!==null&&this.generation()!==forced)return "Restarted";if(forced!==null)this.#state.requestRestart();if(expected!==null&&!this.#state.restartPendingFor(expected))return "Settled";
      const debt=this.#state.replacementCleanup();if(debt!==null)await this.#cleanupDebt(debt);
      if(!this.#state.fenceDeadGenerationBeforeRestart(work=>this.#persistence.persistDeadWork(this.instanceId,work)))return "Deferred";
      const candidate=this.#state.restartCandidate(expected);if(candidate.kind!=="Sealed")return candidate.kind==="NotPending"?"Settled":"Deferred";
      const next=this.#state.replacementGeneration(),oldPort=candidate.client,old=this.#session(oldPort),oldGeneration=this.generation();
      await this.#stopForwarders();await old.dispose();this.#journalExit(old,oldGeneration);signal?.throwIfAborted();
      let recorded:ReplacementCleanup<PortableResidentClientPort>|undefined,staged:ResidentForwarders|undefined,replacement:PortableAppServerSession;
      try{
        const result=await PortableAppServerSession.startObserved(this.#config,session=>{
          const port=session.residentClient();this.#state.recordReplacement(port,next);recorded={client:port,generation:next};this.#sessions.set(port,session);invokeSynchronousVoid(observe,this,[session]);staged=this.#prepare(session,next);return {value:staged,dispose(){}};
        },this.#render,signal);replacement=result.session;
      }catch(primary){
        const errors=[primary];if(staged)try{await staged.join();}catch(error){errors.push(error);}
        if(recorded){const session=this.#session(recorded.client);if(session.resourcesClosed)try{this.#state.finishReplacementCleanup(recorded);this.#sessions.delete(recorded.client);}catch(error){errors.push(error);}}
        throwErrors(errors,"Resident replacement startup cleanup failed");throw primary;
      }
      try{
        signal?.throwIfAborted();this.#state.installReplacementWith(replacement.residentClient(),next,()=>{
          if(this.#forwarders!==null)throw new ResidentStateError({kind:"ReplacementState",message:"resident forwarder slot was not empty before replacement"});
          this.#forwarders=staged!;this.#generation.replace(next);staged!.activate();
        });this.#sessions.delete(oldPort);return "Restarted";
      }catch(primary){
        const errors=[primary];if(this.#forwarders===staged)this.#forwarders=null;this.#generation.replace(0n);if(staged)try{await staged.join();}catch(error){errors.push(error);}
        try{await this.#cleanupDebt(recorded!);}catch(error){errors.push(error);}throwErrors(errors,"Resident replacement installation cleanup failed");throw primary;
      }
    },signal);
  }
  /** Terminal close serializes with replacement. Exact client remains retained until
   * both owned cleanup and its exit journal succeed, permitting an explicit retry. */
  close():Promise<void>{return this.#lock.run("restart",async()=>{
    if(this.#disposed)return;const plan=this.#state.prepareClose(),errors:unknown[]=[];
    try{await this.#stopForwarders();}catch(error){errors.push(error);}
    if(plan.replacement)try{await this.#cleanupDebt(plan.replacement);}catch(error){errors.push(error);}
    if(plan.current){const session=this.#session(plan.current),generation=this.generation();let cleaned=false,journaled=false;
      try{await session.dispose();cleaned=true;}catch(error){errors.push(error);}
      await Promise.allSettled([...this.#managedIdle]);
      try{this.#journalExit(session,generation);journaled=true;}catch(error){errors.push(error);}
      if(cleaned&&journaled)try{this.#state.finishCurrentClose(plan.current);this.#sessions.delete(plan.current);}catch(error){errors.push(error);}
    }
    throwErrors(errors,"Resident terminal close failed");
  });}
  async dispose():Promise<void>{await this.close();if(!this.#disposed){this.#state.closeLifecycleChanges();this.#disposed=true;this.#notifications.close();this.#requests.close();this.#generation.close();}}
}
