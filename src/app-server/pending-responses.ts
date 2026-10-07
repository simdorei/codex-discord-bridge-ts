import {isObservationalRequest} from "./requests.ts";
import {ClientLifecycle,type ClientAdmissionPermit} from "./client-lifecycle.ts";
import {requestIdKey,type RequestId} from "../protocol/ids.ts";
import type {ResponseResult} from "../protocol/rpc.ts";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
export type PendingOutcome={readonly kind:"Response";readonly result:ResponseResult}|{readonly kind:"TransportClosed";readonly reason:string}|{readonly kind:"Timeout"};
export class PendingRegistrationError extends Error{readonly kind="InvalidReply";constructor(detail:string){super(`invalid app-server reply: ${detail}`);this.name="PendingRegistrationError";}}
export class PendingReceiverClosedError extends Error{constructor(){super("pending response sender dropped");this.name="PendingReceiverClosedError";}}
export interface PendingRegistration{readonly result:Promise<PendingOutcome>;finish():void;dispose():void}
interface Entry{occurrence:symbol;permit:ClientAdmissionPermit;resolve:(outcome:PendingOutcome)=>void;reject:(error:unknown)=>void;timer:ReturnType<typeof setTimeout>|null}
/** Outgoing response ownership, separate from incoming server-request occurrences.
 * Producer must use fresh wire IDs. Deadlines/disposal are occurrence-scoped but wire
 * replies carry only ID. This is the bounded integer-millisecond timer profile. */
export class PendingResponses{
  readonly #entries=new Map<string,Entry>();readonly #lifecycle:ClientLifecycle;
  constructor(lifecycle:ClientLifecycle){this.#lifecycle=lifecycle;}
  get size():number{return this.#entries.size;}
  #take(key:string,occurrence?:symbol):Entry|undefined{const entry=this.#entries.get(key);if(entry===undefined||(occurrence!==undefined&&entry.occurrence!==occurrence))return undefined;this.#entries.delete(key);if(entry.timer!==null)clearTimeout(entry.timer);return entry;}
  #settle(entry:Entry,outcome:PendingOutcome|null):void{entry.permit.release();if(outcome===null)entry.reject(new PendingReceiverClosedError());else entry.resolve(Object.freeze(outcome));}
  /** Production callers derive cancellation behavior from the exact central method profile. */
  registerForMethod(id:RequestId,permit:ClientAdmissionPermit,waitMilliseconds:number,method:string):PendingRegistration{return this.register(id,permit,waitMilliseconds,isObservationalRequest(method));}
  /** Consumes a verified owned permit, including rejection cleanup. Do not release the old handle. */
  register(id:RequestId,permit:ClientAdmissionPermit,waitMilliseconds:number,observational:boolean):PendingRegistration{
    const ownedPermit=this.#lifecycle.transferPermit(permit);let accepted=false;let registered:{key:string;occurrence:symbol;entry:Entry}|null=null;
    try{
      const key=requestIdKey(id);if(!Number.isSafeInteger(waitMilliseconds)||waitMilliseconds<0||waitMilliseconds>2147483647||typeof observational!=="boolean")throw new TypeError("Unsupported pending response deadline/profile");
      if(this.#entries.size>=1024)throw new PendingRegistrationError("pending response capacity (1024) reached before dispatch");
      if(this.#entries.has(key))throw new PendingRegistrationError("pending response id is already registered; original request retained");
      let resolve!:(outcome:PendingOutcome)=>void,reject!:(error:unknown)=>void;
      const result=new Promise<PendingOutcome>((yes,no)=>{resolve=yes;reject=no;});
      // A dropped read receiver is expected cancellation, not an unhandled JS rejection.
      // Awaiters still receive the original rejection through this same result Promise.
      void result.catch(()=>undefined);
      const occurrence=Symbol(),entry:Entry={occurrence,permit:ownedPermit,resolve,reject,timer:null};this.#entries.set(key,entry);registered={key,occurrence,entry};
      const expire=()=>{const current=this.#take(key,occurrence);if(current!==undefined)this.#settle(current,{kind:"Timeout"});};
      if(waitMilliseconds===0)queueMicrotask(expire);else entry.timer=setTimeout(expire,waitMilliseconds);
      let removeOnDispose=observational,disposed=false;
      const registration=Object.freeze({result,finish(){if(disposed)throw new TypeError("Pending registration is already disposed");removeOnDispose=true;},dispose:()=>{
        if(disposed)return;disposed=true;if(removeOnDispose){const current=this.#take(key,occurrence);if(current!==undefined)this.#settle(current,null);}
      }});
      accepted=true;return registration;
    }finally{if(!accepted){if(registered!==null&&this.#take(registered.key,registered.occurrence)!==undefined)registered.entry.reject(new PendingReceiverClosedError());ownedPermit.release();}}
  }
  /** Validated response DTO from the wire parser, never raw unvalidated JSON. */
  respond(id:RequestId,result:ResponseResult):boolean{
    const key=requestIdKey(id);if(!this.#entries.has(key))return false;
    const owned=cloneOwnedSerdeValue(result) as ResponseResult,entry=this.#take(key)!;this.#settle(entry,{kind:"Response",result:owned});return true;
  }
  /** Trusted transport close drains existing requests before lifecycle close publication. */
  transportClosedAll(reason:string):void{
    if(typeof reason!=="string"||/[\uD800-\uDFFF]/u.test(reason))throw new TypeError("Expected transport close reason");
    const entries=[...this.#entries.values()];this.#entries.clear();for(const entry of entries){if(entry.timer!==null)clearTimeout(entry.timer);this.#settle(entry,{kind:"TransportClosed",reason});}
  }
}
