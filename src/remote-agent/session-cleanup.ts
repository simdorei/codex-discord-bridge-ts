import {types} from 'node:util';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
export interface RemoteSessionCleanupPorts {
 /** Each port must own actual native work and resolve only after it settles.
  * A deadline signal by itself is not completion. Ports create no authority. */
 readonly stopComputer:()=>Promise<void>;
 readonly closeTerminalWindows:()=>Promise<void>;
 readonly closeTerminals:()=>Promise<void>;
}
export type RemoteSessionCleanupFailure=Readonly<{component:'computer'|'windows'|'terminals';error:unknown}>;
export class RemoteSessionCleanupError extends AggregateError {
 readonly failures:readonly RemoteSessionCleanupFailure[];readonly primary:unknown;
 constructor(failures:readonly RemoteSessionCleanupFailure[]){super(failures.map(v=>v.error),'Remote session resource cleanup failed');this.name='RemoteSessionCleanupError';this.failures=Object.freeze([...failures]);this.primary=failures[0]?.error;}
}
function port(value:unknown,key:string):()=>Promise<void>{const v=own(value,key);if(typeof v!=='function'||types.isProxy(v)||types.isGeneratorFunction(v))throw new TypeError('Expected owned session cleanup port');return v as ()=>Promise<void>;}
/** Concrete cleanup custody around three borrowed native resource owners.
 * Source close_session tries computer stop, windows close and terminals close
 * in order even when an earlier phase fails. The first error remains primary.
 * Repeated/reentrant close shares the same receipt: it cannot dispatch duplicate
 * cleanup or pretend a pending native action has ended. No timer or forced
 * process kill is introduced here. Failure retains ports for diagnosis but is
 * not automatically retried, unlike a fresh source close_session invocation. */
export class RemoteSessionCleanupOwner {
 readonly #stop:()=>Promise<void>;readonly #windows:()=>Promise<void>;readonly #terminals:()=>Promise<void>;
 #closing:Promise<void>|null=null;#settled=false;#success=false;
 constructor(ports:RemoteSessionCleanupPorts){this.#stop=port(ports,'stopComputer');this.#windows=port(ports,'closeTerminalWindows');this.#terminals=port(ports,'closeTerminals');}
 close():Promise<void>{
  if(this.#closing!==null)return this.#closing;
  // Install ownership before calling any supplied function, including reentry.
  this.#closing=Promise.resolve().then(async()=>{
   const failures:RemoteSessionCleanupFailure[]=[];
   for(const [component,run] of [['computer',this.#stop],['windows',this.#windows],['terminals',this.#terminals]] as const){
    try{const result=run();if(!types.isPromise(result))throw new TypeError('Session cleanup port must return a Promise');await result;}
    catch(error){failures.push(Object.freeze({component,error}));}
   }
   this.#settled=true;if(failures.length)throw new RemoteSessionCleanupError(failures);this.#success=true;
  });return this.#closing;
 }
 snapshot(){return Object.freeze({started:this.#closing!==null,settled:this.#settled,success:this.#success});}
}
Object.freeze(RemoteSessionCleanupOwner.prototype);
