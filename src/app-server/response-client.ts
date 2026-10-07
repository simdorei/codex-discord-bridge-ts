import {responseValue,errorValue,type RequestId,type RpcErrorPayload} from "../protocol/rpc.ts";
import {ServerRequestOccurrence} from "../protocol/ids.ts";
import {invokeSynchronousVoid} from "../core/synchronous-void.ts";
import {ClientLifecycle} from "./client-lifecycle.ts";
import {ClientRuntimeState} from "./runtime-state.ts";
import {AppServerWriter} from "./writer.ts";
import {beginServerResponseClaim,type ServerResponseClaim} from "./server-response-claim.ts";
import type {PendingServerRequest} from "./server-request-state.ts";
export interface ResponseHooks{preflight():void;writeStarted():void}
const noHooks:ResponseHooks=Object.freeze({preflight(){},writeStarted(){}});
/** Caller wires the same lifecycle/state/writer owners as its request client. This
 * control surface never fabricates an occurrence or settles unknown delivery. */
export class AppServerResponseClient{
  readonly #gate:ClientLifecycle;readonly #state:ClientRuntimeState;readonly #writer:AppServerWriter;readonly #promote:(request:PendingServerRequest)=>void;
  constructor(gate:ClientLifecycle,state:ClientRuntimeState,writer:AppServerWriter,promote:(request:PendingServerRequest)=>void){this.#gate=gate;this.#state=state;this.#writer=writer;this.#promote=promote;}
  respond(id:RequestId,occurrence:ServerRequestOccurrence,result:unknown,hooks:ResponseHooks=noHooks,signal?:AbortSignal):Promise<void>{return this.#run(id,occurrence,()=>responseValue(id,result),false,hooks,signal);}
  respondError(id:RequestId,occurrence:ServerRequestOccurrence,error:RpcErrorPayload,hooks:ResponseHooks=noHooks,signal?:AbortSignal):Promise<void>{return this.#run(id,occurrence,()=>errorValue(id,error),false,hooks,signal);}
  respondCurrent(id:RequestId,occurrence:ServerRequestOccurrence,result:unknown,hooks:ResponseHooks=noHooks,signal?:AbortSignal):Promise<void>{return this.#run(id,occurrence,()=>responseValue(id,result),true,hooks,signal);}
  async #run(id:RequestId,occurrence:ServerRequestOccurrence,build:()=>unknown,current:boolean,hooks:ResponseHooks,signal?:AbortSignal):Promise<void>{
    const permit=this.#gate.admit();let claim:ServerResponseClaim|undefined;
    try{
      signal?.throwIfAborted();
      if(current){
        claim=await this.#writer.write(build(),{check:()=>{invokeSynchronousVoid(hooks.preflight,hooks);return beginServerResponseClaim(this.#state,id,occurrence,this.#promote,true);},dispose:owned=>owned.dispose()},()=>invokeSynchronousVoid(hooks.writeStarted,hooks),signal);
      }else{
        claim=beginServerResponseClaim(this.#state,id,occurrence,this.#promote);
        await this.#writer.write(build(),{check:()=>invokeSynchronousVoid(hooks.preflight,hooks),dispose(){}},()=>invokeSynchronousVoid(hooks.writeStarted,hooks),signal);
      }
      claim.resolve();
    }finally{try{claim?.dispose();}finally{permit.release();}}
  }
}
