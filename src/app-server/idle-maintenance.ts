import {types} from "node:util";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {cloneIdleReleaseToken,type IdleReleaseToken} from "./idle-release-journal.ts";
import type {TargetExclusivePermit} from "./idle-target-gate.ts";
import {IdleObservationError} from "./notification-state.ts";
import {parseThreadGoalStatus} from "./goal.ts";
import {serdeField} from "./value.ts";

export type IdleWritePhase="NotStarted"|"Partial"|"Flushed";
export type IdleRpcResult={readonly ok:true;readonly value:unknown;readonly phase:IdleWritePhase}|{readonly ok:false;readonly error:unknown;readonly phase:IdleWritePhase};
export interface IdleRpcRequest{
  readonly token:IdleReleaseToken;readonly method:string;readonly params:unknown;
  readonly timeoutMs:number;readonly requireIdle:boolean;readonly watermark:bigint|null;
}
/** Trusted resident adapter, not a user-configurable transport. rpc must retain its
 * resident admission and durable Attempt through completion and return the actual
 * write phase. A timeout/unknown result never grants replay authority. */
export interface IdleMaintenancePort{
  rpc(request:IdleRpcRequest):Promise<IdleRpcResult>;
  localIdle(expectedWatermark:bigint|null):bigint;
  witnessedTerminal(thread:string,turn:string):boolean;
  generation():bigint;
  renderError(error:unknown):string;
}
function held(message:string):IdleObservationError{return new IdleObservationError(message);}
function u64(value:unknown):asserts value is bigint{if(typeof value!=="bigint"||value<0n||value>=(1n<<64n))throw new TypeError("Expected maintenance u64");}
function text(value:unknown):asserts value is string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected maintenance diagnostic text");}
function pin(input:IdleMaintenancePort):IdleMaintenancePort{
  if(input===null||typeof input!=="object"||types.isProxy(input))throw new TypeError("Expected owned maintenance port");
  const method=(name:keyof IdleMaintenancePort,asyncAllowed=false):Function=>{const d=Object.getOwnPropertyDescriptor(input,name);if(!d||!Object.hasOwn(d,"value")||typeof d.value!=="function"||types.isProxy(d.value)||types.isGeneratorFunction(d.value)||(!asyncAllowed&&types.isAsyncFunction(d.value)))throw new TypeError("Expected own maintenance method");return d.value;};
  const rpc=method("rpc",true),idle=method("localIdle"),witness=method("witnessedTerminal"),generation=method("generation"),render=method("renderError");
  const call=(f:Function,args:unknown[]):unknown=>{const r=Reflect.apply(f,input,args);if(types.isPromise(r)){void Promise.prototype.then.call(r,undefined,()=>undefined);throw new TypeError("Maintenance state methods must be synchronous");}return r;};
  return Object.freeze({
    rpc:async(request:IdleRpcRequest):Promise<IdleRpcResult>=>{
      const result:unknown=await Reflect.apply(rpc,input,[request]);
      const phase=serdeField(result,"phase"),ok=serdeField(result,"ok");
      if(phase!=="NotStarted"&&phase!=="Partial"&&phase!=="Flushed")throw new TypeError("Missing exact maintenance write phase; durable hold retained");
      if(ok===true)return {ok:true as const,value:cloneOwnedSerdeValue(serdeField(result,"value")),phase};
      if(ok===false)return {ok:false as const,error:serdeField(result,"error"),phase};
      throw new TypeError("Missing maintenance result; durable hold retained");
    },
    localIdle:(expected:bigint|null)=>{const r=call(idle,[expected]);u64(r);return r;},
    witnessedTerminal:(thread:string,turn:string)=>{const r=call(witness,[thread,turn]);if(typeof r!=="boolean")throw new TypeError("Expected exact terminal witness");return r;},
    generation:()=>{const r=call(generation,[]);u64(r);return r;},
    renderError:(e:unknown)=>{const r=call(render,[e]);text(r);return r;},
  });
}
/** One consumed Work, corresponding to manager/idle_maintenance.rs and release.rs.
 * The owning resident supplies a live exclusive permit and retains admission until
 * this promise settles. This coordinator never owns caller cancellation: stopping
 * waiting must not cancel already-started maintenance. Transport and task ownership
 * are adapter obligations, not proven by this bounded state machine. */
export class IdleMaintenanceWork{
  #token:IdleReleaseToken;readonly #permit:TargetExclusivePermit;readonly #port:IdleMaintenancePort;#used=false;
  constructor(token:IdleReleaseToken,permit:TargetExclusivePermit,port:IdleMaintenancePort){
    this.#token=cloneIdleReleaseToken(token);this.#permit=permit;this.#port=pin(port);
    permit.requireHeld();if(permit.thread!==this.#token.threadId)throw held("idle target permit mismatch");
  }
  #consume():void{if(this.#used)throw new TypeError("Maintenance work already consumed");this.#used=true;this.#permit.requireHeld();}
  #advance(state:string,detail:string):void{this.#permit.requireHeld();this.#token=this.#permit.journal.transition(this.#token,state,detail);}
  #rpc(method:string,params:unknown,timeoutMs:number,requireIdle:boolean,watermark:bigint|null):Promise<IdleRpcResult>{
    this.#permit.requireHeld();return this.#port.rpc(Object.freeze({token:this.#token,method,params:cloneOwnedSerdeValue(params),timeoutMs,requireIdle,watermark}));
  }
  async #proveIdle():Promise<bigint>{
    const watermark=this.#port.localIdle(null);
    if(!this.#port.witnessedTerminal(this.#token.threadId,this.#token.turnId))throw held("idle unverified: exact terminal not witnessed by this resident");
    const goal=await this.#rpc("thread/goal/get",{threadId:this.#token.threadId},2000,true,watermark);
    if(!goal.ok)throw goal.error;
    if(serdeField(goal.value,"goal")===undefined)throw held("idle unverified: missing explicit goal result");
    let status;try{status=parseThreadGoalStatus(goal.value,this.#token.threadId);}catch(e){throw held(this.#port.renderError(e));}
    if(status!==null&&status!=="Complete")throw held("idle release deferred: Goal remains active, paused, blocked or limited");
    const response=await this.#rpc("thread/read",{threadId:this.#token.threadId,includeTurns:true},2000,true,watermark);
    if(!response.ok)throw response.error;
    const thread=serdeField(response.value,"thread"),turns=serdeField(thread,"turns"),latest=Array.isArray(turns)?turns.at(-1):undefined;
    if(serdeField(thread,"id")!==this.#token.threadId||serdeField(serdeField(thread,"status"),"type")!=="idle"||serdeField(latest,"id")!==this.#token.turnId||!["completed","failed","interrupted"].includes(serdeField(latest,"status") as string))throw held("idle unverified: exact latest terminal turn is missing or thread not idle");
    return this.#port.localIdle(watermark);
  }
  async release():Promise<void>{
    this.#consume();
    if(this.#token.state!=="Candidate"&&this.#token.state!=="AwaitUnload")throw held("only Candidate or known-ACK AwaitUnload may run maintenance");
    if(this.#token.state==="AwaitUnload"){
      const response=await this.#rpc("thread/read",{threadId:this.#token.threadId,includeTurns:false},2000,false,null);
      if(!response.ok)throw response.error;const thread=serdeField(response.value,"thread");
      if(serdeField(thread,"id")!==this.#token.threadId)throw held("unload read returned a different or missing thread");
      if(serdeField(serdeField(thread,"status"),"type")==="notLoaded")this.#advance("Settled","UnloadedConfirmed");return;
    }
    let watermark:bigint;try{watermark=await this.#proveIdle();}catch(e){this.#advance("Candidate",this.#port.renderError(e));throw e;}
    this.#advance("Dispatching","exact unsubscribe permission committed");
    const response=await this.#rpc("thread/unsubscribe",{threadId:this.#token.threadId},8000,true,watermark);
    if(response.ok&&["unsubscribed","notSubscribed","notLoaded"].includes(serdeField(response.value,"status") as string)){
      this.#advance("AwaitUnload","unsubscribe acknowledged; unload unverified");return;
    }
    const error=response.ok?held("unclassifiable unsubscribe reply"):response.error;
    this.#recordFailure(response.phase,"release",error);throw error;
  }
  async resubscribe(params:unknown):Promise<unknown>{
    this.#consume();const owned=cloneOwnedSerdeValue(params);
    if(this.#token.state!=="Resubscribing")throw held("missing durable resume permission");
    const response=await this.#rpc("thread/resume",owned,8000,false,null);
    if(response.ok&&serdeField(serdeField(response.value,"thread"),"id")===this.#token.threadId&&this.#port.generation()===this.#token.generation){
      this.#advance("Settled","SupersededByConfirmedResubscribe");return response.value;
    }
    const error=response.ok?held("resume returned wrong identity or owner changed"):response.error;
    this.#recordFailure(response.phase,"resume",error);throw error;
  }
  #recordFailure(phase:IdleWritePhase,operation:"release"|"resume",error:unknown):void{
    const notStarted=phase==="NotStarted",state=notStarted?(operation==="release"?"Settled":"AwaitUnload"):"Unknown";
    const detail=notStarted?(operation==="release"?"CancelledBeforeSend":"ResumeCancelledBeforeSend"):this.#port.renderError(error);
    try{this.#advance(state,detail);}catch(recording){throw held(`${this.#port.renderError(error)}; recording failed: ${this.#port.renderError(recording)}; durable ${operation==="release"?"dispatch":"resume"} hold retained`);}
  }
}
