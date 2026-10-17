import {types} from 'node:util';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';

/** INACTIVE successful-value codec only. No endpoint, native submission, error
 * transport, admission proof or PromptAuthority is created by these functions.
 * Future use must retain original native envelope checks and joined ownership. */
export type PersistentPromptReadRequest =
 | Readonly<{op:'observed-completion';thread:string;turn:string}>
 | Readonly<{op:'all-jobs'}>
 | Readonly<{op:'channel-mapping';channel:bigint|null}>;

/** Exact camelCase native success shape, not the snake_case storage serializer. */
export interface PersistentPromptReadJob {
 readonly jobId:string;readonly targetThreadId:string;readonly channelId:bigint;
 readonly ownerUserId:bigint|null;readonly discordMessageId:bigint|null;
 readonly appServerGeneration:bigint;readonly executionGeneration:bigint|null;
 readonly turnObservationGeneration:bigint|null;readonly goalWaiting:boolean;
 readonly prompt:string;readonly queued:boolean;readonly ackSent:boolean;
 readonly state:'Pending'|'Starting'|'Running'|'Quarantined';readonly attemptCount:bigint;
 readonly turnId:string|null;readonly baselineTurnIds:readonly string[];
 readonly lastError:string;readonly createdAt:number;readonly updatedAt:number;
}
export type PersistentPromptReadSuccess =
 | Readonly<{op:'observed-completion';value:boolean}>
 | Readonly<{op:'all-jobs';value:readonly PersistentPromptReadJob[]}>
 | Readonly<{op:'channel-mapping';value:string|null}>;

export const PERSISTENT_PROMPT_READ_VALUE_LIMITS=Object.freeze({
 observedIdentityBytes:16384,nativeObservedEnvelopeBytes:262144,nativeResultEnvelopeBytes:16777216,
});
const JOB_KEYS=Object.freeze(['jobId','targetThreadId','channelId','ownerUserId','discordMessageId',
 'appServerGeneration','executionGeneration','turnObservationGeneration','goalWaiting','prompt',
 'queued','ackSent','state','attemptCount','turnId','baselineTurnIds','lastError','createdAt','updatedAt']);
const I64_MIN=-(1n<<63n),I64_MAX=(1n<<63n)-1n;
function invalid():never{throw new TypeError('Invalid inactive prompt-read value');}
function record(value:unknown):Record<string,unknown>{
 if(value===null||typeof value!=='object'||types.isProxy(value)||Array.isArray(value))invalid();
 const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)invalid();
 return value as Record<string,unknown>;
}
function field(value:object,key:string):unknown{
 const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,'value')||!d.enumerable)invalid();return d.value;
}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
 const object=record(value),actual=Reflect.ownKeys(object);
 if(actual.length!==keys.length||actual.some(key=>typeof key!=='string'||!keys.includes(key)))invalid();
 for(const key of keys)field(object,key);return object;
}
function text(value:unknown):asserts value is string{
 if(typeof value!=='string')invalid();
 for(const char of value){const cp=char.codePointAt(0)!;if(cp>=0xd800&&cp<=0xdfff)invalid();}
}
function integer(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<I64_MIN||value>I64_MAX)invalid();}
function optionalInteger(value:unknown):void{if(value!==null)integer(value);}
function array(value:unknown):asserts value is unknown[]{
 if(value===null||typeof value!=='object'||types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)invalid();
 const length=Object.getOwnPropertyDescriptor(value,'length')?.value;
 if(!Number.isSafeInteger(length)||length<0||Reflect.ownKeys(value).length!==length+1)invalid();
 for(let i=0;i<length;i++)field(value,String(i));
}
function job(value:unknown):void{
 const row=exact(value,JOB_KEYS);
 for(const key of ['jobId','targetThreadId','prompt','lastError'])text(row[key]);
 for(const key of ['channelId','appServerGeneration','attemptCount'])integer(row[key]);
 for(const key of ['ownerUserId','discordMessageId','executionGeneration','turnObservationGeneration'])optionalInteger(row[key]);
 for(const key of ['goalWaiting','queued','ackSent'])if(typeof row[key]!=='boolean')invalid();
 if(!['Pending','Starting','Running','Quarantined'].includes(row.state as string))invalid();
 if(row.turnId!==null)text(row.turnId);array(row.baselineTurnIds);for(const item of row.baselineTurnIds)text(item);
 // The native result's Serde byte check already rejects nonfinite timestamps.
 for(const key of ['createdAt','updatedAt'])if(typeof row[key]!=='number'||!Number.isFinite(row[key]))invalid();
}
function bounded(value:unknown,limit:number):void{if(boundedSerdeByteCount(value,limit)===null)invalid();}

/** Path-free data validation, NOT native admission. In particular, observed's
 * original 262,144-byte frame also includes the pinned path and generated UUID;
 * only the original owner can check that full frame. Empty/NUL text is retained. */
export function capturePersistentPromptReadRequest(input:unknown):PersistentPromptReadRequest{
 const initial=record(input),op=field(initial,'op');let request:Record<string,unknown>;
 if(op==='observed-completion'){
  request=exact(initial,['op','thread','turn']);
  for(const key of ['thread','turn']){const value=request[key];text(value);if(Buffer.byteLength(value,'utf8')>PERSISTENT_PROMPT_READ_VALUE_LIMITS.observedIdentityBytes)invalid();}
 }else if(op==='all-jobs')request=exact(initial,['op']);
 else if(op==='channel-mapping'){request=exact(initial,['op','channel']);optionalInteger(request.channel);}
 else invalid();
 return cloneOwnedSerdeValue(request) as PersistentPromptReadRequest;
}

/** Capture only a success matching the exact operation. Native-equivalent
 * result wrappers retain their existing byte caps; this new op/value wrapper
 * is not charged against those caps. No row/field truncation or partial result.
 * Logical serialized size is not a native/SQLite/structured-clone heap bound. */
export function capturePersistentPromptReadSuccess(request:unknown,input:unknown):PersistentPromptReadSuccess{
 const original=capturePersistentPromptReadRequest(request),result=exact(input,['op','value']);
 if(result.op!==original.op)invalid();const value=result.value;
 switch(original.op){
  case 'observed-completion':if(typeof value!=='boolean')invalid();break;
  case 'all-jobs':
   bounded({ok:true,value},PERSISTENT_PROMPT_READ_VALUE_LIMITS.nativeResultEnvelopeBytes);
   array(value);for(const row of value)job(row);break;
  case 'channel-mapping':
   if(value!==null)text(value);
   if((original.channel===null||original.channel===0n)&&value!==null)invalid();
   bounded({ok:true,operation:'MirrorTarget',value:{channel:original.channel,target:value}},PERSISTENT_PROMPT_READ_VALUE_LIMITS.nativeResultEnvelopeBytes);break;
 }
 return cloneOwnedSerdeValue(result) as PersistentPromptReadSuccess;
}
