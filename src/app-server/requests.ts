import {types} from "node:util";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
export interface AppRequest{readonly method:string;readonly params:unknown;readonly timeoutMs:number}
const OBSERVATIONS=new Set(["account/rateLimits/read","account/usage/read","model/list","thread/list","thread/loaded/list","thread/read","thread/turns/list","thread/goal/get","mcpServerStatus/list"]);
/** Exact known observations only. Unknown methods/tool calls remain conservative. */
export function isObservationalRequest(method:string):boolean{return OBSERVATIONS.has(method);}
export type ServiceTierUpdate={readonly kind:"Unchanged"|"Clear"}|{readonly kind:"Set";readonly value:string};
export interface ThreadSettingsUpdate{readonly model:string|null;readonly effort:string|null;readonly effortClear:boolean;readonly serviceTier:ServiceTierUpdate}
export const DEFAULT_THREAD_SETTINGS_UPDATE:ThreadSettingsUpdate=Object.freeze({model:null,effort:null,effortClear:false,serviceTier:Object.freeze({kind:"Unchanged"})});
function text(value:unknown):asserts value is string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed request text");}
function timeout(value:unknown):asserts value is number{if(typeof value!=="number"||!Number.isSafeInteger(value)||value<0||value>2147483647)throw new RangeError("Unsupported native millisecond request timeout");}
function request(method:string,params:unknown,timeoutMs:number):AppRequest{timeout(timeoutMs);return Object.freeze({method,params:cloneOwnedSerdeValue(params),timeoutMs});}
/** Capture an entire DTO before any method-dependent authority decision. */
export function cloneAppRequest(input:unknown):AppRequest{
  const v=cloneOwnedSerdeValue(input);if(v===null||typeof v!=="object"||Array.isArray(v)||Object.keys(v).length!==3||!["method","params","timeoutMs"].every(k=>Object.hasOwn(v,k)))throw new TypeError("Expected exact own AppRequest fields");
  const r=v as AppRequest;text(r.method);timeout(r.timeoutMs);return r;
}
function threadRequest(method:string,threadId:string,timeoutMs:number):AppRequest{text(threadId);return request(method,{threadId},timeoutMs);}
function turnInput(prompt:string):unknown[]{text(prompt);return [{type:"text",text:prompt,text_elements:[]}];}
export function readThread(threadId:string,includeTurns:boolean):AppRequest{return readThreadWithTimeout(threadId,includeTurns,8000);}
export function readThreadWithTimeout(threadId:string,includeTurns:boolean,timeoutMs:number):AppRequest{text(threadId);if(typeof includeTurns!=="boolean")throw new TypeError("Expected includeTurns flag");return request("thread/read",{threadId,includeTurns},timeoutMs);}
export function getGoal(threadId:string):AppRequest{return threadRequest("thread/goal/get",threadId,8000);}
export function resumeThread(threadId:string):AppRequest{return resumeThreadWithTimeout(threadId,10000);}
export function resumeThreadWithTimeout(threadId:string,timeoutMs:number):AppRequest{return threadRequest("thread/resume",threadId,timeoutMs);}
export function forkThreadPersistent(threadId:string,timeoutMs:number):AppRequest{text(threadId);return request("thread/fork",{threadId,ephemeral:false},timeoutMs);}
export function startThread(cwd:string|null=null):AppRequest{if(cwd!==null)text(cwd);return request("thread/start",cwd===null?{}:{cwd},10000);}
export function updateThreadSettings(threadId:string,settings:ThreadSettingsUpdate=DEFAULT_THREAD_SETTINGS_UPDATE):AppRequest{
  text(threadId);const own=(object:unknown,name:string):unknown=>{if(object===null||typeof object!=="object"||types.isProxy(object))throw new TypeError("Expected settings data");const d=Object.getOwnPropertyDescriptor(object,name);if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own settings field");return d.value;};
  const model=own(settings,"model"),effort=own(settings,"effort"),clear=own(settings,"effortClear"),tier=own(settings,"serviceTier"),kind=own(tier,"kind");
  if(model!==null)text(model);if(effort!==null)text(effort);if(typeof clear!=="boolean")throw new TypeError("Expected effort clear flag");
  const params:Record<string,unknown>={threadId};if(model!==null)params.model=model;if(clear)params.effort=null;else if(effort!==null)params.effort=effort;
  if(kind==="Set"){const value=own(tier,"value");text(value);params.serviceTier=value;}else if(kind==="Clear")params.serviceTier=null;else if(kind!=="Unchanged")throw new TypeError("Unknown service tier update");
  return request("thread/settings/update",params,10000);
}
export function listModels():AppRequest{return request("model/list",{},8000);}
export function startTurn(threadId:string,prompt:string):AppRequest{return startTurnWithInput(threadId,turnInput(prompt));}
export function startTurnWithInput(threadId:string,input:readonly unknown[]):AppRequest{text(threadId);if(!Array.isArray(input))throw new TypeError("Expected turn input array");return request("turn/start",{threadId,input},12000);}
export function steerTurn(threadId:string,prompt:string,expectedTurnId:string):AppRequest{text(threadId);text(expectedTurnId);return request("turn/steer",{threadId,expectedTurnId,input:turnInput(prompt)},10000);}
export function interruptTurn(threadId:string,turnId:string):AppRequest{text(threadId);text(turnId);return request("turn/interrupt",{threadId,turnId},10000);}
export function archiveThread(threadId:string):AppRequest{return threadRequest("thread/archive",threadId,10000);}
export function cleanBackgroundTerminals(threadId:string):AppRequest{return threadRequest("thread/backgroundTerminals/clean",threadId,10000);}
export function unsubscribeThread(threadId:string):AppRequest{return threadRequest("thread/unsubscribe",threadId,8000);}
export function rateLimits():AppRequest{return request("account/rateLimits/read",{},15000);}
export function usage():AppRequest{return request("account/usage/read",{},15000);}
