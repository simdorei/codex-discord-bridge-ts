import {types} from "node:util";
import {ServerRequestOccurrence,requestIdKey,validateRequestId,type RequestId} from "../protocol/ids.ts";
import {boundedSerdeByteCount} from "../core/serde-byte-count.ts";
import {serdeValueEqual} from "../core/serde-value-equal.ts";
import {rustDebugString} from "../core/rust-debug.ts";
import {extractThreadId} from "./identity.ts";
export interface PendingServerRequest{readonly id:RequestId;readonly occurrence:ServerRequestOccurrence;readonly method:string;readonly params:unknown}
export type ServerRequestRecordOutcome={readonly kind:"Broadcast";readonly request:PendingServerRequest}|{readonly kind:"Duplicate"|"Deferred"};
export class ServerRequestRecordError extends Error{readonly kind:"Conflict"|"Saturated";readonly id:RequestId;constructor(kind:"Conflict"|"Saturated",id:RequestId){super(`Server request ${kind.toLowerCase()}`);this.name="ServerRequestRecordError";this.kind=kind;this.id=id;}}
export class ServerResponseStateError extends Error{
  readonly kind:"StaleServerRequest"|"ServerRequestResponseInFlight"|"ServerRequestResponseIndeterminate";readonly id:RequestId;
  constructor(kind:ServerResponseStateError["kind"],id:RequestId){const debug=typeof id==="string"?`String(${rustDebugString(id)})`:`Integer(${id})`;super(`app-server request ${debug} ${kind==="StaleServerRequest"?"is stale or no longer pending":kind==="ServerRequestResponseInFlight"?"already has a response in flight":"response delivery is indeterminate"}`);this.name="ServerResponseStateError";this.kind=kind;this.id=id;}
}
function occurrenceHex(value:ServerRequestOccurrence):string{return Buffer.from(ServerRequestOccurrence.prototype.asBytes.call(value)).toString("hex");}
function freeze(value:unknown):void{if(value===null||typeof value!=="object")return;for(const name of Object.getOwnPropertyNames(value)){const d=Object.getOwnPropertyDescriptor(value,name)!;if(Object.hasOwn(d,"value"))freeze(d.value);}Object.freeze(value);}
function copy(input:PendingServerRequest):PendingServerRequest{
  if(input===null||typeof input!=="object"||types.isProxy(input))throw new TypeError("Expected server request record");
  const field=(name:string):unknown=>{const d=Object.getOwnPropertyDescriptor(input,name);if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own request field");return d.value;};
  const id=validateRequestId(field("id")),method=field("method"),params=field("params"),occurrence=field("occurrence") as ServerRequestOccurrence;
  if(typeof method!=="string"||/[\uD800-\uDFFF]/u.test(method)||boundedSerdeByteCount(params,Number.MAX_SAFE_INTEGER)===null)throw new TypeError("Expected decoded Serde request metadata");
  const token=ServerRequestOccurrence.fromBytes(ServerRequestOccurrence.prototype.asBytes.call(occurrence));Object.freeze(token);const owned=structuredClone(params);freeze(owned);return Object.freeze({id,occurrence:token,method,params:owned});
}
interface Key{idKey:string;occurrence:string;key:string}
const key=(id:RequestId,occurrence:ServerRequestOccurrence):Key=>{const idKey=requestIdKey(id),hex=occurrenceHex(occurrence);return {idKey,occurrence:hex,key:JSON.stringify([idKey,hex])};};
const same=(a:PendingServerRequest,b:PendingServerRequest)=>a.method===b.method&&serdeValueEqual(a.params,b.params);
/** One execution-context owner. No wire response or dead-generation clear authority.
 * Reads return immutable snapshots; unknown/in-flight responses remain unsettled. */
export class ServerRequestState{
  readonly #order:Key[]=[];readonly #pending=new Map<string,PendingServerRequest>();readonly #claimed=new Map<string,{request:PendingServerRequest;status:"Responding"|"Indeterminate"}>();readonly #deferred=new Map<string,PendingServerRequest>();
  get unsettledCount():number{return this.#order.length;}
  get hasUnsettled():boolean{return this.#pending.size>0||this.#claimed.size>0||this.#deferred.size>0;}
  #capacity(id:RequestId):void{if(this.#order.length>=500)throw new ServerRequestRecordError("Saturated",id);}
  record(input:PendingServerRequest):ServerRequestRecordOutcome{
    const request=copy(input),k=key(request.id,request.occurrence),existing=this.#pending.get(k.idKey);
    if(existing!==undefined){if(same(existing,request))return {kind:"Duplicate"};throw new ServerRequestRecordError("Conflict",request.id);}
    const claimed=[...this.#claimed.values()].find(c=>requestIdKey(c.request.id)===k.idKey);
    if(claimed!==undefined){
      if(same(claimed.request,request))return {kind:"Duplicate"};const deferred=this.#deferred.get(k.idKey);
      if(deferred!==undefined){if(same(deferred,request))return {kind:"Deferred"};throw new ServerRequestRecordError("Conflict",request.id);}
      this.#capacity(request.id);this.#order.push(k);this.#deferred.set(k.idKey,request);return {kind:"Deferred"};
    }
    this.#capacity(request.id);this.#order.push(k);this.#pending.set(k.idKey,request);return {kind:"Broadcast",request};
  }
  responseCandidate(id:RequestId,occurrence:ServerRequestOccurrence):PendingServerRequest{
    const k=key(id,occurrence),claimed=this.#claimed.get(k.key);if(claimed!==undefined)throw new ServerResponseStateError(claimed.status==="Responding"?"ServerRequestResponseInFlight":"ServerRequestResponseIndeterminate",id);
    const pending=this.#pending.get(k.idKey);if(pending===undefined||occurrenceHex(pending.occurrence)!==k.occurrence)throw new ServerResponseStateError("StaleServerRequest",id);return pending;
  }
  beginResponse(id:RequestId,occurrence:ServerRequestOccurrence):void{const request=this.responseCandidate(id,occurrence),k=key(id,occurrence);this.#pending.delete(k.idKey);this.#claimed.set(k.key,{request,status:"Responding"});}
  markIndeterminate(id:RequestId,occurrence:ServerRequestOccurrence):void{const claimed=this.#claimed.get(key(id,occurrence).key);if(claimed?.status==="Responding")claimed.status="Indeterminate";}
  resolve(id:RequestId,occurrence:ServerRequestOccurrence):PendingServerRequest|null{
    const k=key(id,occurrence);if(!this.#claimed.delete(k.key))throw new ServerResponseStateError("StaleServerRequest",id);
    for(let i=this.#order.length-1;i>=0;i--)if(this.#order[i]!.key===k.key)this.#order.splice(i,1);
    const promoted=this.#deferred.get(k.idKey);this.#deferred.delete(k.idKey);if(promoted!==undefined)this.#pending.set(k.idKey,promoted);return promoted??null;
  }
  #request(k:Key):PendingServerRequest|undefined{const pending=this.#pending.get(k.idKey);if(pending!==undefined&&occurrenceHex(pending.occurrence)===k.occurrence)return pending;const claimed=this.#claimed.get(k.key);if(claimed!==undefined)return claimed.request;const deferred=this.#deferred.get(k.idKey);return deferred!==undefined&&occurrenceHex(deferred.occurrence)===k.occurrence?deferred:undefined;}
  pending(thread:string|null=null):PendingServerRequest[]{return this.#order.flatMap(k=>{const r=this.#pending.get(k.idKey);return r!==undefined&&occurrenceHex(r.occurrence)===k.occurrence&&(thread===null||extractThreadId(r.params)===thread)?[r]:[];});}
  unsettled(thread:string|null=null):PendingServerRequest[]{return this.#order.flatMap(k=>{const r=this.#request(k);return r!==undefined&&(thread===null||extractThreadId(r.params)===thread)?[r]:[];});}
}
