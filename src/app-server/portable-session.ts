import {types} from "node:util";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {OwnedPortableAppServerProcess,type PortableProcessConfig} from "./portable-process.ts";
import {NodeAppServerInput} from "./node-streams.ts";
import {ClientLifecycle,type ClientAdmissionPermit} from "./client-lifecycle.ts";
import type {ResidentDeadClientPort} from "./resident-state.ts";
import {ClientRuntimeState} from "./runtime-state.ts";
import {PendingResponses} from "./pending-responses.ts";
import {ClientCloseCoordinator} from "./close-coordinator.ts";
import {ClientProcessCloser} from "./process-close.ts";
import {AppServerWriter} from "./writer.ts";
import {AppServerRequestClient,type RequestHooks} from "./request-client.ts";
import {AppServerResponseClient,type ResponseHooks} from "./response-client.ts";
import {BoundedBroadcast,type BroadcastReceiver} from "./broadcast.ts";
import {BoundedDiagnostics} from "./diagnostics.ts";
import {TransportLineDispatcher} from "./transport-dispatch.ts";
import {FatalUtf8LineReader} from "./line-reader.ts";
import {drainStdout,drainStderr} from "./transport-drain.ts";
import {initializeObserved,type StartupClientInfo,type StartupObserver} from "./startup-handshake.ts";
import type {AppNotification} from "./notification-state.ts";
import type {PendingServerRequest} from "./server-request-state.ts";
import type {RequestId,ServerRequestOccurrence,RpcErrorPayload} from "../protocol/rpc.ts";
export interface PortableSessionConfig{readonly process:PortableProcessConfig;readonly clientInfo:StartupClientInfo}
/** Internal resident-owner capability, bound once to this session's private gate.
 * Receiving this port grants admission/sealing access to this owned connection. */
export interface PortableResidentClientPort extends ResidentDeadClientPort{
  admissionSnapshot():ReturnType<ClientLifecycle["snapshot"]>;
  idleMaintenanceSnapshot(thread:string,turn:string):ReturnType<ClientRuntimeState["idleMaintenanceSnapshot"]>;
  requireObservationLedger():void;
  confirmIdleObservation(notification:AppNotification):boolean;
  observationWindow(after:bigint,upper:bigint|null):ReturnType<ClientRuntimeState["observationWindow"]>;
  certifyObservationPrefix(through:bigint):boolean;
  requestAdmitted(permit:ClientAdmissionPermit,method:string,params:unknown,waitMs:number,hooks?:RequestHooks,signal?:AbortSignal):Promise<unknown>;
  notifyAdmitted(permit:ClientAdmissionPermit,method:string,params:unknown,signal?:AbortSignal):Promise<void>;
  respondAdmitted(permit:ClientAdmissionPermit,id:RequestId,occurrence:ServerRequestOccurrence,result:unknown,hooks?:ResponseHooks,signal?:AbortSignal):Promise<void>;
  respondErrorAdmitted(permit:ClientAdmissionPermit,id:RequestId,occurrence:ServerRequestOccurrence,error:RpcErrorPayload,hooks?:ResponseHooks,signal?:AbortSignal):Promise<void>;
  respondCurrentAdmitted(permit:ClientAdmissionPermit,id:RequestId,occurrence:ServerRequestOccurrence,result:unknown,hooks?:ResponseHooks,signal?:AbortSignal):Promise<void>;
}
export type SessionDiagnosticRenderer=(stage:"json"|"rpc"|"stdout"|"stderr",error:unknown)=>string;
export class PortableSessionCleanupPendingError extends Error{
  readonly session:PortableAppServerSession;
  constructor(session:PortableAppServerSession,cause:unknown){super("portable session startup failed with unconfirmed owned cleanup",{cause});this.name="PortableSessionCleanupPendingError";this.session=session;}
}
function synchronous(value:unknown):void{if(typeof value!=="function"||types.isProxy(value)||types.isAsyncFunction(value)||types.isGeneratorFunction(value))throw new TypeError("Expected synchronous observer/diagnostic function");}
/** One non-Windows direct-child client owner. Raw gates, slots and state mutators are
 * private, so request/response/drain/close components cannot be cross-wired by callers.
 * Not a resident-generation manager, Windows owner or Discord execution grant.
 * Descendant-inherited pipes and the outer 45s startup envelope remain unsupported:
 * dispose joins drains after child exit and can wait on a still-open inherited pipe. */
export class PortableAppServerSession{
  readonly #resident:PortableResidentClientPort;
  readonly #native:OwnedPortableAppServerProcess;readonly #gate=new ClientLifecycle();readonly #state:ClientRuntimeState;readonly #pending:PendingResponses;
  readonly #logical:ClientCloseCoordinator;readonly #writer:AppServerWriter;readonly #requests:AppServerRequestClient;readonly #responses:AppServerResponseClient;readonly #closer:ClientProcessCloser;
  readonly #notifications=new BoundedBroadcast<AppNotification>(1000);readonly #serverRequests=new BoundedBroadcast<PendingServerRequest>(500);readonly #diagnostics=new BoundedDiagnostics();readonly #tasks:Promise<void>[];#disposal:Promise<void>|undefined;
  private constructor(native:OwnedPortableAppServerProcess,render:SessionDiagnosticRenderer){
    this.#native=native;this.#state=new ClientRuntimeState(native.processId);this.#pending=new PendingResponses(this.#gate);this.#logical=new ClientCloseCoordinator(this.#gate,this.#state,this.#pending);this.#writer=new AppServerWriter(native.input,this.#logical);this.#requests=new AppServerRequestClient(this.#gate,this.#pending,this.#writer);
    const publishRequest=(request:PendingServerRequest)=>{this.#serverRequests.send(request);};this.#responses=new AppServerResponseClient(this.#gate,this.#state,this.#writer,publishRequest);
    this.#resident=Object.freeze<PortableResidentClientPort>({
      identity:Object.freeze({}),
      admitOperation:()=>this.#gate.admit(),
      sealAdmissions:()=>{this.#gate.sealForCleanup("resident admissions sealed");},
      sealIfQuiescent:()=>this.#gate.sealIfQuiescent(()=>!this.#state.hasActiveTurns&&!this.#state.hasUnsettledServerRequests),
      withOpen:<T>(operation:()=>T):T=>this.#gate.withOpen(operation),
      hasOwnedChildExited:()=>this.#native.exitConfirmed,
      isTransportClosed:()=>this.#state.snapshot().closedReason!==null,
      sealIfNoAdmissions:()=>this.#gate.sealIfQuiescent(()=>true),
      deadGenerationWork:generation=>this.#state.deadGenerationWork(generation),
      settleDeadGenerationExact:expected=>{
        const gate=this.#gate.snapshot();if(!this.#native.exitConfirmed||!gate.sealed||gate.inFlight!==0n||this.#state.snapshot().closedReason===null)return false;
        return this.#state.settleDeadGenerationAfterExactMatch(expected);
      },
      admissionSnapshot:()=>this.#gate.snapshot(),
      idleMaintenanceSnapshot:(thread,turn)=>this.#gate.withOpen(()=>this.#state.idleMaintenanceSnapshot(thread,turn)),
      requireObservationLedger:()=>this.#gate.withOpen(()=>this.#state.requireObservationLedger()),
      confirmIdleObservation:notification=>this.#gate.withOpen(()=>this.#state.confirmIdleObservation(notification)),
      observationWindow:(after,upper)=>this.#gate.withOpen(()=>this.#state.observationWindow(after,upper)),
      certifyObservationPrefix:through=>this.#gate.withOpen(()=>this.#state.certifyObservationPrefix(through)),
      requestAdmitted:(permit,method,params,waitMs,hooks,signal)=>this.#requests.requestAdmitted(permit,method,params,waitMs,hooks,signal),
      notifyAdmitted:(permit,method,params,signal)=>this.#requests.notifyAdmitted(permit,method,params,signal),
      respondAdmitted:(permit,id,occurrence,result,hooks,signal)=>this.#responses.respondAdmitted(permit,id,occurrence,result,hooks,signal),
      respondErrorAdmitted:(permit,id,occurrence,error,hooks,signal)=>this.#responses.respondErrorAdmitted(permit,id,occurrence,error,hooks,signal),
      respondCurrentAdmitted:(permit,id,occurrence,result,hooks,signal)=>this.#responses.respondCurrentAdmitted(permit,id,occurrence,result,hooks,signal),
    });
    this.#closer=new ClientProcessCloser(this.#logical,this.#state,this.#writer,native,async input=>{if(!(input instanceof NodeAppServerInput))throw new TypeError("Expected this session's native input");try{await input.shutdown();}finally{await input.destroyAndJoin();}});
    const dispatcher=new TransportLineDispatcher(this.#gate,this.#state,this.#pending,this.#diagnostics,{enqueueServerRequest:publishRequest,enqueueNotification:notification=>{this.#notifications.send(notification);},renderParseError:render});
    this.#tasks=[this.#supervise(drainStdout(new FatalUtf8LineReader(native.stdout),dispatcher,this.#logical,this.#diagnostics,render),"stdout"),this.#supervise(drainStderr(new FatalUtf8LineReader(native.stderr),this.#diagnostics,render),"stderr")];
  }
  #supervise(task:Promise<void>,stream:"stdout"|"stderr"):Promise<void>{
    const monitored=task.catch(async primary=>{try{await this.#logical.markClosed(`app-server ${stream} handler failed`);}catch(cleanup){throw new AggregateError([primary,cleanup],"App-server drain supervision failed");}throw primary;});void monitored.catch(()=>undefined);return monitored;
  }
  static async startObserved<T>(config:PortableSessionConfig,observe:(session:PortableAppServerSession)=>StartupObserver<T>,render:SessionDiagnosticRenderer,signal?:AbortSignal):Promise<Readonly<{session:PortableAppServerSession;observer:StartupObserver<T>}>>{
    synchronous(observe);synchronous(render);signal?.throwIfAborted();const copied=cloneOwnedSerdeValue(config) as PortableSessionConfig;
    const native=await OwnedPortableAppServerProcess.spawn(copied.process);let session:PortableAppServerSession;
    try{session=new PortableAppServerSession(native,render);}catch(primary){try{await native.forceDispose();}catch(cleanup){throw new AggregateError([primary,cleanup],"App-server construction cleanup failed");}throw primary;}
    try{
      const observer=await initializeObserved({gate:session.#gate,state:session.#state,client:session.#requests,cleanupOwned:()=>session.dispose()},copied.clientInfo,()=>observe(session),signal);
      return Object.freeze({session,observer});
    }catch(error){if(!session.resourcesClosed)throw new PortableSessionCleanupPendingError(session,error);throw error;}
  }
  /** Stable internal capability for the owning resident, never a serialized DTO. */
  residentClient():PortableResidentClientPort{return this.#resident;}
  get resourcesClosed():boolean{return this.#native.exitConfirmed&&this.#native.stdioClosed;}
  get processExitConfirmed():boolean{return this.#state.processExitConfirmed;}
  lifecycleSnapshot(){return this.#state.snapshot();}
  diagnosticSnapshot(){return this.#diagnostics.snapshot();}
  activeTurnId(thread:string):string|null{return this.#state.activeTurnId(thread);}
  pendingServerRequests(thread:string|null=null):PendingServerRequest[]{return this.#state.pendingServerRequests(thread);}
  observedThreadSettings(thread:string){return this.#state.observedThreadSettings(thread);}
  subscribeNotifications():BroadcastReceiver<AppNotification>{return this.#notifications.subscribe();}
  subscribeServerRequests():BroadcastReceiver<PendingServerRequest>{return this.#serverRequests.subscribe();}
  request(method:string,params:unknown,waitMs:number,hooks?:RequestHooks,signal?:AbortSignal):Promise<unknown>{return this.#requests.request(method,params,waitMs,hooks,signal);}
  notify(method:string,params:unknown,signal?:AbortSignal):Promise<void>{return this.#requests.notify(method,params,signal);}
  respond(id:RequestId,occurrence:ServerRequestOccurrence,result:unknown,hooks?:ResponseHooks,signal?:AbortSignal):Promise<void>{return this.#responses.respond(id,occurrence,result,hooks,signal);}
  respondError(id:RequestId,occurrence:ServerRequestOccurrence,error:RpcErrorPayload,hooks?:ResponseHooks,signal?:AbortSignal):Promise<void>{return this.#responses.respondError(id,occurrence,error,hooks,signal);}
  respondCurrent(id:RequestId,occurrence:ServerRequestOccurrence,result:unknown,hooks?:ResponseHooks,signal?:AbortSignal):Promise<void>{return this.#responses.respondCurrent(id,occurrence,result,hooks,signal);}
  waitClosed(signal?:AbortSignal):Promise<string>{return this.#gate.waitClosed(signal);}
  close():Promise<void>{return this.#closer.close();}
  /** Explicit owner disposal joins direct-child drains, then closes producers. A failed
   * cleanup retains its error for the caller; a later explicit dispose may retry the
   * same owner even after native exit. Taken stdin/child slots must not be replayed. */
  dispose():Promise<void>{
    if(this.#disposal!==undefined)return this.#disposal;const task=this.#disposeOwned();this.#disposal=task;void task.catch(()=>{if(this.#disposal===task)this.#disposal=undefined;});return task;
  }
  async #disposeOwned():Promise<void>{
    const errors:unknown[]=[];
    try{
      try{await this.#closer.close();}catch(error){errors.push(error);}
      if(!this.#native.exitConfirmed){try{await this.#native.forceDispose();}catch(error){errors.push(error);}}
      if(this.#native.exitConfirmed){
        this.#state.confirmOwnedProcessExit();for(const result of await Promise.allSettled(this.#tasks))if(result.status==="rejected")errors.push(result.reason);
        if(!this.#native.stdioClosed){try{await this.#native.forceDispose();}catch(error){errors.push(error);}}
      }
      if(!this.resourcesClosed&&errors.length===0)errors.push(new Error("Owned native resources remain unconfirmed"));
      if(errors.length!==0)throw new AggregateError(errors,"Owned app-server session cleanup failed");
    }finally{this.#notifications.close();this.#serverRequests.close();}
  }
}
