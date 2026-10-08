import {types} from "node:util";
import type {PortableResidentLifecycle} from "../../app-server/portable-resident-lifecycle.ts";
import {interruptTurn} from "../../app-server/requests.ts";
import type {BridgeState} from "../bridge-state.ts";
import type {TargetLocks} from "../../core/keyed-locks.ts";
import {invokeSynchronousVoid} from "../../core/synchronous-void.ts";
import {parseSerdeStruct,type StructShape} from "../../core/serde-struct-json.ts";
import {serializeSerdeValue} from "../../core/serde-json.ts";
import {StateAccessFacade,type IStateAccessFacade} from "../../store/state-access-facade.ts";
import {ControlTurnVerifier} from "./control-turn.ts";
import {InvalidActionRequestError,MissingActionAppServerError} from "./errors.ts";
import {createRuntimeFenceErrors} from "../fence-errors.ts";
import {SkippedTicks} from "../skipped-ticks.ts";
import type {TickSource} from "../delayed-ticks.ts";
import {serdeObject,serdeField} from "../../app-server/value.ts";
type Server=Pick<PortableResidentLifecycle,"instanceId"|"generation"|"lifecycleSnapshot"|"activeTurnId"|"executeStopControl">;
type Store=Pick<IStateAccessFacade,"pendingStopControlsAfter"|"claimStopControl"|"recordStopControlError"|"hasObservedCompletion"|"mirroredThreadId">;
export interface StopWorkerFailure{readonly stage:"dispatch"|"cycle"|"deadline";readonly operationId?:string;readonly error:unknown}
const BINDING:StructShape={fields:[["target","string"],["route","value"],["command","value"]]};
function selectedCheck(value:unknown,bridge:Pick<BridgeState,"selectedThreadId">):()=>void{
  let b:Record<string,unknown>;try{b=parseSerdeStruct(serializeSerdeValue(value),BINDING);}catch{throw new InvalidActionRequestError("invalid stored stop settings binding");}
  let route=b.route;if(serdeObject(route)&&Object.keys(route).length===1){const key=Object.keys(route)[0]!;if(serdeField(route,key)===null)route=key;}
  if(route!=="Explicit"&&route!=="Mapped"&&route!=="Selected")throw new InvalidActionRequestError("invalid stored stop settings route");
  return ()=>{if(route==="Selected"&&bridge.selectedThreadId()!==b.target)throw new InvalidActionRequestError("selected target changed after admission; no replacement will be used");};
}
function sync(fn:unknown):void{if(typeof fn!=="function"||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError("Expected synchronous stop diagnostic callback");}
/** One serial keyset owner. Busy targets are skipped after advancing the cursor;
 * no detached task per Stop and no retry of claimed/unknown original authority. */
export class StopControlWorker{
  readonly #path:string;readonly #server:Server|null;readonly #bridge:Pick<BridgeState,"selectedThreadId">;readonly #locks:TargetLocks;readonly #state:Store;readonly #verify:ControlTurnVerifier;readonly #render:(e:unknown)=>string;readonly #report:(e:StopWorkerFailure)=>void;readonly #mapped:ReturnType<typeof createRuntimeFenceErrors>;
  #cursor=0n;#processing=false;#running=false;
  constructor(path:string,server:Server|null,bridge:Pick<BridgeState,"selectedThreadId">,locks:TargetLocks,render:(e:unknown)=>string,report:(e:StopWorkerFailure)=>void,state:Store=StateAccessFacade){sync(render);sync(report);this.#path=path;this.#server=server;this.#bridge=bridge;this.#locks=locks;this.#state=state;this.#render=render;this.#report=report;this.#verify=new ControlTurnVerifier(path,server,bridge,locks,state);this.#mapped=createRuntimeFenceErrors(render);}
  get cursor():bigint{return this.#cursor;}
  #diagnostic(error:unknown):string{const s=this.#render(error);if(types.isPromise(s))void Promise.prototype.then.call(s,undefined,()=>undefined);if(typeof s!=="string"||/[\uD800-\uDFFF]/u.test(s))throw new TypeError("Expected public-safe stop diagnostic");return s;}
  #notify(event:StopWorkerFailure):void{invokeSynchronousVoid(this.#report,{},[Object.freeze(event)]);}
  async process(signal?:AbortSignal):Promise<number>{
    if(this.#processing)throw new TypeError("A stop cycle is already active");this.#processing=true;
    try{
      signal?.throwIfAborted();const server=this.#server;if(server===null)throw new MissingActionAppServerError();const pending=this.#state.pendingStopControlsAfter(this.#path,this.#cursor);if(pending.length===0){this.#cursor=0n;return 0;}let dispatched=0;
      for(const [sequence,original] of pending){
        signal?.throwIfAborted();this.#cursor=sequence;if(original.resident!==server.instanceId||original.generation<0n||original.generation!==server.generation())continue;
        const lease=this.#locks.tryAcquire(original.target);if(!lease)continue;
        try{
          const check=selectedCheck(original.binding,this.#bridge);check();try{await this.#verify.owned(original.target,original.turn);}catch(error){if(signal?.aborted)throw signal.reason;continue;}
          signal?.throwIfAborted();const claim=this.#state.claimStopControl(this.#path,original,check);if(claim===null)continue;signal?.throwIfAborted();let failed=false,error:unknown;
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
  async run(shutdown:AbortSignal,ticks:()=>TickSource=()=>new SkippedTicks(250)):Promise<void>{
    if(shutdown.aborted)return;if(this.#running||this.#processing)throw new TypeError("Stop worker already owns a cycle");this.#running=true;let tick:TickSource|undefined;let cycle:AbortController|undefined;let wake!:()=>void;
    const stopped=new Promise<void>(resolve=>{wake=resolve;}),abort=()=>{cycle?.abort(shutdown.reason);wake();};shutdown.addEventListener("abort",abort,{once:true});
    try{
      tick=ticks();while(!shutdown.aborted){await Promise.race([tick.wait(),stopped]);if(shutdown.aborted)break;
        cycle=new AbortController();const current=cycle,timeout=new Error("stop control worker cycle deadline; durable authority retained, no replay"),timer=setTimeout(()=>current.abort(timeout),2000);
        try{await this.process(current.signal);}catch(error){if(shutdown.aborted&&error===shutdown.reason)break;this.#notify({stage:current.signal.aborted&&error===timeout?"deadline":"cycle",error});}
        finally{clearTimeout(timer);cycle=undefined;}
      }
    }finally{shutdown.removeEventListener("abort",abort);try{tick?.close();}finally{this.#running=false;}}
  }
}
