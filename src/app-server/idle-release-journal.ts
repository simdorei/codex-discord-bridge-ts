import {types} from "node:util";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {IdleObservationError} from "./notification-state.ts";
export interface IdleReleaseToken{readonly intentId:string;readonly ownerId:string;readonly generation:bigint;readonly threadId:string;readonly turnId:string;readonly jobId:string;readonly revision:bigint;readonly state:string;readonly detail:string}
/** Trusted synchronous durable adapter. Every transition must compare all identities
 * and commit before returning. Elapsed time/new owner ID cannot settle uncertain effects. */
export interface IdleReleaseJournal{
  tracksObservations?():boolean;
  recordObservationGap?(owner:string,generation:bigint):void;
  observeSourceUpper?(owner:string,generation:bigint,upper:bigint):void;
  observationScopeVerified?(owner:string,generation:bigint,through:bigint):boolean;
  beforeMutation(owner:string,generation:bigint,thread:string):IdleReleaseToken|null;
  checkMutation(thread:string):void;
  resumeRequired(thread:string):boolean;
  verify(token:IdleReleaseToken,requireIdle:boolean):void;
  transition(token:IdleReleaseToken,state:string,detail:string):IdleReleaseToken;
  oldChildExited(owner:string,generation:bigint):void;
}
export type PinnedIdleReleaseJournal=Required<IdleReleaseJournal>;
function text(value:string):void{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed idle journal text");}
function u64(value:bigint):void{if(typeof value!=="bigint"||value<0n||value>=(1n<<64n))throw new TypeError("Expected u64 idle journal value");}
function scope(owner:string,generation:bigint):void{text(owner);u64(generation);}

const keys=["intentId","ownerId","generation","threadId","turnId","jobId","revision","state","detail"];
export function cloneIdleReleaseToken(value:unknown):IdleReleaseToken{
  const v=cloneOwnedSerdeValue(value);if(v===null||typeof v!=="object"||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw new TypeError("Expected exact idle release token");
  const token=v as unknown as IdleReleaseToken;for(const key of ["intentId","ownerId","threadId","turnId","jobId","state","detail"] as const)if(typeof token[key]!=="string")throw new TypeError("Expected idle release token text");
  if(typeof token.generation!=="bigint"||token.generation<0n||token.generation>=(1n<<64n)||typeof token.revision!=="bigint"||token.revision<-(1n<<63n)||token.revision>=(1n<<63n))throw new TypeError("Expected exact idle release integer ranges");return token;
}
/** Pin an own-data function port once; class adapters must explicitly bind their methods.
 * Source default observation methods remain fail-closed, not permissive placeholders. */
export function pinIdleReleaseJournal(input:IdleReleaseJournal):PinnedIdleReleaseJournal{
  if(input===null||typeof input!=="object"||types.isProxy(input))throw new TypeError("Expected owned idle journal port");
  const field=(key:string,fallback?:Function):Function=>{const d=Object.getOwnPropertyDescriptor(input,key);if(d===undefined&&fallback)return fallback;if(!d||!Object.hasOwn(d,"value")||typeof d.value!=="function"||types.isProxy(d.value)||types.isAsyncFunction(d.value)||types.isGeneratorFunction(d.value))throw new TypeError("Idle journal requires own synchronous methods");return d.value;};
  const call=(fn:Function,args:unknown[]):unknown=>{const result=Reflect.apply(fn,input,args);if(types.isPromise(result)){void Promise.prototype.then.call(result,undefined,()=>undefined);throw new TypeError("Idle journal must finish synchronously");}return result;};
  const done=(fn:Function,args:unknown[])=>{if(call(fn,args)!==undefined)throw new TypeError("Idle journal void result required");};
  const boolean=(fn:Function,args:unknown[])=>{const result=call(fn,args);if(typeof result!=="boolean")throw new TypeError("Idle journal boolean result required");return result;};
  const tracks=field("tracksObservations",()=>false),gap=field("recordObservationGap",()=>{throw new IdleObservationError("durable observation journal unavailable");}),upper=field("observeSourceUpper",()=>{throw new IdleObservationError("source observation journal unavailable");}),verified=field("observationScopeVerified",()=>false),before=field("beforeMutation"),check=field("checkMutation"),resume=field("resumeRequired"),verify=field("verify"),transition=field("transition"),exited=field("oldChildExited");
  return Object.freeze({
    tracksObservations:()=>boolean(tracks,[]),
    recordObservationGap:(owner:string,generation:bigint)=>{scope(owner,generation);done(gap,[owner,generation]);},
    observeSourceUpper:(owner:string,generation:bigint,through:bigint)=>{scope(owner,generation);u64(through);done(upper,[owner,generation,through]);},
    observationScopeVerified:(owner:string,generation:bigint,through:bigint)=>{scope(owner,generation);u64(through);return boolean(verified,[owner,generation,through]);},
    beforeMutation:(owner:string,generation:bigint,thread:string)=>{scope(owner,generation);text(thread);const result=call(before,[owner,generation,thread]);return result===null?null:cloneIdleReleaseToken(result);},
    checkMutation:(thread:string)=>{text(thread);done(check,[thread]);},
    resumeRequired:(thread:string)=>{text(thread);return boolean(resume,[thread]);},
    verify:(token:IdleReleaseToken,idle:boolean)=>{if(typeof idle!=="boolean")throw new TypeError("Expected require-idle boolean");done(verify,[cloneIdleReleaseToken(token),idle]);},
    transition:(token:IdleReleaseToken,state:string,detail:string)=>{text(state);text(detail);return cloneIdleReleaseToken(call(transition,[cloneIdleReleaseToken(token),state,detail]));},
    oldChildExited:(owner:string,generation:bigint)=>{scope(owner,generation);done(exited,[owner,generation]);},
  });
}
