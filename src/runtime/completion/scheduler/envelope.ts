import {extractThreadId as extractCompletionThreadId} from "../../../app-server/identity.ts";
import {serdeField} from "../../../app-server/value.ts";
import {boundedSerdeByteCount} from "../../../core/serde-byte-count.ts";
import type {ReadyLive} from "./ready.ts";
export const COMPLETION_EVENT_BYTES=4*1024*1024;
export interface CompletionNotification{readonly kind:"Notification";readonly generation:bigint;readonly notification:{readonly method:string;readonly params:unknown}}
export {extractThreadId as extractCompletionThreadId} from "../../../app-server/identity.ts";
function freezeOwned(value:unknown,seen=new Set<object>()):void{
  if(value===null||typeof value!=="object"||seen.has(value))return;seen.add(value);
  for(const name of Object.getOwnPropertyNames(value)){const d=Object.getOwnPropertyDescriptor(value,name)!;if(Object.hasOwn(d,"value"))freezeOwned(d.value,seen);}Object.freeze(value);
}
/** Logical owned serialized-byte semaphore. Caller transfers params ownership on
 * success: they are frozen. Dispose only after no worker retains/uses that payload.
 * This does not bound V8 heap overhead or provide Rust ownership/Drop enforcement. */
export class CompletionEventBudget{
  readonly capacity:number;#used=0;
  constructor(capacity=COMPLETION_EVENT_BYTES){if(!Number.isSafeInteger(capacity)||capacity<0||capacity>COMPLETION_EVENT_BYTES)throw new RangeError("Expected event budget at most 4MiB");this.capacity=capacity;}
  get availableBytes():number{return this.capacity-this.#used;}
  chargeOwned(input:unknown):ReadyLive<CompletionNotification>|null{
    if(serdeField(input,"kind")!=="Notification")return null;
    const generation=serdeField(input,"generation"),notification=serdeField(input,"notification"),method=serdeField(notification,"method"),params=serdeField(notification,"params");
    if(typeof generation!=="bigint"||generation<0n||generation>=(1n<<64n)||typeof method!=="string"||/[\uD800-\uDFFF]/u.test(method))return null;
    const target=extractCompletionThreadId(params);if(target===null||Buffer.byteLength(target,"utf8")>4096||/[\uD800-\uDFFF]/u.test(target))return null;
    const base=Math.max(1,Buffer.byteLength(method,"utf8")+Buffer.byteLength(target,"utf8"));if(base>this.availableBytes)return null;
    const body=boundedSerdeByteCount(params,this.availableBytes-base);if(body===null)return null;
    try{freezeOwned(params);}catch{return null;}
    const bytes=base+body;this.#used+=bytes;let released=false;
    const payload:CompletionNotification=Object.freeze({kind:"Notification",generation,notification:Object.freeze({method,params})});
    const needsNative=method==="thread/goal/updated"||(method==="turn/completed"&&serdeField(serdeField(params,"turn"),"status")==="completed");
    return Object.freeze({target,needsNative,payload,dispose:()=>{if(!released){released=true;this.#used-=bytes;}}});
  }
}
