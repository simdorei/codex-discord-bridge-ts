import {types} from "node:util";
import {ServerRequestOccurrence,type RequestId} from "../protocol/ids.ts";
import {ClientRuntimeState} from "./runtime-state.ts";
import type {PendingServerRequest} from "./server-request-state.ts";
export interface ServerResponseClaim{resolve():void;dispose():void}
/** Trusted response coordinator only: resolve AFTER confirmed owned write+flush.
 * Explicit finally-dispose substitutes for Rust Drop, preserving indeterminate claims.
 * Current-turn mode must begin inside serialized writer preflight, not before waiting. */
export function beginServerResponseClaim(state:ClientRuntimeState,id:RequestId,occurrence:ServerRequestOccurrence,enqueuePromoted:(request:PendingServerRequest)=>void,currentTurn=false):ServerResponseClaim{
  if(typeof currentTurn!=="boolean"||typeof enqueuePromoted!=="function"||types.isProxy(enqueuePromoted)||types.isAsyncFunction(enqueuePromoted)||types.isGeneratorFunction(enqueuePromoted))throw new TypeError("Expected synchronous promotion queue and claim mode");
  const ownedOccurrence=ServerRequestOccurrence.fromBytes(ServerRequestOccurrence.prototype.asBytes.call(occurrence));
  if(currentTurn)state.beginCurrentServerResponse(id,ownedOccurrence);else state.beginServerResponse(id,ownedOccurrence);
  let consumed=false;
  return Object.freeze({
    resolve(){
      if(consumed)throw new TypeError("Server response claim already consumed");
      const promoted=state.resolveServerRequest(id,ownedOccurrence);
      // State resolution already committed. A broken queue adapter must not replay it.
      consumed=true;
      if(promoted!==null){const queued:unknown=enqueuePromoted(promoted);if(queued!==undefined){if(types.isPromise(queued))void Promise.prototype.then.call(queued,undefined,()=>undefined);throw new TypeError("Promotion queue must return void synchronously");}}
    },
    dispose(){if(consumed)return;state.markServerResponseIndeterminate(id,ownedOccurrence);consumed=true;},
  });
}
