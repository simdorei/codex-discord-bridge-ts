import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {validateRequestId,I64_MAX} from "../protocol/ids.ts";
import {extractThreadId} from "../app-server/identity.ts";
import {isObservationalRequest} from "../app-server/requests.ts";
import {createRuntimeFenceErrors} from "./fence-errors.ts";
import type {MaintenanceClaim,MaintenanceCompletion} from "../app-server/maintenance-attempt.ts";
import type {QueueMutationClaim,StopMutationClaim,StopMutationCompletion} from "../app-server/dispatch-attempt.ts";
import type {ResidentMaintenanceFence} from "../app-server/maintenance-transport.ts";
import {StateAccessFacade as state} from "../store/state-access-facade.ts";
import {DeadGenerationTargetHeldError} from "../store/queue-start-failure.ts";
import {createResponseCustodyFence} from "./response-custody-fence.ts";

function text(v:unknown):v is string{return typeof v==="string"&&!/[\uD800-\uDFFF]/u.test(v);}
function generation(g:unknown):asserts g is bigint{if(typeof g!=="bigint"||g<0n||g>I64_MAX)throw new RangeError("App-server generation does not fit signed i64");}
/** Concrete ordinary/queue/response fence for an ALREADY initialized and activated
 * runtime store. Original stop acceptance and dead-work persistence are separate. This adapter
 * consumes an already accepted/claimed stop and never creates user consent. */
export function createMutationCustodyFence(path:string,runtime:string,renderError:(error:unknown)=>string):ResidentMaintenanceFence{
  if(!text(path)||!text(runtime)||runtime==="")throw new TypeError("Expected mutation store and runtime identity");
  const errors=createRuntimeFenceErrors(renderError);
  // Pin the central operation references once; no caller can change an installed callback.
  const s={beginStop:state.beginStopWire,finishStop:state.finishStopWire,capture:state.captureStopOrigin,begin:state.beginChecked,finish:state.finish,validateQueue:state.validateQueueStartAuthorityIn,validateStop:state.validateStopRequestIn,checkMutation:state.checkMutationCustody,checkResponse:state.checkResponseCustody,checkResponses:state.checkAllResponseCustody,requireResponse:state.requireResponseUnheldIn,requireResponses:state.requireAllResponsesResolvedIn,requireStop:state.requireStopControlUnheldIn,stopHeld:state.stopControlTargetHeldExisting,targetHeld:state.deadGenerationTargetHeldExisting,sealed:state.deadGenerationSealedExisting};
  const mapped=<T>(kind:"MutationHeld"|"DeadGenerationFence",operation:()=>T):T=>errors.run(kind,operation);
  const claim=(raw:MaintenanceClaim|QueueMutationClaim,queued:boolean):boolean=>mapped("MutationHeld",()=>{
    const c=cloneOwnedSerdeValue(raw) as MaintenanceClaim&QueueMutationClaim;generation(c.generation);
    if(!text(c.ownerId)||!text(c.attemptId)||!text(c.method)||(!queued&&typeof c.scoped!=="boolean"))throw new TypeError("Expected exact mutation claim");
    const target=extractThreadId(c.params),wire=serializeSerdeValue(validateRequestId(c.wire));
    const payload=queued?{request:c.params,queueClaim:c.claim}:c.origin===null?c.params:{request:c.params,stopOrigin:c.origin};
    s.begin(path,{runtimeId:runtime,ownerId:c.ownerId,generation:c.generation,attemptId:c.attemptId,wireId:wire,method:c.method,targetThreadId:target,scoped:queued||c.scoped,payload},db=>{
      if(target!==null){s.requireStop(db,target);s.requireResponse(db,target);}else s.requireResponses(db);
      if(queued){if(c.method!=="turn/start")throw new Error("queue authority cannot authorize another mutation");s.validateQueue(db,c.claim,target??"",c.generation);}
      else s.validateStop(db,c.method,target,c.origin===null?undefined:c.origin);
      return undefined;
    });return true;
  });
  return Object.freeze({
    ...createResponseCustodyFence(path,runtime,renderError),
    requestOrigin:(method:string,input:unknown)=>mapped("MutationHeld",()=>{if(!text(method))throw new TypeError("Expected method");const params=cloneOwnedSerdeValue(input);return isObservationalRequest(method)||method==="turn/interrupt"?null:s.capture(path,extractThreadId(params));}),
    beginMutationWithOrigin:(c:MaintenanceClaim)=>claim(c,false),beginQueueMutation:(c:QueueMutationClaim)=>claim(c,true),
    beginStopMutation:(input:StopMutationClaim)=>mapped("MutationHeld",()=>{const c=cloneOwnedSerdeValue(input) as StopMutationClaim;generation(c.generation);s.beginStop(path,c.claim,{resident:c.ownerId,generation:c.generation},{attempt:c.attemptId,wire:serializeSerdeValue(validateRequestId(c.wire))},c.params);return true;}),
    finishStopMutation:(input:StopMutationCompletion)=>mapped("MutationHeld",()=>{const c=cloneOwnedSerdeValue(input) as StopMutationCompletion;generation(c.generation);s.finishStop(path,c.claim,{resident:c.ownerId,generation:c.generation},{attempt:c.attemptId,wire:serializeSerdeValue(validateRequestId(c.wire))},c.outcome);}),
    finishMutation:(input:MaintenanceCompletion)=>mapped("MutationHeld",()=>{const c=cloneOwnedSerdeValue(input) as MaintenanceCompletion;generation(c.generation);s.finish(path,{runtimeId:runtime,ownerId:c.ownerId,generation:c.generation,attemptId:c.attemptId,wireId:serializeSerdeValue(validateRequestId(c.wire)),outcome:c.outcome});}),
    checkRequest:(g:bigint,method:string,input:unknown)=>{
      if(!text(method))throw new TypeError("Expected method");const params=cloneOwnedSerdeValue(input),target=extractThreadId(params);
      if(!isObservationalRequest(method)&&method!=="turn/interrupt"&&method!=="server/response")mapped("MutationHeld",()=>{
        if(target!==null&&s.stopHeld(path,target))throw new Error("stop execution end is not confirmed");
        s.checkMutation(path,runtime,target);if(target!==null)s.checkResponse(path,target);else s.checkResponses(path);
      });
      if(!["thread/resume","thread/fork","turn/start","turn/steer"].includes(method))return;
      mapped("DeadGenerationFence",()=>{if(target!==null&&s.targetHeld(path,target))throw new DeadGenerationTargetHeldError(target);generation(g);if(s.sealed(path,g))throw new Error("app-server generation is durably sealed");});
    },
  });
}
