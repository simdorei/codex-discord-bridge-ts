import {types} from "node:util";
import {AppServerClosedError} from "./client-errors.ts";
declare const permitBrand:unique symbol;
export interface ClientAdmissionPermit{readonly [permitBrand]:true;release():void}
interface PermitData{owner:ClientLifecycle;released:boolean;moved:boolean}
const permits=new WeakMap<object,PermitData>();
export class ClientLifecyclePoisonedError extends Error{readonly kind="LifecyclePoisoned";constructor(){super("client lifecycle gate is poisoned");this.name="ClientLifecyclePoisonedError";}}
export class ClientLifecycleReentryError extends Error{constructor(){super("client lifecycle callback must not reenter its gate");this.name="ClientLifecycleReentryError";}}
function text(value:unknown):asserts value is string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected lifecycle close reason");}
/** One execution-context gate, with explicit permit release instead of Rust Drop.
 * Callback failure poisons future admission; existing permits remain releasable. */
export class ClientLifecycle{
  #sealed=false;#inFlight=0n;#intent:string|null=null;#closed:string|null=null;#poisoned=false;#critical=false;
  readonly #waiters=new Set<(reason:string)=>void>();
  #lock():void{if(this.#poisoned)throw new ClientLifecyclePoisonedError();if(this.#critical)throw new ClientLifecycleReentryError();}
  snapshot(){return Object.freeze({sealed:this.#sealed,inFlight:this.#inFlight,closeIntent:this.#intent,closedReason:this.#closed,poisoned:this.#poisoned});}
  get pendingCloseWaiters():number{return this.#waiters.size;}
  admit():ClientAdmissionPermit{
    this.#lock();if(this.#sealed)throw new AppServerClosedError();if(this.#inFlight===(1n<<64n)-1n)throw new RangeError("client admission count overflow");this.#inFlight++;
    return this.#newPermit();
  }
  #newPermit():ClientAdmissionPermit{
    const data:PermitData={owner:this,released:false,moved:false};const permit=Object.freeze({release:()=>{
      if(data.released)return;if(data.moved)throw new TypeError("Client admission permit was transferred");if(this.#critical)throw new ClientLifecycleReentryError();
      if(this.#inFlight===0n)throw new RangeError("client admission count underflow");this.#inFlight--;data.released=true;
    }}) as ClientAdmissionPermit;permits.set(permit,data);return permit;
  }
  /** Ownership check only; sealed/poisoned permits are not new dispatch authority. */
  requirePermit(permit:ClientAdmissionPermit):void{const data=permit!==null&&typeof permit==="object"?permits.get(permit):undefined;if(data?.owner!==this||data.released||data.moved)throw new TypeError("Expected current owned client permit");}
  /** Transfer existing ownership without changing its count; old handle is revoked. */
  transferPermit(permit:ClientAdmissionPermit):ClientAdmissionPermit{this.requirePermit(permit);const next=this.#newPermit();permits.get(permit)!.moved=true;return next;}
  /** Cleanup-only TS adaptation: poisoning remains permanent for admission, but
   * cannot prevent sealing and releasing already-owned resources. Never reenters a
   * critical callback, clears poison, admits work, or reopens a sealed gate. */
  sealForCleanup(reason:string,asIntent=false):string{
    text(reason);if(typeof asIntent!=="boolean")throw new TypeError("Expected close intent flag");if(this.#critical)throw new ClientLifecycleReentryError();
    this.#sealed=true;if(asIntent&&this.#intent===null)this.#intent=reason;return this.#intent??reason;
  }
  seal():void{this.#lock();this.#sealed=true;}
  sealForClose(reason:string):void{text(reason);this.#lock();this.#sealed=true;if(this.#intent===null)this.#intent=reason;}
  sealAndResolveCloseReason(observed:string):string{text(observed);this.#lock();this.#sealed=true;return this.#intent??observed;}
  #run<T>(operation:()=>T):T{
    if(typeof operation!=="function"||types.isProxy(operation)||types.isAsyncFunction(operation)||types.isGeneratorFunction(operation))throw new TypeError("Lifecycle callback must be synchronous");
    this.#critical=true;
    try{const value=operation();if(types.isPromise(value)){void Promise.prototype.then.call(value,undefined,()=>undefined);throw new TypeError("Lifecycle callback must not return a Promise");}return value;}
    catch(error){this.#poisoned=true;throw error;}finally{this.#critical=false;}
  }
  withOpen<T>(operation:()=>T):T{this.#lock();if(this.#sealed)throw new AppServerClosedError();return this.#run(operation);}
  sealIfQuiescent(check:()=>boolean):boolean{
    this.#lock();if(this.#inFlight!==0n)return false;
    return this.#run(()=>{if(typeof check!=="function"||types.isProxy(check)||types.isAsyncFunction(check)||types.isGeneratorFunction(check))throw new TypeError("Quiescence check must be synchronous");const allowed=check();if(types.isPromise(allowed))void Promise.prototype.then.call(allowed,undefined,()=>undefined);if(typeof allowed!=="boolean")throw new TypeError("Quiescence check must return boolean");if(!allowed)return false;this.#sealed=true;return true;});
  }
  /** TRUSTED winning closer only, AFTER pending-response cleanup. This primitive
   * does not decide which closer won; future transport coordinator must enforce it. */
  publishClosed(reason:string):boolean{text(reason);if(!this.#sealed)throw new TypeError("Close publication requires a sealed gate");if(this.#closed!==null)return false;this.#closed=reason;for(const notify of this.#waiters)notify(reason);return true;}
  waitClosed(signal?:AbortSignal):Promise<string>{
    if(signal?.aborted)return Promise.reject(signal.reason);if(this.#closed!==null)return Promise.resolve(this.#closed);
    return new Promise((resolve,reject)=>{
      let done=false;const cleanup=()=>{this.#waiters.delete(notify);signal?.removeEventListener("abort",abort);};
      const notify=(reason:string)=>{if(done)return;done=true;cleanup();resolve(reason);};
      const abort=()=>{if(done)return;done=true;cleanup();reject(signal?.reason);};
      this.#waiters.add(notify);signal?.addEventListener("abort",abort,{once:true});
    });
  }
}
