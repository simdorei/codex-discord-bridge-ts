import {serdeField} from "./value.ts";
import {invokeSynchronousVoid} from "../core/synchronous-void.ts";
import {types} from "node:util";
import {ClientLifecycle} from "./client-lifecycle.ts";
import {ClientRuntimeState} from "./runtime-state.ts";
import type {AppServerRequestClient} from "./request-client.ts";
export const APP_SERVER_INITIALIZE_TIMEOUT_MS=30000;
export const APP_SERVER_STARTUP_TIMEOUT_MS=45000;
export interface StartupClientInfo{readonly name:string;readonly title:string;readonly version:string}
export interface StartupObserver<T>{readonly value:T;dispose():void}
export interface SpawnedHandshakeSession{
  readonly gate:ClientLifecycle;readonly state:ClientRuntimeState;
  readonly client:Pick<AppServerRequestClient,"request"|"notify">;
  /** REQUIRED owned process+pipe/task cleanup, not merely logical close publication. */
  cleanupOwned():Promise<void>;
}
export class AppServerStartupCleanupError extends AggregateError{
  readonly primary:unknown;readonly cleanup:readonly unknown[];
  constructor(primary:unknown,cleanup:unknown[]){super([primary,...cleanup],"App-server startup failed and cleanup also failed");this.name="AppServerStartupCleanupError";this.primary=primary;this.cleanup=Object.freeze([...cleanup]);}
}
/** Handshake only AFTER owned spawn and BEFORE exposing initialized generation.
 * The observer is installed before initialize. Caller retains/cancels via AbortSignal;
 * abandoning a Promise is not Rust future Drop. Outer 45s spawn/cleanup budget is not
 * enforced here and is not permission to abandon an unfinished cleanup operation. */
export async function initializeObserved<T>(session:SpawnedHandshakeSession,info:StartupClientInfo,observe:()=>StartupObserver<T>,signal?:AbortSignal):Promise<StartupObserver<T>>{
  let observer:StartupObserver<T>|undefined,disposeObserver:(()=>void)|undefined;
  try{
    signal?.throwIfAborted();
    const clientInfo=Object.freeze({name:serdeField(info,"name"),title:serdeField(info,"title"),version:serdeField(info,"version")});
    for(const value of [clientInfo.name,clientInfo.title,clientInfo.version])if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed initialize client metadata");
    if(typeof observe!=="function"||types.isProxy(observe)||types.isAsyncFunction(observe)||types.isGeneratorFunction(observe))throw new TypeError("Startup observer installation must be synchronous");
    const installed=observe();if(types.isPromise(installed)){void Promise.prototype.then.call(installed,undefined,()=>undefined);throw new TypeError("Startup observer installation must not return a Promise");}
    if(installed===null||typeof installed!=="object"||types.isProxy(installed))throw new TypeError("Expected owned startup observer");
    const value=Object.getOwnPropertyDescriptor(installed,"value"),dispose=Object.getOwnPropertyDescriptor(installed,"dispose");
    if(!value||!Object.hasOwn(value,"value")||!dispose||!Object.hasOwn(dispose,"value")||typeof dispose.value!=="function"||types.isProxy(dispose.value)||types.isAsyncFunction(dispose.value)||types.isGeneratorFunction(dispose.value))throw new TypeError("Expected own observer value and synchronous disposer");
    observer=installed;const disposer=dispose.value;disposeObserver=()=>invokeSynchronousVoid(disposer,installed);
    await session.client.request("initialize",{clientInfo,capabilities:{experimentalApi:true}},APP_SERVER_INITIALIZE_TIMEOUT_MS,undefined,signal);
    await session.client.notify("initialized",{},signal);
    signal?.throwIfAborted();session.gate.withOpen(()=>session.state.commitInitialized());
    return observer;
  }catch(primary){
    const cleanup:unknown[]=[];
    try{await session.cleanupOwned();}catch(error){cleanup.push(error);}
    try{disposeObserver?.();}catch(error){cleanup.push(error);}
    if(cleanup.length!==0)throw new AppServerStartupCleanupError(primary,cleanup);throw primary;
  }
}
