/** Shared command boundary errors; adapters preserve raw underlying store/transport errors. */
export class InvalidActionRequestError extends Error{readonly kind="InvalidActionRequest";constructor(reason:string){super(`invalid command request: ${reason}`);this.name="InvalidActionRequestError";}}
export class MissingActionAppServerError extends Error{readonly kind="MissingAppServer";constructor(){super("resident Codex app-server is unavailable for this command");this.name="MissingActionAppServerError";}}
export class NoActionTargetError extends Error{readonly kind="NoTarget";constructor(){super("no Codex thread target is selected or mirrored for this channel");this.name="NoActionTargetError";}}
export class ActionIntegerRangeError extends Error{readonly kind="IntegerRange";constructor(){super("Discord identifier does not fit the SQLite integer contract");this.name="ActionIntegerRangeError";}}

import {types} from "node:util";
import {StoreIntegrityError} from "../../store/schema-assembly.ts";
import {invokeSynchronousVoid} from "../../core/synchronous-void.ts";
/** Selected-target failure inside a custody transaction is a Store error, not
 * an ordinary input rejection. Centralized source ActionError -> Store boundary. */
export function storeActionCheck(check:()=>void,render:(error:unknown)=>string):()=>void{
  for(const fn of [check,render])if(typeof fn!=="function"||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError("Expected synchronous custody check/diagnostic renderer");
  return ()=>{try{invokeSynchronousVoid(check,{},[]);}catch(error){const message=render(error);if(types.isPromise(message))void Promise.prototype.then.call(message,undefined,()=>undefined);if(typeof message!=="string"||/[\uD800-\uDFFF]/u.test(message))throw new TypeError("Expected public-safe custody diagnostic");throw new StoreIntegrityError(message);}};
}
