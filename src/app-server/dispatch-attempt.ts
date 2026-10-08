import {randomUUID} from "node:crypto";
import {types} from "node:util";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {validateRequestId,type RequestId} from "../protocol/ids.ts";
import {MutationOutcomeUnknownError,type MaintenanceClaim,type MaintenanceCompletion,type MaintenanceMutationFence} from "./maintenance-attempt.ts";
import {ResidentStateError} from "./resident-state.ts";
import {isObservationalRequest} from "./requests.ts";
import {ownedRequestFailure} from "./request-client.ts";
import {serdeField,rustTrim} from "./value.ts";
export interface QueueMutationClaim extends Omit<MaintenanceClaim,"scoped"|"origin">{readonly claim:unknown}
export interface StopMutationClaim extends Omit<QueueMutationClaim,"method">{}
export interface StopMutationCompletion extends MaintenanceCompletion{readonly claim:unknown}
export interface DispatchMutationFence extends MaintenanceMutationFence{
  beginQueueMutation?(claim:QueueMutationClaim):boolean;
  beginStopMutation?(claim:StopMutationClaim):boolean;
  finishStopMutation?(completion:StopMutationCompletion):void;
}
export type DispatchResult={readonly ok:true;readonly value:unknown}|{readonly ok:false;readonly error:unknown};
export interface DispatchAttemptInput{
  readonly ownerId:string;readonly generation:bigint;readonly method:string;readonly params:unknown;
  readonly repair:boolean;readonly queueClaim:unknown|null;readonly stopClaim:unknown|null;readonly origin:unknown|null;
}
function sync(fn:Function,receiver:object,args:unknown[]):unknown{const result=Reflect.apply(fn,receiver,args);if(types.isPromise(result)){void Promise.prototype.then.call(result,undefined,()=>undefined);throw new TypeError("Dispatch fence must finish synchronously");}return result;}
function unsupported(message:string):never{throw new ResidentStateError({kind:"MutationHeld",message});}
/** Pin optional queue/stop methods with the source's fail-closed legacy defaults. */
export function pinDispatchMutationFence(input:DispatchMutationFence):Required<DispatchMutationFence>{
  if(input===null||typeof input!=="object"||types.isProxy(input))throw new TypeError("Expected dispatch fence");
  const method=(key:string,fallback?:Function):Function=>{const d=Object.getOwnPropertyDescriptor(input,key);if(d===undefined&&fallback)return fallback;if(!d||!Object.hasOwn(d,"value")||typeof d.value!=="function"||types.isProxy(d.value)||types.isAsyncFunction(d.value)||types.isGeneratorFunction(d.value))throw new TypeError("Expected own synchronous dispatch fence method");return d.value;};
  const begin=method("beginMutationWithOrigin"),finish=method("finishMutation"),queue=method("beginQueueMutation",()=>unsupported("durable fence does not support claimed queue dispatch")),stop=method("beginStopMutation",()=>unsupported("durable fence does not support original stop control")),finishStop=method("finishStopMutation",()=>unsupported("durable stop completion is not supported"));
  const bool=(f:Function,v:unknown):boolean=>{const r=sync(f,input,[v]);if(typeof r!=="boolean")throw new TypeError("Expected exact dispatch commitment boolean");return r;};
  const done=(f:Function,v:unknown):void=>{if(sync(f,input,[v])!==undefined)throw new TypeError("Expected synchronous void dispatch completion");};
  return Object.freeze({beginMutationWithOrigin:(c:MaintenanceClaim)=>bool(begin,c),finishMutation:(c:MaintenanceCompletion)=>done(finish,c),beginQueueMutation:(c:QueueMutationClaim)=>bool(queue,c),beginStopMutation:(c:StopMutationClaim)=>bool(stop,c),finishStopMutation:(c:StopMutationCompletion)=>done(finishStop,c)});
}
/** Ordinary dispatch attempt. A committed intent outlives caller cancellation; no
 * destructor/dispose path writes a fabricated result. The outer coordinator validates
 * original queue/stop claims before construction and retains the actual writer lease. */
export class DispatchAttempt{
  readonly #input:DispatchAttemptInput;readonly #fence:Required<DispatchMutationFence>|null;readonly #render:(e:unknown)=>string;readonly #id=randomUUID();readonly #scoped:boolean;
  #wire:RequestId|null=null;#started=false;#begun=false;#finished=false;
  constructor(input:DispatchAttemptInput,fence:DispatchMutationFence|null,render:(e:unknown)=>string){
    const raw=cloneOwnedSerdeValue(input),keys=["ownerId","generation","method","params","repair","queueClaim","stopClaim","origin"];
    if(raw===null||typeof raw!=="object"||Array.isArray(raw)||Object.keys(raw).length!==keys.length||keys.some(key=>!Object.hasOwn(raw,key)))throw new TypeError("Expected exact own dispatch metadata fields");
    const value=raw as DispatchAttemptInput;
    if(typeof value.ownerId!=="string"||typeof value.method!=="string"||typeof value.generation!=="bigint"||value.generation<0n||value.generation>=(1n<<64n)||typeof value.repair!=="boolean")throw new TypeError("Expected exact dispatch attempt identity");
    this.#input=value;this.#fence=fence===null?null:pinDispatchMutationFence(fence);
    if(typeof render!=="function"||types.isProxy(render)||types.isAsyncFunction(render)||types.isGeneratorFunction(render))throw new TypeError("Expected synchronous dispatch renderer");
    this.#render=e=>{const r=sync(render,{},[e]);if(typeof r!=="string"||/[\uD800-\uDFFF]/u.test(r))throw new TypeError("Expected public-safe dispatch diagnostic");return r;};
    const thread=serdeField(value.params,"threadId"),identified=typeof thread==="string"&&rustTrim(thread)!=="",known=["thread/resume","thread/settings/update","turn/start","turn/steer","thread/archive","thread/backgroundTerminals/clean","thread/unsubscribe"].includes(value.method)||(value.repair&&value.method==="mcpServer/tool/call");
    this.#scoped=identified&&(known||value.stopClaim!==null);
  }
  begin(wire:RequestId):void{
    if(this.#begun||this.#finished)throw new TypeError("Dispatch attempt already begun or finished");wire=validateRequestId(wire);this.#begun=true;const i=this.#input,f=this.#fence;
    if(isObservationalRequest(i.method)||(i.method==="turn/interrupt"&&i.stopClaim===null)||f===null)return;
    const owner={ownerId:i.ownerId,generation:i.generation,attemptId:this.#id,wire};let committed:boolean;
    if(i.stopClaim!==null)committed=f.beginStopMutation(Object.freeze({...owner,params:i.params,claim:i.stopClaim}));
    else if(i.queueClaim!==null)committed=f.beginQueueMutation(Object.freeze({...owner,method:i.method,params:i.params,claim:i.queueClaim}));
    else committed=f.beginMutationWithOrigin(Object.freeze({...owner,method:i.method,params:i.params,scoped:this.#scoped,origin:i.origin}));
    if(committed)this.#wire=wire;
  }
  writeStarted():void{if(this.#finished)throw new TypeError("Dispatch attempt already finished");this.#started=true;}
  wasStarted():boolean{return this.#started;}
  isolatesTarget():boolean{return this.#scoped&&this.#wire!==null;}
  finish(input:DispatchResult):DispatchResult{
    if(this.#finished)throw new TypeError("Dispatch attempt already finished");const ok=serdeField(input,"ok");if(ok!==true&&ok!==false)throw new TypeError("Expected exact dispatch result");
    const result:DispatchResult=ok?{ok:true,value:cloneOwnedSerdeValue(serdeField(input,"value"))}:{ok:false,error:serdeField(input,"error")};this.#finished=true;
    const i=this.#input,f=this.#fence,wire=this.#wire;if(wire===null||f===null)return result;
    const outcome=!this.#started?"not_sent":result.ok?"reply_ok":ownedRequestFailure(result.error)?.kind==="Remote"?"reply_error":null;
    if(outcome!==null){try{const completion:MaintenanceCompletion={ownerId:i.ownerId,generation:i.generation,attemptId:this.#id,wire,outcome};if(i.stopClaim!==null)f.finishStopMutation(Object.freeze({...completion,claim:i.stopClaim}));else f.finishMutation(Object.freeze(completion));}
      catch(error){return {ok:false,error:this.#unknown(`response/dispatch evidence could not be committed: ${this.#render(error)}`)};}return result;}
    return result.ok?result:{ok:false,error:this.#unknown(this.#render(result.error))};
  }
  #unknown(reason:string):MutationOutcomeUnknownError{return new MutationOutcomeUnknownError(this.#input.method,`${reason}; durable attempt ${this.#id} retained; no automatic replay`);}
}
