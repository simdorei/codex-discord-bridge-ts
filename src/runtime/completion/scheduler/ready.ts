import {types} from "node:util";
import {requireDiscordText} from "../../../discord/text.ts";
import {snapshotCompletionEntry,sameCompletionIdentity,type CompletionEntry} from "../../../store/completion-metadata.ts";
import {completionSourceIsState} from "../../../store/completion-metadata-sql.ts";
export const COMPLETION_READY_CAP=128,COMPLETION_TARGET_CAP=16,COMPLETION_STATE_SLOTS=4,COMPLETION_NATIVE_SLOTS=3,COMPLETION_HTTP_SLOTS=4;
/** Trusted owned envelope adapter. Charging/notification decoding is a separate boundary.
 * dispose must synchronously release its byte permit exactly once and never throw. */
export interface ReadyLive<L>{readonly target:string;readonly needsNative:boolean;readonly payload:L;dispose():void}
export type ReadyStateWork<L>={readonly kind:"Live";readonly live:ReadyLive<L>}|{readonly kind:"Durable";readonly entry:CompletionEntry};
export interface ReadyAdmission<P>{readonly permit:P;readonly needsNative:boolean;release():void}
export interface AdmittedWork<L,P>{readonly work:ReadyStateWork<L>;readonly permit:P;readonly needsNative:boolean}
const target=<L>(work:ReadyStateWork<L>)=>work.kind==="Live"?work.live.target:work.entry.target;
/** In-memory hints only. No store mutation, RPC/HTTP, timers or retry maps. */
export class CompletionReady<L>{
  readonly #state:ReadyStateWork<L>[]=[];readonly #http:CompletionEntry[]=[];
  get length():number{return this.#state.length+this.#http.length;}
  get stateLength():number{return this.#state.length;}
  get httpLength():number{return this.#http.length;}
  stateSnapshot():readonly ReadyStateWork<L>[]{return Object.freeze([...this.#state]);}
  httpSnapshot():readonly CompletionEntry[]{return Object.freeze([...this.#http]);}
  live(input:ReadyLive<L>):boolean{
    requireDiscordText(input.target);if(typeof input.needsNative!=="boolean"||typeof input.dispose!=="function")throw new TypeError("Expected owned live adapter");
    const release=input.dispose;const event=Object.freeze({target:input.target,needsNative:input.needsNative,payload:input.payload,dispose:()=>release.call(input)});
    // Ownership transfers to this method, including disposal when rejected.
    for(let i=this.#state.length-1;i>=0;i--){const w=this.#state[i]!;if(w.kind==="Durable"&&w.entry.target===event.target)this.#state.splice(i,1);}
    if(this.#state.filter(w=>target(w)===event.target).length>=COMPLETION_TARGET_CAP){event.dispose();return false;}
    if(this.length>=COMPLETION_READY_CAP){const index=this.#state.findIndex(w=>w.kind==="Durable");if(index>=0)this.#state.splice(index,1);else if(this.#http.pop()===undefined){event.dispose();return false;}}
    this.#state.push(Object.freeze({kind:"Live",live:event}));return true;
  }
  durable(input:CompletionEntry,active:ReadonlySet<string>):void{
    if(this.length>=COMPLETION_READY_CAP)return;const entry=snapshotCompletionEntry(input);
    if(completionSourceIsState(entry.source)){
      if(active.has(entry.target)||this.#state.some(w=>target(w)===entry.target))return;
      this.#state.push(Object.freeze({kind:"Durable",entry}));
    }else if(!this.#http.some(e=>sameCompletionIdentity(e,entry)))this.#http.push(entry);
  }
  prioritize(input:CompletionEntry):void{
    const entry=snapshotCompletionEntry(input);
    for(let i=this.#http.length-1;i>=0;i--)if(sameCompletionIdentity(this.#http[i]!,entry))this.#http.splice(i,1);
    if(this.length>=COMPLETION_READY_CAP&&this.#http.pop()===undefined){const index=this.#state.findIndex(w=>w.kind==="Durable");if(index<0)return;this.#state.splice(index,1);}
    this.#http.unshift(entry);
  }
  /** Callback is trusted/synchronous. Disallowed native admission releases its permit
   * immediately; selected permit ownership transfers to caller until work settles. */
  takeStateAdmitted<P>(active:ReadonlySet<string>,native:number,admit:(work:ReadyStateWork<L>)=>ReadyAdmission<P>|null):AdmittedWork<L,P>|null{
    if(!Number.isSafeInteger(native)||native<0)throw new TypeError("Expected native active count");
    const heads=new Set<string>(),deferred:number[]=[];let chosen:AdmittedWork<L,P>|null=null;
    for(let index=0;index<this.#state.length;index++){
      const work=this.#state[index]!,key=target(work);if(heads.has(key))continue;heads.add(key);if(active.has(key))continue;
      const admission=admit(work);
      if(types.isPromise(admission)){void Promise.prototype.then.call(admission,undefined,()=>undefined);throw new TypeError("Admission callback must be synchronous");}
      if(admission===null){if(work.kind==="Durable")deferred.push(index);continue;}
      if(admission.needsNative&&native>=COMPLETION_NATIVE_SLOTS){admission.release();continue;}
      this.#state.splice(index,1);chosen={work,permit:admission.permit,needsNative:admission.needsNative};break;
    }
    for(let i=deferred.length-1;i>=0;i--)this.#state.splice(deferred[i]!,1);
    return chosen;
  }
  takeHttp(active:ReadonlyMap<bigint,unknown>):CompletionEntry|null{
    const index=this.#http.findIndex(e=>!active.has(e.channel));return index<0?null:this.#http.splice(index,1)[0]!;
  }
  /** Explicit shutdown disposal is required in JS; GC is not a Rust Drop guarantee. */
  dispose():void{for(const work of this.#state)if(work.kind==="Live")work.live.dispose();this.#state.length=0;this.#http.length=0;}
}
