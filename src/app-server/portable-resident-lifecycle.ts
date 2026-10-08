import {runRestartSupervisor,type RestartFailureReporter} from "./restart-supervisor.ts";
import {randomUUID} from "node:crypto";
import {types} from "node:util";
import {TargetLocks} from "../core/keyed-locks.ts";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {invokeSynchronousVoid} from "../core/synchronous-void.ts";
import {PortableAppServerSession,PortableSessionCleanupPendingError,type PortableResidentClientPort,type PortableSessionConfig,type SessionDiagnosticRenderer} from "./portable-session.ts";
import {ResidentAdmissionState,ResidentStateError,type ReplacementCleanup} from "./resident-state.ts";
import {ResidentForwarders,type ResidentNotificationEvent,type ResidentServerRequestEvent} from "./resident-forwarders.ts";
import {GenerationWatch} from "./generation-watch.ts";
import {BoundedBroadcast} from "./broadcast.ts";
import type {DeadGenerationWork} from "./dead-generation-work.ts";
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
/** Non-Windows owned lifecycle/replacement coordinator. NOT mutation dispatch authority:
 * admission capabilities are internal and require the later durable dispatch coordinator.
 * Persistence ports are mandatory, explicit and trusted; no no-op default exists.
 * Supervisor is explicit owner-started/joined; no 45s startup envelope or descendant-pipe cleanup. */
export class PortableResidentLifecycle{
  readonly instanceId=randomUUID();readonly #config:PortableSessionConfig;readonly #render:SessionDiagnosticRenderer;readonly #persistence:ResidentPersistence;
  readonly #lock=new TargetLocks();readonly #generation=new GenerationWatch(1n);
  readonly #notifications=new BoundedBroadcast<ResidentNotificationEvent>(1000);readonly #requests=new BoundedBroadcast<ResidentServerRequestEvent>(500);
  readonly #sessions=new Map<PortableResidentClientPort,PortableAppServerSession>();#state!:ResidentAdmissionState<PortableResidentClientPort>;#forwarders:ResidentForwarders|null=null;#disposed=false;
  private constructor(config:PortableSessionConfig,render:SessionDiagnosticRenderer,persistence:ResidentPersistence){syncFunction(render);this.#config=cloneOwnedSerdeValue(config) as PortableSessionConfig;this.#render=render;this.#persistence=pinPersistence(persistence);}
  static async start(config:PortableSessionConfig,render:SessionDiagnosticRenderer,persistence:ResidentPersistence,signal?:AbortSignal):Promise<PortableResidentLifecycle>{
    const owner=new PortableResidentLifecycle(config,render,persistence);let staged:ResidentForwarders|undefined,ready:PortableAppServerSession|undefined;
    try{
      const started=await PortableAppServerSession.startObserved(owner.#config,session=>{owner.#sessions.set(session.residentClient(),session);staged=owner.#prepare(session,1n);return {value:staged,dispose(){}};},render,signal);
      ready=started.session;signal?.throwIfAborted();owner.#state=new ResidentAdmissionState(started.session.residentClient());owner.#forwarders=started.observer.value;owner.#forwarders.activate();return owner;
    }catch(primary){const errors=[primary];if(staged)try{await staged.join();}catch(error){errors.push(error);}if(ready)try{await ready.dispose();}catch(error){errors.push(error);}if(ready&&!ready.resourcesClosed)throw new PortableSessionCleanupPendingError(ready,new AggregateError(errors,"Resident initial startup cleanup failed"));throwErrors(errors,"Resident initial startup cleanup failed");throw primary;}
  }
  #prepare(session:PortableAppServerSession,generation:bigint):ResidentForwarders{return new ResidentForwarders(session,generation,this.#notifications,this.#requests,this.#generation.subscribe(),{waitClosed:signal=>session.waitClosed(signal),onClosed:()=>this.#state.markCurrentClosed(session.residentClient(),generation)});}
  #session(port:PortableResidentClientPort):PortableAppServerSession{const session=this.#sessions.get(port);if(!session)throw new ResidentStateError({kind:"ReplacementState",message:"owned native session is missing"});return session;}
  generation():bigint{return this.#state.generation();}
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
  #journalExit(session:PortableAppServerSession,generation:bigint):void{if(session.processExitConfirmed)this.#persistence.oldChildExited(this.instanceId,generation);}
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
      try{this.#journalExit(session,generation);journaled=true;}catch(error){errors.push(error);}
      if(cleaned&&journaled)try{this.#state.finishCurrentClose(plan.current);this.#sessions.delete(plan.current);}catch(error){errors.push(error);}
    }
    throwErrors(errors,"Resident terminal close failed");
  });}
  async dispose():Promise<void>{await this.close();if(!this.#disposed){this.#state.closeLifecycleChanges();this.#disposed=true;this.#notifications.close();this.#requests.close();this.#generation.close();}}
}
