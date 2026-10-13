import {recoverStoppedExecution} from './stop-recovery.ts';
import type {QueueStartCoordinator} from '../queue-runner/start-coordinator.ts';
import {NativeStopPendingReader} from './stop-pending-native.ts';
import {NativeBridgeStateOwner} from '../bridge-state-native.ts';
import {snapshotSettingsBinding,validateSelectedSettingsSnapshot,captureSelectedSettingsCheck} from "./settings-snapshot.ts";
import {types} from "node:util";
import type {PortableResidentLifecycle} from "../../app-server/portable-resident-lifecycle.ts";
import {interruptTurn} from "../../app-server/requests.ts";
import type {BridgeState} from "../bridge-state.ts";
import type {TargetLocks} from "../../core/keyed-locks.ts";
import {invokeSynchronousVoid} from "../../core/synchronous-void.ts";
import {StateAccessFacade,type IStateAccessFacade} from "../../store/state-access-facade.ts";
import {ControlTurnVerifier} from "./control-turn.ts";
import {MissingActionAppServerError,storeActionCheck} from "./errors.ts";
import {createRuntimeFenceErrors} from "../fence-errors.ts";
import {SkippedTicks} from "../skipped-ticks.ts";
import type {TickSource} from "../delayed-ticks.ts";
type Server=Pick<PortableResidentLifecycle,"instanceId"|"generation"|"lifecycleSnapshot"|"activeTurnId"|"executeStopControl">;
type Store=Pick<IStateAccessFacade,"pendingStopControlsAfter"|"claimStopControl"|"recordStopControlError"|"hasObservedCompletion"|"mirroredThreadId">;
export interface StopWorkerFailure{readonly stage:"dispatch"|"recovery"|"cycle"|"deadline";readonly operationId?:string;readonly error:unknown}
function sync(fn:unknown):void{if(typeof fn!=="function"||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError("Expected synchronous stop diagnostic callback");}
/** One serial keyset owner. Busy targets are skipped after advancing the cursor;
 * no detached task per Stop and no retry of claimed/unknown original authority. */
export class StopControlWorker{
 readonly #nativeBridge:NativeBridgeStateOwner|undefined;readonly #pendingReader:NativeStopPendingReader|undefined;
  readonly #path:string;readonly #server:Server|null;readonly #bridge:Pick<BridgeState,"selectedThreadId">;readonly #locks:TargetLocks;readonly #state:Store;readonly #verify:ControlTurnVerifier;readonly #render:(e:unknown)=>string;readonly #report:(e:StopWorkerFailure)=>void;readonly #mapped:ReturnType<typeof createRuntimeFenceErrors>;
  readonly #recovery: {readonly queue:QueueStartCoordinator;readonly server:PortableResidentLifecycle}|undefined;
  #recoveryCursor=0n;
  #cursor=0n;#processing=false;#running=false;
  constructor(path:string,server:Server|null,bridge:Pick<BridgeState,"selectedThreadId">,locks:TargetLocks,render:(e:unknown)=>string,report:(e:StopWorkerFailure)=>void,state:Store=StateAccessFacade,nativeBridge?:NativeBridgeStateOwner,pendingReader?:NativeStopPendingReader,recovery?:{readonly queue:QueueStartCoordinator;readonly server:PortableResidentLifecycle}){if(recovery!==undefined&&(recovery.queue.locks!==locks||recovery.queue.dbPath!==path||recovery.server!==server))throw new TypeError("Stop recovery runtime ownership differs");this.#recovery=recovery===undefined?undefined:Object.freeze({queue:recovery.queue,server:recovery.server});if(pendingReader!==undefined)NativeStopPendingReader.prototype.assertPath.call(pendingReader,path);this.#pendingReader=pendingReader;this.#nativeBridge=nativeBridge;sync(render);sync(report);this.#path=path;this.#server=server;this.#bridge=bridge;this.#locks=locks;this.#state=state;this.#render=render;this.#report=report;this.#verify=new ControlTurnVerifier(path,server,bridge,locks,state,nativeBridge);this.#mapped=createRuntimeFenceErrors(render);}
  get cursor():bigint{return this.#cursor;}
  get recoveryCursor():bigint{return this.#recoveryCursor;}
  async processRecoveries(signal?:AbortSignal):Promise<number>{
    if(this.#processing)throw new TypeError('A stop cycle is already active');this.#processing=true;
    try{
      signal?.throwIfAborted();const owner=this.#recovery;if(owner===undefined)throw new TypeError('Stop recovery runtime is not bound');
      const rows=this.#pendingReader===undefined?StateAccessFacade.recoveryStopControlsAfter(this.#path,this.#recoveryCursor):await NativeStopPendingReader.prototype.recovery.call(this.#pendingReader,this.#recoveryCursor,signal);
      signal?.throwIfAborted();if(rows.length===0){this.#recoveryCursor=0n;return 0;}let recovered=0;
      for(const [sequence,original] of rows){
        signal?.throwIfAborted();this.#recoveryCursor=sequence;const lease=this.#locks.tryAcquire(original.target);if(lease===undefined)continue;
        try{await recoverStoppedExecution(owner.queue,owner.server,lease,original,this.#bridge,this.#nativeBridge,signal);recovered++;}
        catch(error){if(signal?.aborted)throw signal.reason;this.#notify({stage:'recovery',operationId:original.operation_id,error});}
        finally{lease.release();}
      }
      return recovered;
    }finally{this.#processing=false;}
  }
  #diagnostic(error:unknown):string{const s=this.#render(error);if(types.isPromise(s))void Promise.prototype.then.call(s,undefined,()=>undefined);if(typeof s!=="string"||/[\uD800-\uDFFF]/u.test(s))throw new TypeError("Expected public-safe stop diagnostic");return s;}
  #notify(event:StopWorkerFailure):void{invokeSynchronousVoid(this.#report,{},[Object.freeze(event)]);}
  async process(signal?:AbortSignal):Promise<number>{
    if(this.#processing)throw new TypeError("A stop cycle is already active");this.#processing=true;
    try{
      signal?.throwIfAborted();const server=this.#server;if(server===null)throw new MissingActionAppServerError();const pending=this.#pendingReader===undefined?this.#state.pendingStopControlsAfter(this.#path,this.#cursor):await NativeStopPendingReader.prototype.pending.call(this.#pendingReader,this.#cursor,signal);signal?.throwIfAborted();if(pending.length===0){this.#cursor=0n;return 0;}let dispatched=0;
      for(const [sequence,original] of pending){
        signal?.throwIfAborted();this.#cursor=sequence;if(original.resident!==server.instanceId||original.generation<0n||original.generation!==server.generation())continue;
        const lease=this.#locks.tryAcquire(original.target);if(!lease)continue;
        try{
          const binding=snapshotSettingsBinding(original.binding),check=this.#nativeBridge===undefined?()=>validateSelectedSettingsSnapshot(binding,this.#bridge):await captureSelectedSettingsCheck(binding,this.#nativeBridge,signal);check();try{await this.#verify.owned(original.target,original.turn);}catch(error){if(signal?.aborted)throw signal.reason;continue;}
          signal?.throwIfAborted();const claim=this.#state.claimStopControl(this.#path,original,storeActionCheck(check,this.#render));if(claim===null)continue;signal?.throwIfAborted();let failed=false,error:unknown;
          try{await server.executeStopControl({...interruptTurn(original.target,original.turn),timeoutMs:2000},original.generation,claim,()=>this.#mapped.run("MutationHeld",check),signal);}catch(e){if(signal?.aborted&&e===signal.reason)throw e;failed=true;error=e;}
          dispatched++;if(failed){this.#state.recordStopControlError(this.#path,claim,this.#diagnostic(error));this.#notify({stage:"dispatch",operationId:original.operation_id,error});}
        }finally{lease.release();}
      }
      return dispatched;
    }finally{this.#processing=false;}
  }
  /** Cooperative 2-second cycle cancellation; joins its sole cycle before exit.
   * Synchronous SQLite/FS cannot be preempted in this execution profile. This is
   * not a hard real-time/offloaded deadline or Rust future-Drop equivalence. */
  async run(shutdown:AbortSignal,ticks:()=>TickSource=()=>new SkippedTicks(250),recoveryTicks:()=>TickSource=()=>new SkippedTicks(2000)):Promise<void>{
    if(shutdown.aborted)return;if(this.#running||this.#processing)throw new TypeError("Stop worker already owns a cycle");this.#running=true;let tick:TickSource|undefined;let recoveryTick:TickSource|undefined;let cycle:AbortController|undefined;let wake:()=>void=()=>{};
    const abort=()=>{cycle?.abort(shutdown.reason);wake();};shutdown.addEventListener("abort",abort,{once:true});
    try{
      tick=ticks();recoveryTick=this.#recovery===undefined?undefined:recoveryTicks();
      let dispatchWait=tick.wait().then(()=>false),recoveryWait=recoveryTick?.wait().then(()=>true);
      while(!shutdown.aborted){const stopWait=new Promise<boolean>(resolve=>{wake=()=>resolve(false);});const recovering=await Promise.race([dispatchWait,...(recoveryWait===undefined?[]:[recoveryWait]),stopWait]);if(shutdown.aborted)break;
        cycle=new AbortController();const current=cycle,timeout=new Error("stop control worker cycle deadline; durable authority retained, no replay"),timer=setTimeout(()=>current.abort(timeout),2000);
        try{if(recovering)await this.processRecoveries(current.signal);else await this.process(current.signal);}catch(error){if(shutdown.aborted&&error===shutdown.reason)break;this.#notify({stage:current.signal.aborted&&error===timeout?"deadline":"cycle",error});}
        finally{clearTimeout(timer);cycle=undefined;}
        if(shutdown.aborted)break;
        if(recovering)recoveryWait=recoveryTick!.wait().then(()=>true);else dispatchWait=tick.wait().then(()=>false);
      }
    }finally{shutdown.removeEventListener("abort",abort);try{tick?.close();}finally{try{recoveryTick?.close();}finally{this.#running=false;}}}
  }
}
