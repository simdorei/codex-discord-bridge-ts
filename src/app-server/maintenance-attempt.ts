import {randomUUID} from "node:crypto";
import {types} from "node:util";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {validateRequestId,type RequestId} from "../protocol/ids.ts";
import {isObservationalRequest} from "./requests.ts";
import {serdeField} from "./value.ts";
import {ownedRequestFailure} from "./request-client.ts";
import {cloneIdleReleaseToken,type IdleReleaseToken} from "./idle-release-journal.ts";
import type {IdleRpcResult} from "./idle-maintenance.ts";
export interface MaintenanceClaim{
  readonly ownerId:string;readonly generation:bigint;readonly attemptId:string;
  readonly wire:RequestId;readonly method:string;readonly params:unknown;
  readonly scoped:boolean;readonly origin:unknown|null;
}
export interface MaintenanceCompletion{
  readonly ownerId:string;readonly generation:bigint;readonly attemptId:string;
  readonly wire:RequestId;readonly outcome:"not_sent"|"reply_ok"|"reply_error";
}
/** Synchronous committed persistence at actual writer preflight. An explicit false
 * result retains legacy no-isolation semantics; no default successful adapter exists. */
export interface MaintenanceMutationFence{
  beginMutationWithOrigin(claim:MaintenanceClaim):boolean;
  finishMutation(completion:MaintenanceCompletion):void;
}
export class MutationOutcomeUnknownError extends Error{
  readonly method:string;readonly reason:string;
  constructor(method:string,reason:string){super(`app-server mutation ${method} outcome remains unknown: ${reason}`);this.name="MutationOutcomeUnknownError";this.method=method;this.reason=reason;}
}
function text(value:unknown):asserts value is string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed maintenance text");}
function syncCall(f:Function,receiver:unknown,args:unknown[]):unknown{const result=Reflect.apply(f,receiver,args);if(types.isPromise(result)){void Promise.prototype.then.call(result,undefined,()=>undefined);throw new TypeError("Maintenance fence must commit synchronously");}return result;}
function method(input:object,key:string):Function{const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,"value")||typeof d.value!=="function"||types.isProxy(d.value)||types.isAsyncFunction(d.value)||types.isGeneratorFunction(d.value))throw new TypeError("Expected own synchronous maintenance fence method");return d.value;}
/** Managed task owns this exact attempt, even after its original waiter leaves.
 * No arbitrary error classification can settle a reply_error: only the request
 * client's owned Remote variant does. Unknown outcomes deliberately retain the row. */
export class MaintenanceAttempt{
  readonly #token:IdleReleaseToken;readonly #method:string;readonly #params:unknown;readonly #origin:unknown|null;
  readonly #id=randomUUID();readonly #fence:MaintenanceMutationFence|null;readonly #render:(e:unknown)=>string;
  #wire:RequestId|null=null;#begun=false;#finished=false;
  constructor(token:IdleReleaseToken,rpcMethod:string,params:unknown,origin:unknown|null,fence:MaintenanceMutationFence|null,render:(e:unknown)=>string){
    this.#token=cloneIdleReleaseToken(token);text(rpcMethod);this.#method=rpcMethod;this.#params=cloneOwnedSerdeValue(params);this.#origin=origin===null?null:cloneOwnedSerdeValue(origin);
    if(typeof render!=="function"||types.isProxy(render)||types.isAsyncFunction(render)||types.isGeneratorFunction(render))throw new TypeError("Expected passive error renderer");
    this.#render=e=>{const result=syncCall(render,undefined,[e]);text(result);return result;};
    if(fence===null)this.#fence=null;
    else{if(typeof fence!=="object"||types.isProxy(fence))throw new TypeError("Expected maintenance fence");const begin=method(fence,"beginMutationWithOrigin"),finish=method(fence,"finishMutation");this.#fence=Object.freeze({beginMutationWithOrigin:(claim:MaintenanceClaim)=>{const r=syncCall(begin,fence,[claim]);if(typeof r!=="boolean")throw new TypeError("Expected exact fence commitment boolean");return r;},finishMutation:(completion:MaintenanceCompletion)=>{if(syncCall(finish,fence,[completion])!==undefined)throw new TypeError("Expected void fence completion");}});}
  }
  begin(wire:RequestId):void{
    if(this.#begun||this.#finished)throw new TypeError("Maintenance attempt already started or finished");wire=validateRequestId(wire);this.#begun=true;
    if(isObservationalRequest(this.#method)||this.#fence===null)return;
    if(this.#fence.beginMutationWithOrigin(Object.freeze({ownerId:this.#token.ownerId,generation:this.#token.generation,attemptId:this.#id,wire,method:this.#method,params:this.#params,scoped:true,origin:this.#origin})))this.#wire=wire;
  }
  finish(result:IdleRpcResult):IdleRpcResult{
    if(this.#finished)throw new TypeError("Maintenance attempt already finished");
    const phase=serdeField(result,"phase"),ok=serdeField(result,"ok");
    if((phase!=="NotStarted"&&phase!=="Partial"&&phase!=="Flushed")||(ok!==true&&ok!==false))throw new TypeError("Expected exact maintenance outcome");
    result=ok?{ok:true,value:cloneOwnedSerdeValue(serdeField(result,"value")),phase}:{ok:false,error:serdeField(result,"error"),phase};this.#finished=true;
    if(this.#wire===null||this.#fence===null)return result;
    const outcome=result.phase==="NotStarted"?"not_sent":result.ok?"reply_ok":ownedRequestFailure(result.error)?.kind==="Remote"?"reply_error":null;
    if(outcome!==null){
      try{this.#fence.finishMutation(Object.freeze({ownerId:this.#token.ownerId,generation:this.#token.generation,attemptId:this.#id,wire:this.#wire,outcome}));}
      catch(error){return {ok:false,error:this.#unknown(`maintenance result not committed: ${this.#render(error)}`),phase:result.phase};}
      return result;
    }
    return result.ok?result:{ok:false,error:this.#unknown(this.#render(result.error)),phase:result.phase};
  }
  #unknown(reason:string):MutationOutcomeUnknownError{return new MutationOutcomeUnknownError(this.#method,`${reason}; durable maintenance attempt ${this.#id} retained; no automatic replay`);}
}
