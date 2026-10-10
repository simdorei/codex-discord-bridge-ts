import {invokeSynchronousVoid} from "../core/synchronous-void.ts";
import {cloneDeadGenerationWork,deadGenerationWorkEqual,deadGenerationWorkIsEmpty,type DeadGenerationWork,type DeadGenerationSettleResult} from "./dead-generation-work.ts";
import {types} from "node:util";
import type {ClientAdmissionPermit} from "./client-lifecycle.ts";
import {AppServerClosedError} from "./client-errors.ts";
import {GenerationWatch,type GenerationWatchReceiver} from "./generation-watch.ts";
export interface ResidentClientPort{
  readonly identity:object;
  admitOperation():ClientAdmissionPermit;sealAdmissions():void;sealIfQuiescent():boolean;
  withOpen<T>(operation:()=>T):T;
}
export interface ResidentDeadClientPort extends ResidentClientPort{
  hasOwnedChildExited():boolean;
  isTransportClosed():boolean;
  sealIfNoAdmissions():boolean;
  deadGenerationWork(generation:bigint):DeadGenerationWork|null;
  settleDeadGenerationExact(expected:DeadGenerationWork):boolean;
}
export type ResidentFailure=
  |{readonly kind:"GenerationMismatch";readonly expected:bigint;readonly actual:bigint}
  |{readonly kind:"GenerationQuarantined";readonly generation:bigint}
  |{readonly kind:"ReplacementState"|"MutationHeld"|"DeadGenerationFence";readonly message:string};
const ownedResidentFailures=new WeakMap<object,ResidentFailure>();
export function ownedResidentFailure(error:unknown):ResidentFailure|null{return error!==null&&(typeof error==="object"||typeof error==="function")?ownedResidentFailures.get(error)??null:null;}
export class ResidentStateError extends Error{
  readonly detail:ResidentFailure;
  constructor(detail:ResidentFailure){super(detail.kind==="GenerationMismatch"?`app-server generation mismatch: expected ${detail.expected}, current ${detail.actual}`:detail.kind==="GenerationQuarantined"?`app-server generation ${detail.generation} is quarantined after an ambiguous timeout`:detail.kind==="ReplacementState"?`resident app-server replacement state invalid: ${detail.message}`:detail.kind==="DeadGenerationFence"?`dead app-server work could not be durably fenced: ${detail.message}`:`mutation execution held: ${detail.message}`);this.name="ResidentStateError";this.detail=Object.freeze(detail);ownedResidentFailures.set(this,this.detail);}
}
export interface ResidentAdmission<C extends ResidentClientPort>{readonly client:C;readonly generation:bigint;readonly permit:ClientAdmissionPermit;release():void}
export interface ReplacementCleanup<C extends ResidentClientPort>{readonly client:C;readonly generation:bigint}
export type RestartCandidate<C extends ResidentClientPort>={readonly kind:"NotPending"|"Busy"}|{readonly kind:"Sealed";readonly client:C};
function u64(value:bigint):void{if(typeof value!=="bigint"||value<0n||value>=(1n<<64n))throw new TypeError("Expected u64 resident generation");}
export function nextResidentGeneration(current:bigint):bigint{u64(current);if(current===(1n<<64n)-1n)throw new RangeError("resident generation overflow");return current+1n;}
function port(client:ResidentClientPort):void{
  if(client===null||typeof client!=="object"||types.isProxy(client)||!Object.isFrozen(client))throw new TypeError("Expected frozen trusted resident client port");
  const identity=Object.getOwnPropertyDescriptor(client,"identity");if(!identity||!Object.hasOwn(identity,"value")||identity.value===null||typeof identity.value!=="object")throw new TypeError("Expected stable client identity");
  for(const name of ["admitOperation","sealAdmissions","sealIfQuiescent","withOpen"]){const d=Object.getOwnPropertyDescriptor(client,name);if(!d||!Object.hasOwn(d,"value")||typeof d.value!=="function"||types.isProxy(d.value)||types.isAsyncFunction(d.value)||types.isGeneratorFunction(d.value))throw new TypeError("Expected synchronous owned client methods");}
}
const same=(a:ResidentClientPort,b:ResidentClientPort)=>a.identity===b.identity;
const replacement=(message:string)=>new ResidentStateError({kind:"ReplacementState",message});
/** Single synchronous owner of the bounded admission/restart/replacement state subset.
 * Ports are TRUSTED owned client capabilities, not untrusted DTOs or proof of native
 * ownership. Production binding and dead-generation durable settlement remain separate.
 * Callbacks must be bounded synchronous publication, never DB acquisition or RPC. */
export class ResidentAdmissionState<C extends ResidentClientPort>{
  #client:C|null;#replacement:ReplacementCleanup<C>|null=null;#generation=1n;#quarantined=false;#restartPending=false;#accepting=true;#terminal=false;#cleanupAuthorized:bigint|null=null;#critical=false;
  #settledDeadWork:DeadGenerationWork|null=null;
  readonly #changes=new GenerationWatch(null);
  constructor(client:C){port(client);this.#client=client;}
  #locked<T>(operation:()=>T):T{if(this.#critical)throw new TypeError("Resident state callback must not reenter");this.#critical=true;try{return operation();}finally{this.#critical=false;}}
  #pending(value:boolean):void{this.#restartPending=value;this.#changes.replace(value?this.#generation:null);}
  #generationMatches(expected:bigint):void{if(expected!==this.#generation)throw new ResidentStateError({kind:"GenerationMismatch",expected,actual:this.#generation});}
  /** Capture ordinary JS callback failures inside the client gate and rethrow outside.
   * Recovery is source-backed catch_unwind; JS does not distinguish Rust panics from
   * Result errors. Native panic/unwind equivalence is not claimed for this adapter. */
  #openResult<T>(client:C,operation:()=>T):T{
    if(typeof operation!=="function"||types.isProxy(operation)||types.isAsyncFunction(operation)||types.isGeneratorFunction(operation))throw new TypeError("Resident publication must be synchronous");
    const outcome=client.withOpen(()=>{try{const value=operation();if(types.isPromise(value)){void Promise.prototype.then.call(value,undefined,()=>undefined);throw new TypeError("Resident publication must not return a Promise");}return {ok:true as const,value};}catch(error){return {ok:false as const,error};}});
    if(!outcome.ok)throw outcome.error;return outcome.value;
  }
  generation():bigint{return this.#locked(()=>this.#generation);}
  snapshot(){return this.#locked(()=>Object.freeze({client:this.#client,generation:this.#generation,quarantined:this.#quarantined,restartPending:this.#restartPending,accepting:this.#accepting}));}
  currentClient():C{return this.#locked(()=>{if(!this.#accepting||this.#client===null)throw new AppServerClosedError();return this.#client;});}
  admitRequest(expected:bigint|null=null):ResidentAdmission<C>{return this.#admit(expected,true);}
  admitResponse(expected:bigint):ResidentAdmission<C>{return this.#admit(expected,false);}
  #admit(expected:bigint|null,rejectQuarantined:boolean):ResidentAdmission<C>{
    if(expected!==null)u64(expected);
    return this.#locked(()=>{
      if(expected!==null)this.#generationMatches(expected);if(!this.#accepting)throw new AppServerClosedError();
      if(rejectQuarantined&&this.#quarantined)throw new ResidentStateError({kind:"GenerationQuarantined",generation:this.#generation});
      if(this.#client===null)throw new AppServerClosedError();const client=this.#client,permit=client.admitOperation();return Object.freeze({client,generation:this.#generation,permit,release:()=>permit.release()});
    });
  }
  withRecoveryCurrent<T>(expected:C,generation:bigint,operation:()=>T):T{
    port(expected);u64(generation);return this.#locked(()=>{
      if(this.#generation!==generation||this.#client===null||!same(this.#client,expected)||!this.#accepting||this.#terminal||this.#quarantined||this.#restartPending)throw new ResidentStateError({kind:"MutationHeld",message:"recovery observation connection is no longer current and open"});
      return this.#openResult(expected,operation);
    });
  }
  markTimeout(generation:bigint):void{this.markCancelled(generation);}
  markCancelled(generation:bigint):void{u64(generation);this.#locked(()=>{if(this.#generation===generation&&this.#accepting&&this.#client!==null){this.#quarantined=true;this.#pending(true);}});}
  requestRestart():void{this.#locked(()=>{if(!this.#terminal)this.#pending(true);});}
  restartPendingFor(generation:bigint):boolean{u64(generation);return this.#locked(()=>!this.#terminal&&this.#generation===generation&&this.#restartPending);}
  subscribeLifecycleChanges():GenerationWatchReceiver{return this.#changes.subscribe();}
  restartCandidate(expected:bigint|null=null):RestartCandidate<C>{
    if(expected!==null)u64(expected);return this.#locked(()=>{
      if(this.#terminal||(expected!==null&&expected!==this.#generation)||!this.#restartPending)return Object.freeze({kind:"NotPending"});
      if(this.#client===null)throw new AppServerClosedError();const sealed:unknown=this.#client.sealIfQuiescent();
      if(typeof sealed!=="boolean"){if(types.isPromise(sealed))void Promise.prototype.then.call(sealed,undefined,()=>undefined);throw new TypeError("Client quiescence must return a synchronous boolean");}
      if(!sealed)return Object.freeze({kind:"Busy"});
      this.#accepting=false;this.#cleanupAuthorized=this.#generation;return Object.freeze({kind:"Sealed",client:this.#client});
    });
  }
  restartCleanupAuthorized(generation:bigint):boolean{u64(generation);return this.#locked(()=>!this.#terminal&&this.#generation===generation&&!this.#accepting&&this.#cleanupAuthorized===generation);}
  replacementGeneration():bigint{return this.#locked(()=>nextResidentGeneration(this.#generation));}
  recordReplacement(client:C,generation:bigint):void{
    port(client);u64(generation);this.#locked(()=>{
      if(this.#terminal)throw new AppServerClosedError();const expected=nextResidentGeneration(this.#generation);
      if(generation!==expected)throw replacement(`candidate generation ${generation} does not follow ${expected}`);
      if(this.#replacement!==null)throw replacement("another replacement still requires cleanup");this.#replacement=Object.freeze({client,generation});
    });
  }
  replacementCleanup():ReplacementCleanup<C>|null{return this.#locked(()=>this.#replacement);}
  finishReplacementCleanup(expected:ReplacementCleanup<C>):void{
    port(expected.client);u64(expected.generation);this.#locked(()=>{
      const actual=this.#replacement;if(actual===null)throw replacement("replacement cleanup debt is missing");
      if(actual.generation!==expected.generation||!same(actual.client,expected.client))throw replacement("replacement cleanup debt changed identity");this.#replacement=null;
    });
  }
  installReplacementWith(expected:C,generation:bigint,install:()=>void):void{
    port(expected);u64(generation);this.#locked(()=>{
      if(this.#terminal)throw new AppServerClosedError();const candidate=this.#replacement;if(candidate===null)throw replacement("replacement candidate is missing");
      if(candidate.generation!==generation||generation!==nextResidentGeneration(this.#generation)||!same(candidate.client,expected))throw replacement("replacement candidate identity or generation changed");
      if(typeof install!=="function"||types.isProxy(install)||types.isAsyncFunction(install)||types.isGeneratorFunction(install))throw new TypeError("Replacement install must be synchronous");
      this.#openResult(expected,()=>{const result:unknown=install();if(result!==undefined){if(types.isPromise(result))void Promise.prototype.then.call(result,undefined,()=>undefined);throw new TypeError("Replacement install must be synchronous void");}this.#client=candidate.client;this.#replacement=null;this.#generation=generation;this.#cleanupAuthorized=null;this.#quarantined=false;this.#pending(false);this.#accepting=true;});
    });
  }
  markCurrentClosed(expected:C,generation:bigint):void{port(expected);u64(generation);this.#locked(()=>{if(!this.#terminal&&this.#generation===generation&&this.#client!==null&&same(this.#client,expected)){this.#accepting=false;this.#pending(true);}});}
  #deadClient():ResidentDeadClientPort{
    const client=this.#client;if(client===null)throw new AppServerClosedError();
    for(const key of ["hasOwnedChildExited","isTransportClosed","sealIfNoAdmissions","deadGenerationWork","settleDeadGenerationExact"]){const d=Object.getOwnPropertyDescriptor(client,key);if(!d||!Object.hasOwn(d,"value")||typeof d.value!=="function"||types.isProxy(d.value)||types.isAsyncFunction(d.value)||types.isGeneratorFunction(d.value))throw new TypeError("Missing synchronous owned dead-generation port");}
    return client as unknown as ResidentDeadClientPort;
  }
  #eligibleDead():boolean{return !this.#terminal&&this.#restartPending&&!this.#accepting&&this.#client!==null&&this.#deadClient().isTransportClosed()===true;}
  deadGenerationWork(expected:bigint):DeadGenerationWork|null{
    u64(expected);return this.#locked(()=>{this.#generationMatches(expected);if(!this.#eligibleDead())return null;const work=this.#deadClient().deadGenerationWork(expected);if(work===null)return null;const owned=cloneDeadGenerationWork(work);return deadGenerationWorkIsEmpty(owned)?null:owned;});
  }
  #captureDeadForFence(generation:bigint):DeadGenerationWork|null{
    return this.#locked(()=>{this.#generationMatches(generation);if(this.#terminal||!this.#restartPending)return null;
      if(this.#settledDeadWork?.generation===generation)return this.#settledDeadWork;
      const work=this.#deadClient().deadGenerationWork(generation);if(work===null)return null;const owned=cloneDeadGenerationWork(work);this.#accepting=false;return owned;
    });
  }
  /** Internal explicit settlement after durable capture. Snapshot identity is necessary,
   * not proof of persistence; the normal owner entry below requires a persist callback. */
  settleDeadGeneration(expectedGeneration:bigint,expected:DeadGenerationWork):DeadGenerationSettleResult{
    u64(expectedGeneration);const owned=cloneDeadGenerationWork(expected);return this.#locked(()=>{
      if(owned.generation!==expectedGeneration)return "SnapshotChanged";
      if(this.#settledDeadWork!==null&&deadGenerationWorkEqual(this.#settledDeadWork,owned))return "AlreadySettled";
      this.#generationMatches(expectedGeneration);if(!this.#eligibleDead())return "NotEligible";
      const client=this.#deadClient(),raw=client.deadGenerationWork(expectedGeneration);if(raw===null)return "NotEligible";
      if(!deadGenerationWorkEqual(cloneDeadGenerationWork(raw),owned))return "SnapshotChanged";
      if(client.settleDeadGenerationExact(owned)!==true)return "NotEligible";
      this.#settledDeadWork=owned;return "Settled";
    });
  }
  /** Synchronous subset of source restart fencing. Actual owned exit observation, final
   * transport closure and zero admissions precede persistence. The native port retains
   * its owned process object/confirmed-exit receipt; no missing PID/handle infers death.
   * Caller must serialize the encompassing restart workflow. Persistence must return
   * only once durable and must not reenter the client's lifecycle gate. */
  fenceDeadGenerationBeforeRestart(persist:(work:DeadGenerationWork)=>void):boolean{
    const snapshot=this.snapshot(),generation=snapshot.generation;if(!snapshot.restartPending)return true;
    if(snapshot.client===null)throw new AppServerClosedError();if(this.restartCleanupAuthorized(generation))return true;
    const client=this.#locked(()=>{this.#generationMatches(generation);return this.#deadClient();});
    const exited:unknown=client.hasOwnedChildExited(),closed:unknown=client.isTransportClosed();
    if(typeof exited!=="boolean"||typeof closed!=="boolean")throw new TypeError("Expected synchronous native exit/closure observations");
    if(!exited)return !closed;if(!closed)return false;
    const sealed:unknown=client.sealIfNoAdmissions();if(typeof sealed!=="boolean")throw new TypeError("Expected synchronous admission sealing");if(!sealed)return false;
    const work=this.#captureDeadForFence(generation);if(work===null)return true;
    invokeSynchronousVoid(persist,this,[work]);const result=this.settleDeadGeneration(generation,work);
    if(result==="Settled"||result==="AlreadySettled")return true;
    throw new ResidentStateError({kind:"DeadGenerationFence",message:"dead-generation snapshot changed after durable capture"});
  }
  prepareClose(){return this.#locked(()=>{this.#accepting=false;this.#terminal=true;this.#pending(false);const current=this.#client,replacement=this.#replacement;current?.sealAdmissions();replacement?.client.sealAdmissions();return Object.freeze({current,replacement});});}
  /** Explicit owner Drop-equivalent only after terminal cleanup has released all clients. */
  closeLifecycleChanges():void{this.#locked(()=>{if(!this.#terminal||this.#client!==null||this.#replacement!==null)throw replacement("lifecycle watch still has owned client cleanup");this.#changes.close();});}
  finishCurrentClose(expected:C):void{port(expected);this.#locked(()=>{if(!this.#terminal)throw replacement("resident close is no longer terminal");if(this.#client===null)return;if(!same(this.#client,expected))throw replacement("resident close target changed identity");this.#client=null;});}
}
