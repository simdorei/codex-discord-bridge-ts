import {types} from "node:util";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {invokeSynchronousVoid} from "../core/synchronous-void.ts";
import type {ResidentAdmission,ResidentAdmissionState} from "./resident-state.ts";
import type {PortableResidentClientPort} from "./portable-session.ts";
import {IdleTargetGate,type TargetExclusivePermit} from "./idle-target-gate.ts";
import {cloneIdleReleaseToken,type IdleReleaseToken} from "./idle-release-journal.ts";
import {IdleObservationError} from "./notification-state.ts";
import {WrittenRequestGuard} from "./written-request-guard.ts";
import {ownedRequestFailure} from "./request-client.ts";
import {MaintenanceAttempt,type MaintenanceMutationFence,type MaintenanceClaim,type MaintenanceCompletion} from "./maintenance-attempt.ts";
import type {IdleMaintenancePort,IdleRpcRequest,IdleRpcResult,IdleWritePhase} from "./idle-maintenance.ts";
export interface MaintenanceTransportFence extends MaintenanceMutationFence{
  checkRequest(generation:bigint,method:string,params:unknown):void;
}
function held(detail:string):IdleObservationError{return new IdleObservationError(detail);}
function fn(value:unknown):asserts value is Function{if(typeof value!=="function"||types.isProxy(value)||types.isAsyncFunction(value)||types.isGeneratorFunction(value))throw new TypeError("Expected synchronous maintenance hook");}
function pinFence(input:MaintenanceTransportFence|null):MaintenanceTransportFence|null{
  if(input===null)return null;if(typeof input!=="object"||types.isProxy(input))throw new TypeError("Expected owned maintenance fence");
  const get=(key:string)=>{const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own maintenance fence method");fn(d.value);return d.value;};
  const begin=get("beginMutationWithOrigin"),finish=get("finishMutation"),check=get("checkRequest");
  return Object.freeze({checkRequest:(g:bigint,m:string,p:unknown)=>invokeSynchronousVoid(check,input,[g,m,p]),finishMutation:(c:MaintenanceCompletion)=>invokeSynchronousVoid(finish,input,[c]),beginMutationWithOrigin:(c:MaintenanceClaim)=>{const r=Reflect.apply(begin,input,[c]);if(types.isPromise(r))void Promise.prototype.then.call(r,undefined,()=>undefined);if(typeof r!=="boolean")throw new TypeError("Expected committed mutation boolean");return r;}});
}
/** Bound to one resident admission and the actual session's request writer. The owning
 * managed task retains/releases admission + exclusive permit; this adapter never passes
 * waiter cancellation into the owned request. Persistence must finish synchronously
 * before native bytes. This does not create a store adapter or authorize a live service. */
export class MaintenanceTransport{
  readonly #state:ResidentAdmissionState<PortableResidentClientPort>;readonly #admission:ResidentAdmission<PortableResidentClientPort>;
  readonly #gate:IdleTargetGate;readonly #permit:TargetExclusivePermit;readonly #token:IdleReleaseToken;
  readonly #fence:MaintenanceTransportFence|null;readonly #origin:unknown|null;readonly #render:(e:unknown)=>string;readonly #check:()=>void;
  constructor(state:ResidentAdmissionState<PortableResidentClientPort>,admission:ResidentAdmission<PortableResidentClientPort>,gate:IdleTargetGate,permit:TargetExclusivePermit,token:IdleReleaseToken,fence:MaintenanceTransportFence|null,origin:unknown|null,render:(e:unknown)=>string,dispatchCheck:()=>void=()=>{}){
    this.#state=state;this.#admission=admission;this.#gate=gate;this.#permit=permit;this.#token=cloneIdleReleaseToken(token);this.#fence=pinFence(fence);this.#origin=origin===null?null:cloneOwnedSerdeValue(origin);fn(render);fn(dispatchCheck);
    this.#render=e=>{const r=render(e);if(types.isPromise(r))void Promise.prototype.then.call(r,undefined,()=>undefined);if(typeof r!=="string"||/[\uD800-\uDFFF]/u.test(r))throw new TypeError("Expected safe maintenance diagnostic");return r;};this.#check=()=>invokeSynchronousVoid(dispatchCheck,{},[]);
    if(admission.generation!==token.generation||permit.thread!==token.threadId)throw held("maintenance admission identity mismatch");permit.requireHeld();
  }
  port():IdleMaintenancePort{return Object.freeze<IdleMaintenancePort>({rpc:r=>this.#rpc(r),localIdle:w=>this.#localIdle(w),witnessedTerminal:(t,v)=>this.#admission.client.idleMaintenanceSnapshot(t,v).witnessedTerminal,generation:()=>this.#state.generation(),renderError:this.#render});}
  #localIdle(watermark:bigint|null):bigint{
    this.#permit.requireHeld();if(!this.#gate.observationsVerified())throw held("idle unverified: observer gap or journal failure");
    const snapshot=this.#admission.client.idleMaintenanceSnapshot(this.#token.threadId,this.#token.turnId);
    if(!snapshot.caughtUp)throw held("idle unverified: notifications not yet journaled");
    if(snapshot.activeTurn||snapshot.blockingRequest)throw held("idle unverified: active turn or unsettled server request");
    if(watermark!==null&&snapshot.revision!==watermark)throw held("idle observation changed before actual send");return snapshot.revision;
  }
  async #rpc(input:IdleRpcRequest):Promise<IdleRpcResult>{
    const token=cloneIdleReleaseToken(input.token),params=cloneOwnedSerdeValue(input.params);
    if(token.ownerId!==this.#token.ownerId||token.generation!==this.#token.generation||token.threadId!==this.#token.threadId||token.turnId!==this.#token.turnId||token.jobId!==this.#token.jobId||token.intentId!==this.#token.intentId)throw held("maintenance request changed original token identity");
    const method=input.method,wait=input.timeoutMs,idle=input.requireIdle,watermark=input.watermark;
    if(!["thread/goal/get","thread/read","thread/unsubscribe","thread/resume"].includes(method))throw new TypeError("Unsupported maintenance method");
    if(typeof method!=="string"||/[\uD800-\uDFFF]/u.test(method)||!Number.isFinite(wait)||wait<0||typeof idle!=="boolean"||(watermark!==null&&(typeof watermark!=="bigint"||watermark<0n||watermark>=(1n<<64n))))throw new TypeError("Expected maintenance request fields");
    const attempt=new MaintenanceAttempt(token,method,params,this.#origin,this.#fence,this.#render),written=new WrittenRequestGuard(this.#state,token.generation);
    const progress:{phase:IdleWritePhase}={phase:"NotStarted"};let result:IdleRpcResult;
    try{
      try{
        const value=await this.#admission.client.requestAdmitted(this.#admission.permit,method,params,wait,{
          preflight:wire=>{
            this.#check();const snapshot=this.#state.snapshot();
            if(snapshot.generation!==token.generation||!snapshot.accepting||snapshot.quarantined||snapshot.client?.identity!==this.#admission.client.identity)throw held("maintenance connection changed or became unhealthy before actual write");
            this.#permit.requireHeld();this.#permit.journal.verify(token,idle);this.#fence?.checkRequest(token.generation,method,params);if(idle)this.#localIdle(watermark);attempt.begin(wire);
          },writeStarted:()=>{progress.phase="Partial";written.confirmWriteStarted();},writeComplete:()=>{progress.phase="Flushed";},
        });
        written.finish("Success");result={ok:true,value,phase:progress.phase};
      }catch(error){
        const failure=ownedRequestFailure(error);
        if(failure!==null)written.finish(failure.kind==="Remote"?"OtherError":failure.kind);
        // A native/adapter error without owned request metadata after write-start is
        // conservatively quarantined by unfinished guard disposal. No error-message
        // inference and no healthy fully-flushed Timeout quarantine are introduced.
        result={ok:false,error,phase:progress.phase};
      }
      return attempt.finish(result);
    }finally{written.dispose();}
  }
}
