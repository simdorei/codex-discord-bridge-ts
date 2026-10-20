import {types} from "node:util";
import {classify,type IncomingMessage} from "../protocol/rpc.ts";
import {parseLosslessJson,type RequestId} from "../protocol/ids.ts";
import {rustDebugString} from "../core/rust-debug.ts";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {ClientLifecycle} from "./client-lifecycle.ts";
import {AppServerClosedError} from "./client-errors.ts";
import {ClientRuntimeState} from "./runtime-state.ts";
import {PendingResponses} from "./pending-responses.ts";
import {BoundedDiagnostics} from "./diagnostics.ts";
import {ServerRequestRecordError,type PendingServerRequest} from "./server-request-state.ts";
import type {AppNotification} from "./notification-state.ts";
import {rustTrim} from "./value.ts";

export interface TransportDispatchPorts{
  /** Trusted synchronous queue insertion only, never subscriber code or async I/O.
   * No listeners is a successful no-op; adapter exceptions are programming failures. */
  enqueueServerRequest(request:PendingServerRequest):void;
  enqueueNotification(notification:AppNotification):void;
  /** Required passive, public-safe renderer. TS parser errors are not Rust Display parity. */
  renderParseError(stage:"json"|"rpc",error:unknown):string;
}
function debugId(id:RequestId):string{return typeof id==="string"?`String(${rustDebugString(id)})`:`Integer(${id})`;}
function preview(line:string):string{let count=0,end=0;for(const char of line){if(count++===200)break;end+=char.length;}return line.slice(0,end);}
function queued(value:unknown):void{if(value===undefined)return;if(types.isPromise(value))void Promise.prototype.then.call(value,undefined,()=>undefined);throw new TypeError("Transport queue adapter must return void synchronously");}
/** Dispatch one decoded UTF-8 line. Does not frame bytes, own pipes, spawn a child,
 * or prove native EOF/exit. Adapters must share these exact lifecycle/state owners. */
export class TransportLineDispatcher{
  readonly #gate:ClientLifecycle;readonly #state:ClientRuntimeState;readonly #pending:PendingResponses;
  readonly #diagnostics:BoundedDiagnostics;readonly #ports:TransportDispatchPorts;
  constructor(gate:ClientLifecycle,state:ClientRuntimeState,pending:PendingResponses,diagnostics:BoundedDiagnostics,ports:TransportDispatchPorts){this.#gate=gate;this.#state=state;this.#pending=pending;this.#diagnostics=diagnostics;this.#ports=ports;}
  #open<T>(operation:()=>T,rejected:string):{value:T}|undefined{
    let entered=false;
    try{return {value:this.#gate.withOpen(()=>{entered=true;return operation();})};}
    catch(error){
      // Only the gate's pre-callback seal rejection is a dropped incoming message.
      // Callback failures (even a thrown ClosedError) remain visible and poison it.
      if(!entered&&this.#gate.snapshot().sealed&&!this.#gate.snapshot().poisoned&&error!==null&&typeof error==="object"&&!types.isProxy(error)&&error instanceof AppServerClosedError){this.#diagnostics.push(rejected);return undefined;}
      throw error;
    }
  }
  #errorText(stage:"json"|"rpc",error:unknown):string{
    const rendered=this.#ports.renderParseError(stage,error);
    if(typeof rendered!=="string"||/[\uD800-\uDFFF]/u.test(rendered))throw new TypeError("Expected public-safe diagnostic text");
    return rendered;
  }
  handleStdoutLine(line:string):void{
    if(typeof line!=="string"||/[\uD800-\uDFFF]/u.test(line))throw new TypeError("Expected decoded well-formed stdout line");
    if(rustTrim(line)==="")return;
    let value:unknown,message:IncomingMessage;
    try{value=parseLosslessJson(line);}catch(error){this.#diagnostics.push(`non-JSON stdout (${this.#errorText("json",error)}): ${preview(line)}`);return;}
    try{message=classify(value);}catch(error){this.#diagnostics.push(`invalid JSON-RPC message: ${this.#errorText("rpc",error)}`);return;}
    switch(message.kind){
      case "ignored":this.#diagnostics.push("ignored non-object app-server message");return;
      case "response":{
        const response=message,selected=this.#open(()=>this.#pending.takeResponse(response.id),`response rejected after lifecycle seal: ${debugId(response.id)}`);
        if(selected===undefined)return;
        const claim=selected.value;if(claim===undefined){this.#diagnostics.push(`late or unknown response id: ${debugId(response.id)}`);return;}
        try{claim.respond(response.result);}finally{claim.dispose();}return;
      }
      case "serverRequest":{
        const request=message;
        this.#open(()=>{
          let outcome;
          try{outcome=this.#state.recordServerRequest(request);}catch(error){
            if(error===null||typeof error!=="object"||types.isProxy(error)||!(error instanceof ServerRequestRecordError))throw error;
            this.#diagnostics.push(error.kind==="Conflict"?`conflicting pending server request id: ${debugId(error.id)}; canonical payload retained`:`server request capacity saturated at 500 unresolved occurrences; rejected id: ${debugId(error.id)}`);return;
          }
          if(outcome.kind==="Broadcast")queued(this.#ports.enqueueServerRequest(outcome.request));
        },`server request rejected after lifecycle seal: ${debugId(request.id)}`);return;
      }
      case "notification":{
        const notification=Object.freeze({method:message.method,params:cloneOwnedSerdeValue(message.params)});
        this.#open(()=>{this.#state.recordNotification(notification);queued(this.#ports.enqueueNotification(notification));},`notification rejected after lifecycle seal: ${notification.method}`);return;
      }
    }
  }
}
