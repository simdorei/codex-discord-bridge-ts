import {types} from "node:util";
import {ownedRequestFailure} from "../app-server/request-client.ts";
import {ownedResidentFailure} from "../app-server/resident-state.ts";
import {ownedClientFailure} from "../app-server/client-errors.ts";
import {ownedIdleObservationFailure} from "../app-server/notification-state.ts";
import {isOwnedMutationOutcomeUnknown} from "../app-server/maintenance-attempt.ts";
import {isUsageLimitError} from "../app-server/outcomes.ts";
import {BackendFailureError} from "./queue-runner/errors.ts";
import {BackendFailureConstructors,type BackendFailure} from "./queue-runner/saved-submission.ts";
export type BackendOperation="read"|"resume"|"mutation"|"start"|"claimedStart";
/** Single backend boundary. Classification uses local provenance, not name/stack,
 * mutable messages or caller-provided error-shaped objects. Unknown JS failures
 * during mutations stay ambiguous; this is intentionally conservative beyond Rust's enum. */
export function createAppBackendErrors(render:(error:unknown)=>string){
  if(typeof render!=="function"||types.isProxy(render)||types.isAsyncFunction(render)||types.isGeneratorFunction(render))throw new TypeError("Expected synchronous public-safe backend diagnostic renderer");
  const failure=(operation:BackendOperation,error:unknown):BackendFailureError=>{
    const message=render(error);if(types.isPromise(message))void Promise.prototype.then.call(message,undefined,()=>undefined);if(typeof message!=="string"||/[\uD800-\uDFFF]/u.test(message))throw new TypeError("Expected well-formed backend diagnostic");
    const normal=(ambiguous=false,kind:BackendFailure["kind"]="Other")=>new BackendFailureError({message,ambiguous,kind});
    if(operation==="read")return normal();
    const resident=ownedResidentFailure(error),request=ownedRequestFailure(error),idle=ownedIdleObservationFailure(error),unknown=isOwnedMutationOutcomeUnknown(error);
    if(operation==="claimedStart"&&resident?.kind==="MutationHeld")return normal(true);
    if(resident?.kind==="MutationHeld"||(operation==="resume"&&unknown)||(idle!==null&&idle.includes("[cdr-rust:async-resolution-held:v1] ")))return new BackendFailureError(BackendFailureConstructors.executionHeld(message));
    if(operation==="resume")return request?.kind==="Remote"&&request.method==="thread/resume"&&request.code===-32600n&&request.message.includes("already has an active writer")?normal(false,"ActiveWriter"):normal();
    if((operation==="start"||operation==="claimedStart")&&request?.kind==="Remote"&&isUsageLimitError(request.data))return normal(false,"UsageLimit");
    if(request?.kind==="Remote"||resident!==null||idle!==null||ownedClientFailure(error)==="InvalidReply")return normal();
    return normal(true);
  };
  return Object.freeze({failure,run:async<T>(operation:BackendOperation,action:()=>Promise<T>,signal?:AbortSignal):Promise<T>=>{try{return await action();}catch(error){if(signal?.aborted&&error===signal.reason)throw error;throw failure(operation,error);}}});
}
