import {types} from "node:util";
import {ResidentStateError} from "../app-server/resident-state.ts";
type Kind="MutationHeld"|"DeadGenerationFence";
/** One runtime boundary for source store-to-app-server error mapping. The supplied
 * renderer owns diagnostic redaction; this mapper never inspects arbitrary error fields. */
export function createRuntimeFenceErrors(render:(error:unknown)=>string){
  if(typeof render!=="function"||types.isProxy(render)||types.isAsyncFunction(render)||types.isGeneratorFunction(render))throw new TypeError("Expected synchronous public-safe diagnostic renderer");
  const fail=(kind:Kind,error:unknown):never=>{
    const message=render(error);if(types.isPromise(message))void Promise.prototype.then.call(message,undefined,()=>undefined);
    if(typeof message!=="string"||/[\uD800-\uDFFF]/u.test(message))throw new TypeError("Expected public-safe fence diagnostic");
    throw new ResidentStateError({kind,message});
  };
  return Object.freeze({fail,run:<T>(kind:Kind,operation:()=>T):T=>{try{return operation();}catch(error){return fail(kind,error);}}});
}
