import {serdeField} from "./value.ts";
import {types} from "node:util";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {invokeSynchronousVoid} from "../core/synchronous-void.ts";
import {clonePendingServerRequest,type PendingServerRequest} from "./server-request-state.ts";
import {ResidentStateError} from "./resident-state.ts";
import {MutationOutcomeUnknownError} from "./maintenance-attempt.ts";
export interface ResponseOwner{readonly ownerId:string;readonly generation:bigint;readonly request:PendingServerRequest}
export interface DurableResponseClaim extends ResponseOwner{readonly authority:unknown;readonly payload:unknown}
export interface DurableResponseCompletion extends DurableResponseClaim{readonly outcome:"not_sent"|"flushed"}
/** null means None; {value:null} preserves Some(JSON null) without dropping admission. */
export type CapturedResponseAuthority=Readonly<{value:unknown}>|null;
function capture(input:CapturedResponseAuthority):CapturedResponseAuthority{
  if(input===null)return null;const v=cloneOwnedSerdeValue(input);
  if(v===null||typeof v!=="object"||Array.isArray(v)||Object.keys(v).length!==1||!Object.hasOwn(v,"value"))throw new TypeError("Expected explicit captured response authority");return v as Readonly<{value:unknown}>;
}
export interface ResponseFence{
  responseAuthority?(request:ResponseOwner):CapturedResponseAuthority;
  beginResponse?(claim:DurableResponseClaim):void;
  finishResponse?(completion:DurableResponseCompletion):void;
}
export type ResponseResult={readonly ok:true}|{readonly ok:false;readonly error:unknown};
function unsupported(message:string):never{throw new ResidentStateError({kind:"MutationHeld",message});}
export function pinResponseFence(input:ResponseFence):Required<ResponseFence>{
  if(input===null||typeof input!=="object"||types.isProxy(input))throw new TypeError("Expected response fence");
  const method=(key:string,fallback:Function):Function=>{const d=Object.getOwnPropertyDescriptor(input,key);if(d===undefined)return fallback;if(!Object.hasOwn(d,"value")||typeof d.value!=="function"||types.isProxy(d.value)||types.isAsyncFunction(d.value)||types.isGeneratorFunction(d.value))throw new TypeError("Expected own synchronous response fence method");return d.value;};
  const authority=method("responseAuthority",()=>null),begin=method("beginResponse",()=>unsupported("durable original response admission is unavailable")),finish=method("finishResponse",()=>unsupported("durable original response completion is unavailable"));
  return Object.freeze({responseAuthority:(request:ResponseOwner)=>{const result=Reflect.apply(authority,input,[request]);if(types.isPromise(result))void Promise.prototype.then.call(result,undefined,()=>undefined);return capture(result as CapturedResponseAuthority);},beginResponse:(claim:DurableResponseClaim)=>invokeSynchronousVoid(begin,input,[claim]),finishResponse:(completion:DurableResponseCompletion)=>invokeSynchronousVoid(finish,input,[completion])});
}
/** Exact original occurrence/params/authority/payload, captured before target waits.
 * Commit at actual writer preflight; never settle ambiguous writes in a Drop task. */
export class ResponseAttempt{
  readonly #hasAuthority:boolean;readonly #claim:DurableResponseClaim;readonly #fence:Required<ResponseFence>|null;readonly #check:()=>void;readonly #render:(e:unknown)=>string;
  #begun=false;#admitted=false;#started=false;#finished=false;
  constructor(owner:string,generation:bigint,original:PendingServerRequest,authority:CapturedResponseAuthority,payload:unknown,fence:ResponseFence|null,check:()=>void,render:(e:unknown)=>string){
    if(typeof owner!=="string"||/[\uD800-\uDFFF]/u.test(owner)||typeof generation!=="bigint"||generation<0n||generation>=(1n<<64n))throw new TypeError("Expected exact response owner");
    const captured=capture(authority);this.#hasAuthority=captured!==null;
    this.#claim=Object.freeze({ownerId:owner,generation,request:clonePendingServerRequest(original),authority:captured===null?null:captured.value,payload:cloneOwnedSerdeValue(payload)});this.#fence=fence===null?null:pinResponseFence(fence);
    for(const callback of [check,render])if(typeof callback!=="function"||types.isProxy(callback)||types.isAsyncFunction(callback)||types.isGeneratorFunction(callback))throw new TypeError("Expected synchronous response hooks");
    this.#check=()=>invokeSynchronousVoid(check,{},[]);this.#render=error=>{const value=render(error);if(types.isPromise(value))void Promise.prototype.then.call(value,undefined,()=>undefined);if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected response diagnostic");return value;};
  }
  begin():void{if(this.#begun||this.#finished)throw new TypeError("Response attempt already begun or finished");this.#begun=true;this.#check();if(this.#fence!==null&&this.#hasAuthority){this.#fence.beginResponse(this.#claim);this.#admitted=true;}}
  writeStarted():void{if(this.#finished)throw new TypeError("Response attempt already finished");this.#started=true;}
  finish(result:ResponseResult):ResponseResult{
    if(this.#finished)throw new TypeError("Response attempt already finished");
    const ok=serdeField(result,"ok");if(ok!==true&&ok!==false)throw new TypeError("Expected exact response result");result=ok?{ok:true}:{ok:false,error:serdeField(result,"error")};this.#finished=true;if(!this.#admitted)return result;
    const outcome=!this.#started?"not_sent":result.ok?"flushed":null;
    if(outcome!==null&&this.#fence!==null){try{this.#fence.finishResponse(Object.freeze({...this.#claim,outcome}));}catch(error){return {ok:false,error:this.#unknown(error)};}return result;}
    return result.ok?result:{ok:false,error:this.#unknown(result.error)};
  }
  #unknown(error:unknown):MutationOutcomeUnknownError{return new MutationOutcomeUnknownError("server/response",`${this.#render(error)}; original response admission retained; no automatic replay`);}
}
