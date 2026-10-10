import {types} from "node:util";
import {ServerRequestOccurrence,I64_MAX} from "../protocol/ids.ts";
import {clonePendingServerRequest} from "../app-server/server-request-state.ts";
import type {ResponseOwner,ResponseFence,DurableResponseClaim,DurableResponseCompletion} from "../app-server/response-attempt.ts";
import {createRuntimeFenceErrors} from "./fence-errors.ts";
import {StateAccessFacade} from "../store/state-access-facade.ts";
import type {ResponseCustodyScope} from "../store/response-custody.ts";

function own(value:unknown,key:string):unknown{
  if(value===null||typeof value!=="object"||types.isProxy(value))throw new TypeError("Expected owned response metadata");
  const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own response metadata field");return d.value;
}
function text(value:unknown):value is string{return typeof value==="string"&&!/[\uD800-\uDFFF]/u.test(value);}
/** Concrete response-only slice of Rust RuntimeDeadGenerationFence. Opens the existing
 * store for each synchronous capture/admission/completion, never creates/activates it.
 * Caller must separately install original mutation/stop/persistence fences. */
export function createResponseCustodyFence(path:string,runtime:string,renderError:(error:unknown)=>string):Required<ResponseFence>{
  if(!text(path)||!text(runtime)||runtime==="")throw new TypeError("Expected response store path and runtime identity");
  const errors=createRuntimeFenceErrors(renderError);
  const capture=StateAccessFacade.captureResponseCustody,begin=StateAccessFacade.beginResponseCustody,finish=StateAccessFacade.finishResponseCustody;
  const scope=(input:ResponseOwner):ResponseCustodyScope=>{
    const resident=own(input,"ownerId"),generation=own(input,"generation"),request=clonePendingServerRequest(own(input,"request") as ResponseOwner["request"]);
    if(!text(resident)||typeof generation!=="bigint"||generation<0n||generation>I64_MAX)throw new TypeError("Response generation does not fit signed i64");
    // Rust's transparent [u8;16] newtype serializes as JSON integers, not JS floats,
    // UUID text, a private class, or an object whose enumerable properties are empty.
    const occurrence=Array.from(ServerRequestOccurrence.prototype.asBytes.call(request.occurrence),byte=>BigInt(byte));
    return {runtime,resident,generation,request:{id:request.id,occurrence,method:request.method,params:request.params}};
  };
  const mapped=<T>(operation:()=>T):T=>errors.run("MutationHeld",operation);
  return Object.freeze({
    responseAuthority:(request:ResponseOwner)=>mapped(()=>Object.freeze({value:capture(path,scope(request))})),
    beginResponse:(claim:DurableResponseClaim)=>mapped(()=>begin(path,scope(claim),own(claim,"authority"),own(claim,"payload"))),
    finishResponse:(completion:DurableResponseCompletion)=>mapped(()=>finish(path,scope(completion),own(completion,"authority"),own(completion,"payload"),own(completion,"outcome") as string)),
  });
}
