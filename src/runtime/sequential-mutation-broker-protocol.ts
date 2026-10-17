import {Buffer} from 'node:buffer';
import {types} from 'node:util';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {validateRequestId} from '../protocol/ids.ts';
import type {QueueMutationClaim,StopMutationClaim} from '../app-server/dispatch-attempt.ts';
import type {MaintenanceClaim} from '../app-server/maintenance-attempt.ts';

/** Inactive, closed persistence-observation protocol. No dispatch authority. */
export interface SequentialMutationBrokerLimits {
 readonly maxOperationId:number; readonly maxExchangeId:number; readonly phaseObservationTimeoutMs:number;
 readonly maxClaimUtf8Bytes:number; readonly maxClaimStringUnits:number;
 readonly maxClaimNodes:number; readonly maxClaimEdges:number;
 readonly maxClaimDepth:number; readonly maxContainerEntries:number;
 readonly maxNativeResultUtf8Bytes:number;
 readonly maxRetainedLogicalBytes:number; readonly maxRetainedNodes:number; readonly maxRetainedEdges:number;
 readonly nativeTimeoutMs:number; readonly handshakeTimeoutMs:number;
 readonly exchangeTimeoutMs:number; readonly preparedAwaitFinishTimeoutMs:number;
 readonly terminalRetentionMs:number; readonly minStatusIntervalMs:number;
}
export type SequentialMutationOperation='ordinary'|'queue'|'stop';
export type SequentialMutationClaim=MaintenanceClaim|QueueMutationClaim|StopMutationClaim;
export type SequentialMutationOutcome='not_sent'|'reply_ok'|'reply_error';
export type SequentialMutationBrokerRequestBody=
 | Readonly<{kind:'ready'|'stop-new-work'|'abort'|'close-idle'}>
 | Readonly<{kind:'begin';operationId:number;operation:SequentialMutationOperation;claim:SequentialMutationClaim}>
 | Readonly<{kind:'status'|'ack-begin'|'ack-terminal';operationId:number}>
 | Readonly<{kind:'finish';operationId:number;outcome:SequentialMutationOutcome}>;
export type SequentialMutationBrokerReplyBody=
 | Readonly<{kind:'ready';retiredThrough:0}>
 | Readonly<{kind:'closing'|'stopped-new-work'}>
 | Readonly<{kind:'accepted'|'pending';operationId:number;phase:'begin'|'finish'}>
 | Readonly<{kind:'begin-confirmed'|'begin-acknowledged';operationId:number}>
 | Readonly<{kind:'terminal';operationId:number;result:'finish-confirmed'|'unknown'}>
 | Readonly<{kind:'retired';operationId:number;retiredThrough:number;accepting:boolean}>
 | Readonly<{kind:'rejected';reason:'rate-limited'}>;
export interface SequentialMutationBrokerEnvelope<T> {readonly version:2;readonly epoch:string;readonly exchange:number;readonly body:T}
export interface SequentialMutationBrokerReservation {
 readonly lifecycleLogicalBytes:number; readonly lifecycleNodes:number; readonly lifecycleEdges:number;
 readonly rootLogicalBytes:number; readonly rootNodes:number; readonly rootEdges:number;
}
const LIMIT_KEYS=[ 'maxOperationId','maxExchangeId','phaseObservationTimeoutMs','maxClaimUtf8Bytes','maxClaimStringUnits','maxClaimNodes','maxClaimEdges','maxClaimDepth','maxContainerEntries','maxNativeResultUtf8Bytes','maxRetainedLogicalBytes','maxRetainedNodes','maxRetainedEdges','nativeTimeoutMs','handshakeTimeoutMs','exchangeTimeoutMs','preparedAwaitFinishTimeoutMs','terminalRetentionMs','minStatusIntervalMs' ] as const;
const CLAIM_KEYS={ordinary:['ownerId','generation','attemptId','wire','method','params','scoped','origin'],queue:['ownerId','generation','attemptId','wire','method','params','claim'],stop:['ownerId','generation','attemptId','wire','params','claim']} as const;
const fail=():never=>{throw new TypeError('Invalid bounded mutation protocol value');};
function record(value:unknown,keys:readonly string[]):Record<string,unknown>|null {
 if(value===null||typeof value!=='object'||types.isProxy(value)||Array.isArray(value))return null;
 const p=Object.getPrototypeOf(value);if(p!==Object.prototype&&p!==null)return null;
 if(Object.getOwnPropertySymbols(value).length!==0)return null;
 const names=Object.getOwnPropertyNames(value);if(names.length!==keys.length)return null;
 for(const name of names){if(!keys.includes(name))return null;const d=Object.getOwnPropertyDescriptor(value,name);if(!d||!Object.hasOwn(d,'value')||!d.enumerable)return null;}
 return value as Record<string,unknown>;
}
function field(value:object,key:string):unknown {const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,'value')||!d.enumerable)fail();return d!.value;}
function positive(v:unknown):v is number{return typeof v==='number'&&Number.isSafeInteger(v)&&v>0;}
function epochValid(v:unknown):v is string{return typeof v==='string'&&/^[a-f0-9]{32}$/.test(v);}
interface Bounds {bytes:number;strings:number;nodes:number;edges:number;depth:number;entries:number}
/** Expanded occurrences count aliases repeatedly; the active ancestry alone rejects cycles.
 * Keys are reflected only after proxy rejection. Reflection/engine allocations are not a heap claim. */
function measure(value:unknown,b:Bounds):Bounds {
 const out:Bounds={bytes:0,strings:0,nodes:0,edges:0,depth:0,entries:0};
 const add=(k:'bytes'|'strings'|'nodes'|'edges',n:number)=>{if(n>b[k]-out[k])fail();out[k]+=n;};
 const string=(s:string)=>{add('strings',s.length);add('bytes',2);for(const char of s){const cp=char.codePointAt(0)!;if(cp>=0xd800&&cp<=0xdfff)fail();add('bytes',cp===34||cp===92?2:cp<32?([8,9,10,12,13].includes(cp)?2:6):Buffer.byteLength(char));}};
 type Frame={value:unknown;depth:number}|{exit:object};
 const stack:Frame[]=[{value,depth:1}],ancestors=new Set<object>();
 while(stack.length){const f=stack.pop()!;if('exit' in f){ancestors.delete(f.exit);continue;}
  if(f.depth>b.depth)fail();out.depth=Math.max(out.depth,f.depth);add('nodes',1);const v=f.value;
  if(v===null){add('bytes',4);continue;}
  if(typeof v==='string'){string(v);continue;}
  if(typeof v==='boolean'){add('bytes',v?4:5);continue;}
  if(typeof v==='bigint'&&(v< -9223372036854775808n||v>18446744073709551615n))fail();
  if(typeof v==='number'&&!Number.isFinite(v))fail();
  if(typeof v==='number'||typeof v==='bigint'){add('bytes',serializeSerdeValue(v).length);continue;}
  if(typeof v!=='object'||types.isProxy(v)||ancestors.has(v))fail();
  const obj=v as object;if(Object.getOwnPropertySymbols(obj).length)fail();
  const array=Array.isArray(obj),proto=Object.getPrototypeOf(obj);
  if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)fail();
  const names=Object.getOwnPropertyNames(obj);
  const length=array?Object.getOwnPropertyDescriptor(obj,'length')?.value:names.length;
  if(!Number.isSafeInteger(length)||length<0||length>b.entries||array&&names.length!==length+1)fail();
  // Each child consumes one node even before its own descendants are visited.
  if(length>b.nodes-out.nodes||length>b.edges-out.edges)fail();
  out.entries=Math.max(out.entries,length);add('edges',length);add('bytes',2+Math.max(0,length-1));
  ancestors.add(obj);stack.push({exit:obj});
  for(let i=length-1;i>=0;i--){const key=array?String(i):names[i]!;const child=field(obj,key);if(!array){string(key);add('bytes',1);}stack.push({value:child,depth:f.depth+1});}
 }
 return out;
}
function claimBounds(l:SequentialMutationBrokerLimits):Bounds{return {bytes:l.maxClaimUtf8Bytes,strings:l.maxClaimStringUnits,nodes:l.maxClaimNodes,edges:l.maxClaimEdges,depth:l.maxClaimDepth,entries:l.maxContainerEntries};}
function checkClaim(operation:SequentialMutationOperation,value:unknown,l:SequentialMutationBrokerLimits):void {
 if(operation!=='ordinary'&&operation!=='queue'&&operation!=='stop')fail();
 measure(value,claimBounds(l));const c=record(value,CLAIM_KEYS[operation]);if(!c)fail();
 for(const key of (operation==='stop'?['ownerId','attemptId']:['ownerId','attemptId','method'])){const s=c![key];if(typeof s!=='string'||s.includes('\0')||Buffer.byteLength(s)>4096||(key!=='ownerId'&&s===''))fail();}
 if(typeof c!.generation!=='bigint'||c!.generation<0n||c!.generation>9223372036854775807n||operation==='ordinary'&&typeof c!.scoped!=='boolean'||operation==='queue'&&c!.method!=='turn/start')fail();
 validateRequestId(c!.wire);
}
export function captureSequentialMutationClaim(operation:SequentialMutationOperation,value:unknown,limits:SequentialMutationBrokerLimits):SequentialMutationClaim {
 checkClaim(operation,value,limits);const captured=structuredClone(value) as SequentialMutationClaim;
 const stack:unknown[]=[captured];while(stack.length){const v=stack.pop();if(v!==null&&typeof v==='object'){for(const key of Object.keys(v))stack.push(field(v,key));Object.freeze(v);}}
 return captured;
}
function checked(n:bigint):number {if(n<0n||n>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Mutation reservation overflow');return Number(n);}
export function calculateSequentialMutationBrokerReservation(l:SequentialMutationBrokerLimits):SequentialMutationBrokerReservation {
 if(!record(l,LIMIT_KEYS))fail();
 for(const k of LIMIT_KEYS)if(!positive(l[k]))throw new RangeError('Invalid mutation limit');
 const C=2n*BigInt(l.maxClaimStringUnits)+BigInt(l.maxClaimUtf8Bytes)+8n*BigInt(l.maxClaimNodes),R=3n*BigInt(l.maxNativeResultUtf8Bytes)+32n;
 return Object.freeze({lifecycleLogicalBytes:checked(6n*C+4n*R+16n*2048n),lifecycleNodes:checked(6n*BigInt(l.maxClaimNodes)+4n*4n+16n*16n),lifecycleEdges:checked(6n*BigInt(l.maxClaimEdges)+4n*3n+16n*16n),rootLogicalBytes:3*16384,rootNodes:3*64,rootEdges:3*64});
}
/** Minimum uses the shortest legal RequestId (0n), two nonempty identity bytes,
 * and shortest passive params/origin (0n). Root depth is one, leaves depth two. */
function inspectSequentialMutationBrokerLimits(value:unknown):SequentialMutationBrokerLimits {
 const r=record(value,LIMIT_KEYS);if(!r)fail();
 for(const k of LIMIT_KEYS)if(!positive(r![k]))throw new RangeError('Invalid mutation limit');
 const l=r as unknown as SequentialMutationBrokerLimits;
 if(l.maxClaimUtf8Bytes>1048576||l.maxClaimStringUnits>1048576||l.maxClaimNodes>65536||l.maxClaimEdges>65536||l.maxClaimDepth>64||l.maxContainerEntries>65536||l.maxContainerEntries>l.maxClaimEdges||l.maxNativeResultUtf8Bytes<11||l.maxNativeResultUtf8Bytes>16384||l.nativeTimeoutMs>10000)throw new RangeError('Mutation limit exceeds boundary');
 for(const k of ['phaseObservationTimeoutMs','maxOperationId','maxExchangeId','handshakeTimeoutMs','exchangeTimeoutMs','preparedAwaitFinishTimeoutMs','terminalRetentionMs','minStatusIntervalMs'] as const)if(l[k]>2147483647)throw new RangeError('Mutation timer exceeds boundary');
 checkClaim('ordinary',{ownerId:'',generation:0n,attemptId:'a',wire:0n,method:'a',params:0n,scoped:true,origin:0n},l);
 const reservation=calculateSequentialMutationBrokerReservation(l);
 if(l.maxRetainedLogicalBytes<reservation.lifecycleLogicalBytes||l.maxRetainedNodes<reservation.lifecycleNodes||l.maxRetainedEdges<reservation.lifecycleEdges)throw new RangeError('Insufficient mutation lifecycle reservation');
 verifyLargestFrames();return l;
}
export function validateSequentialMutationBrokerLimits(value:unknown):SequentialMutationBrokerLimits {
 const l=inspectSequentialMutationBrokerLimits(value);
 return Object.freeze({...l});
}
const counter=(v:unknown):v is number=>positive(v)&&v<=2147483647;
function envelope(value:unknown,epoch:string):Record<string,unknown>|null {
 const e=record(value,['version','epoch','exchange','body']);return e&&e.version===2&&epochValid(epoch)&&e.epoch===epoch&&counter(e.exchange)?e:null;
}
const frameBounds:Bounds={bytes:2048,strings:2048,nodes:16,edges:16,depth:4,entries:8};
export function validateSequentialMutationRequest(value:unknown,epoch:string,l:SequentialMutationBrokerLimits):SequentialMutationBrokerEnvelope<SequentialMutationBrokerRequestBody>|null {
 try{
  const e=envelope(value,epoch);if(!e||Number(e.exchange)>l.maxExchangeId||e.body===null||typeof e.body!=='object'||types.isProxy(e.body))return null;
  const kind=field(e.body,'kind');let b:Record<string,unknown>|null;
  if(kind==='begin'){
   b=record(e.body,['kind','operationId','operation','claim']);if(!b||!counter(b.operationId)||b.operationId>l.maxOperationId||!['ordinary','queue','stop'].includes(b.operation as string))return null;
   checkClaim(b.operation as SequentialMutationOperation,b.claim,l);
   measure(value,{bytes:l.maxClaimUtf8Bytes+2048,strings:l.maxClaimStringUnits+2048,nodes:l.maxClaimNodes+16,edges:l.maxClaimEdges+16,depth:l.maxClaimDepth+2,entries:Math.max(l.maxContainerEntries,4)});
  }else{
   if(kind==='finish'){
    b=record(e.body,['kind','operationId','outcome']);if(!b||!['not_sent','reply_ok','reply_error'].includes(b.outcome as string))return null;
   }else if(['status','ack-begin','ack-terminal'].includes(kind as string))b=record(e.body,['kind','operationId']);
   else if(['ready','stop-new-work','abort','close-idle'].includes(kind as string))b=record(e.body,['kind']);
   else return null;
   if(!b||Object.hasOwn(b,'operationId')&&(!counter(b.operationId)||b.operationId>l.maxOperationId))return null;
   measure(value,frameBounds);
  }
  return value as SequentialMutationBrokerEnvelope<SequentialMutationBrokerRequestBody>;
 }catch{return null;}
}
export function validateSequentialMutationReply(value:unknown,epoch:string):SequentialMutationBrokerEnvelope<SequentialMutationBrokerReplyBody>|null {
 try{
  measure(value,frameBounds);const e=envelope(value,epoch);if(!e||e.body===null||typeof e.body!=='object')return null;
  const kind=field(e.body,'kind');let b:Record<string,unknown>|null;
  switch(kind){
   case 'ready':b=record(e.body,['kind','retiredThrough']);if(!b||b.retiredThrough!==0)return null;break;
   case 'closing':case 'stopped-new-work':b=record(e.body,['kind']);break;
   case 'accepted':case 'pending':b=record(e.body,['kind','operationId','phase']);if(!b||!['begin','finish'].includes(b.phase as string))return null;break;
   case 'begin-confirmed':case 'begin-acknowledged':b=record(e.body,['kind','operationId']);break;
   case 'terminal':b=record(e.body,['kind','operationId','result']);if(!b||!['finish-confirmed','unknown'].includes(b.result as string))return null;break;
   case 'retired':b=record(e.body,['kind','operationId','retiredThrough','accepting']);if(!b||!counter(b.retiredThrough)||typeof b.accepting!=='boolean')return null;break;
   case 'rejected':b=record(e.body,['kind','reason']);if(!b||b.reason!=='rate-limited')return null;break;
   default:return null;
  }
  if(!b||Object.hasOwn(b,'operationId')&&!counter(b.operationId))return null;
  return value as SequentialMutationBrokerEnvelope<SequentialMutationBrokerReplyBody>;
 }catch{return null;}
}
/** Validate every maximum-width fixed frame against the existing metadata allowance. */
function verifyLargestFrames():void {
 const n=2147483647,epoch='f'.repeat(32),bodies:SequentialMutationBrokerReplyBody[]=[{kind:'ready',retiredThrough:0},{kind:'closing'},{kind:'stopped-new-work'},{kind:'begin-confirmed',operationId:n},{kind:'begin-acknowledged',operationId:n},{kind:'rejected',reason:'rate-limited'}];
 for(const phase of ['begin','finish'] as const)for(const kind of ['accepted','pending'] as const)bodies.push({kind,phase,operationId:n});
 for(const result of ['finish-confirmed','unknown'] as const)bodies.push({kind:'terminal',operationId:n,result});
 for(const accepting of [true,false])bodies.push({kind:'retired',operationId:n,retiredThrough:n,accepting});
 for(const body of bodies)if(!validateSequentialMutationReply({version:2,epoch,exchange:n,body},epoch))throw new RangeError('Sequential mutation reply exceeds fixed allowance');
 const requests:SequentialMutationBrokerRequestBody[]=[{kind:'ready'},{kind:'stop-new-work'},{kind:'abort'},{kind:'close-idle'}];
 for(const kind of ['status','ack-begin','ack-terminal'] as const)requests.push({kind,operationId:n});
 for(const outcome of ['not_sent','reply_ok','reply_error'] as const)requests.push({kind:'finish',operationId:n,outcome});
 for(const body of requests)measure({version:2,epoch,exchange:n,body},frameBounds);
 // Begin's claim is charged separately; this verifies its remaining fixed frame.
 measure({version:2,epoch,exchange:n,body:{kind:'begin',operationId:n,operation:'ordinary',claim:null}},frameBounds);
}
export function validateSequentialMutationNativeResult(value:unknown,limits:SequentialMutationBrokerLimits):boolean {
 try{measure(value,{bytes:limits.maxNativeResultUtf8Bytes,strings:limits.maxNativeResultUtf8Bytes,nodes:4,edges:3,depth:2,entries:2});const r=record(value,['ok']);return r!==null&&r.ok===true;}catch{return false;}
}
export function validateSequentialMutationBootstrapDescriptor(epoch:string,limits:SequentialMutationBrokerLimits):void {
 if(!epochValid(epoch))fail();const l=inspectSequentialMutationBrokerLimits(limits);
 measure({kind:'sequential-mutation-broker-bootstrap',version:2,epoch,limits:l},{bytes:4096,strings:4096,nodes:64,edges:64,depth:3,entries:64});
}
export function sequentialMutationExchangeReservation(l:SequentialMutationBrokerLimits):number {
 const statusCount=Math.floor(l.phaseObservationTimeoutMs/l.minStatusIntervalMs)+1;
 return checked(2n*(BigInt(statusCount)+2n)+2n);
}
