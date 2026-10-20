import {Buffer} from 'node:buffer';
import {types} from 'node:util';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {validateRequestId} from '../protocol/ids.ts';
import type {MaintenanceClaim} from '../app-server/maintenance-attempt.ts';

/** Inactive, closed persistence-observation protocol. No dispatch authority. */
export interface MutationBrokerLimits {
 readonly maxClaimUtf8Bytes:number; readonly maxClaimStringUnits:number;
 readonly maxClaimNodes:number; readonly maxClaimEdges:number;
 readonly maxClaimDepth:number; readonly maxContainerEntries:number;
 readonly maxNativeResultUtf8Bytes:number;
 readonly maxRetainedLogicalBytes:number; readonly maxRetainedNodes:number; readonly maxRetainedEdges:number;
 readonly nativeTimeoutMs:number; readonly handshakeTimeoutMs:number;
 readonly exchangeTimeoutMs:number; readonly preparedAwaitFinishTimeoutMs:number;
 readonly terminalRetentionMs:number; readonly minStatusIntervalMs:number;
}
export type MutationBrokerRequestBody=
 | Readonly<{kind:'ready'|'status'|'ack-begin'|'cancel'|'ack-terminal'|'close'}>
 | Readonly<{kind:'begin';claim:MaintenanceClaim}>
 | Readonly<{kind:'finish';beginSequence:number;outcome:'not_sent'|'reply_ok'|'reply_error'}>;
export type MutationBrokerReplyBody=
 | Readonly<{kind:'ready'|'closing'}>
 | Readonly<{kind:'accepted';phase:'begin'|'finish';beginSequence:number}>
 | Readonly<{kind:'pending';phase:'begin'|'finish';beginSequence:number;closing:boolean}>
 | Readonly<{kind:'begin-confirmed';beginSequence:number}>
 | Readonly<{kind:'acknowledged';phase:'begin'|'terminal'}>
 | Readonly<{kind:'terminal';beginSequence:number|null;result:'finish-confirmed'|'unknown'|'not-submitted'}>
 | Readonly<{kind:'rejected';reason:'malformed'|'wrong-state'|'capacity'|'closed'|'rate-limited'}>;
export interface MutationBrokerEnvelope<T> {readonly version:1;readonly epoch:string;readonly exchange:number;readonly body:T}
export interface MutationBrokerReservation {
 readonly lifecycleLogicalBytes:number; readonly lifecycleNodes:number; readonly lifecycleEdges:number;
 readonly rootLogicalBytes:number; readonly rootNodes:number; readonly rootEdges:number;
}
const LIMIT_KEYS=[ 'maxClaimUtf8Bytes','maxClaimStringUnits','maxClaimNodes','maxClaimEdges','maxClaimDepth','maxContainerEntries','maxNativeResultUtf8Bytes','maxRetainedLogicalBytes','maxRetainedNodes','maxRetainedEdges','nativeTimeoutMs','handshakeTimeoutMs','exchangeTimeoutMs','preparedAwaitFinishTimeoutMs','terminalRetentionMs','minStatusIntervalMs' ] as const;
const CLAIM_KEYS=['ownerId','generation','attemptId','wire','method','params','scoped','origin'] as const;
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
function claimBounds(l:MutationBrokerLimits):Bounds{return {bytes:l.maxClaimUtf8Bytes,strings:l.maxClaimStringUnits,nodes:l.maxClaimNodes,edges:l.maxClaimEdges,depth:l.maxClaimDepth,entries:l.maxContainerEntries};}
function checkClaim(value:unknown,l:MutationBrokerLimits):void {
 measure(value,claimBounds(l));const c=record(value,CLAIM_KEYS);if(!c)fail();
 for(const key of ['ownerId','attemptId','method']){const s=c![key];if(typeof s!=='string'||s.includes('\0')||Buffer.byteLength(s)>4096||(key!=='ownerId'&&s===''))fail();}
 if(typeof c!.generation!=='bigint'||c!.generation<0n||c!.generation>9223372036854775807n||typeof c!.scoped!=='boolean')fail();
 validateRequestId(c!.wire);
}
export function captureMutationClaim(value:unknown,limits:MutationBrokerLimits):MaintenanceClaim {
 checkClaim(value,limits);const captured=structuredClone(value) as MaintenanceClaim;
 const stack:unknown[]=[captured];while(stack.length){const v=stack.pop();if(v!==null&&typeof v==='object'){for(const key of Object.keys(v))stack.push(field(v,key));Object.freeze(v);}}
 return captured;
}
function checked(n:bigint):number {if(n<0n||n>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Mutation reservation overflow');return Number(n);}
export function calculateMutationBrokerReservation(l:MutationBrokerLimits):MutationBrokerReservation {
 if(!record(l,LIMIT_KEYS))fail();
 for(const k of LIMIT_KEYS)if(!positive(l[k]))throw new RangeError('Invalid mutation limit');
 const C=2n*BigInt(l.maxClaimStringUnits)+BigInt(l.maxClaimUtf8Bytes)+8n*BigInt(l.maxClaimNodes),R=3n*BigInt(l.maxNativeResultUtf8Bytes)+32n;
 return Object.freeze({lifecycleLogicalBytes:checked(6n*C+4n*R+16n*2048n),lifecycleNodes:checked(6n*BigInt(l.maxClaimNodes)+4n*4n+16n*16n),lifecycleEdges:checked(6n*BigInt(l.maxClaimEdges)+4n*3n+16n*16n),rootLogicalBytes:3*16384,rootNodes:3*64,rootEdges:3*64});
}
/** Minimum uses the shortest legal RequestId (0n), two nonempty identity bytes,
 * and shortest passive params/origin (0n). Root depth is one, leaves depth two. */
function inspectMutationBrokerLimits(value:unknown):MutationBrokerLimits {
 const r=record(value,LIMIT_KEYS);if(!r)fail();
 for(const k of LIMIT_KEYS)if(!positive(r![k]))throw new RangeError('Invalid mutation limit');
 const l=r as unknown as MutationBrokerLimits;
 if(l.maxClaimUtf8Bytes>1048576||l.maxClaimStringUnits>1048576||l.maxClaimNodes>65536||l.maxClaimEdges>65536||l.maxClaimDepth>64||l.maxContainerEntries>65536||l.maxContainerEntries>l.maxClaimEdges||l.maxNativeResultUtf8Bytes<11||l.maxNativeResultUtf8Bytes>16384||l.nativeTimeoutMs>10000)throw new RangeError('Mutation limit exceeds boundary');
 for(const k of ['handshakeTimeoutMs','exchangeTimeoutMs','preparedAwaitFinishTimeoutMs','terminalRetentionMs','minStatusIntervalMs'] as const)if(l[k]>2147483647)throw new RangeError('Mutation timer exceeds boundary');
 checkClaim({ownerId:'',generation:0n,attemptId:'a',wire:0n,method:'a',params:0n,scoped:true,origin:0n},l);
 const reservation=calculateMutationBrokerReservation(l);
 if(l.maxRetainedLogicalBytes<reservation.lifecycleLogicalBytes||l.maxRetainedNodes<reservation.lifecycleNodes||l.maxRetainedEdges<reservation.lifecycleEdges)throw new RangeError('Insufficient mutation lifecycle reservation');
 verifyLargestReplies();return l;
}
export function validateMutationBrokerLimits(value:unknown):MutationBrokerLimits {
 const l=inspectMutationBrokerLimits(value);
 return Object.freeze({...l});
}
function envelope(value:unknown,epoch:string):Record<string,unknown>|null {
 const e=record(value,['version','epoch','exchange','body']);return e&&e.version===1&&epochValid(epoch)&&e.epoch===epoch&&positive(e.exchange)?e:null;
}
export function validateMutationRequest(value:unknown,epoch:string,l:MutationBrokerLimits):MutationBrokerEnvelope<MutationBrokerRequestBody>|null {
 try{
  const e=envelope(value,epoch);if(!e)return null;
  // Body discriminator is inspected through its descriptor before selecting exact keys.
  if(e.body===null||typeof e.body!=='object'||types.isProxy(e.body))return null;
  const kind=field(e.body,'kind');let b:Record<string,unknown>|null;
  if(kind==='begin'){b=record(e.body,['kind','claim']);if(!b)return null;checkClaim(b.claim,l);
   measure(value,{bytes:l.maxClaimUtf8Bytes+512,strings:l.maxClaimStringUnits+512,nodes:l.maxClaimNodes+16,edges:l.maxClaimEdges+16,depth:l.maxClaimDepth+2,entries:Math.max(l.maxContainerEntries,4)});
  }else if(kind==='finish'){b=record(e.body,['kind','beginSequence','outcome']);if(!b||!positive(b.beginSequence)||!['not_sent','reply_ok','reply_error'].includes(b.outcome as string))return null;
  }else if(['ready','status','ack-begin','cancel','ack-terminal','close'].includes(kind as string)){if(!record(e.body,['kind']))return null;}else return null;
  if(kind!=='begin')measure(value,{bytes:512,strings:512,nodes:16,edges:16,depth:4,entries:8});
  return value as MutationBrokerEnvelope<MutationBrokerRequestBody>;
 }catch{return null;}
}
export function validateMutationReply(value:unknown,epoch:string):MutationBrokerEnvelope<MutationBrokerReplyBody>|null {
 try{
  measure(value,{bytes:512,strings:512,nodes:16,edges:16,depth:4,entries:8});
  const e=envelope(value,epoch);if(!e||e.body===null||typeof e.body!=='object')return null;
  const kind=field(e.body,'kind');let b:Record<string,unknown>|null;
  switch(kind){
   case 'ready':case 'closing':if(!record(e.body,['kind']))return null;break;
   case 'accepted':case 'pending':b=record(e.body,kind==='pending'?['kind','phase','beginSequence','closing']:['kind','phase','beginSequence']);if(!b||!['begin','finish'].includes(b.phase as string)||!positive(b.beginSequence)||kind==='pending'&&typeof b.closing!=='boolean')return null;break;
   case 'begin-confirmed':b=record(e.body,['kind','beginSequence']);if(!b||!positive(b.beginSequence))return null;break;
   case 'acknowledged':b=record(e.body,['kind','phase']);if(!b||!['begin','terminal'].includes(b.phase as string))return null;break;
   case 'terminal':b=record(e.body,['kind','beginSequence','result']);if(!b||b.beginSequence!==null&&!positive(b.beginSequence)||!['finish-confirmed','unknown','not-submitted'].includes(b.result as string))return null;break;
   case 'rejected':b=record(e.body,['kind','reason']);if(!b||!['malformed','wrong-state','capacity','closed','rate-limited'].includes(b.reason as string))return null;break;
   default:return null;
  }
  return value as MutationBrokerEnvelope<MutationBrokerReplyBody>;
 }catch{return null;}
}
/** Enumerate every enum/null/boolean variant at maximum sequence width. */
function verifyLargestReplies():void {
 const n=Number.MAX_SAFE_INTEGER,epoch='f'.repeat(32),bodies:MutationBrokerReplyBody[]=[{kind:'ready'},{kind:'closing'},{kind:'begin-confirmed',beginSequence:n}];
 for(const phase of ['begin','finish'] as const){bodies.push({kind:'accepted',phase,beginSequence:n});for(const closing of [true,false])bodies.push({kind:'pending',phase,beginSequence:n,closing});}
 for(const phase of ['begin','terminal'] as const)bodies.push({kind:'acknowledged',phase});
 for(const result of ['finish-confirmed','unknown','not-submitted'] as const)for(const beginSequence of [n,null])bodies.push({kind:'terminal',beginSequence,result});
 for(const reason of ['malformed','wrong-state','capacity','closed','rate-limited'] as const)bodies.push({kind:'rejected',reason});
 for(const body of bodies)if(!validateMutationReply({version:1,epoch,exchange:n,body},epoch))throw new RangeError('Mutation reply schema exceeds fixed allowance');
}
export function validateMutationNativeResult(value:unknown,limits:MutationBrokerLimits):boolean {
 try{measure(value,{bytes:limits.maxNativeResultUtf8Bytes,strings:limits.maxNativeResultUtf8Bytes,nodes:4,edges:3,depth:2,entries:2});const r=record(value,['ok']);return r!==null&&r.ok===true;}catch{return false;}
}
export function validateMutationBootstrapDescriptor(epoch:string,limits:MutationBrokerLimits):void {
 if(!epochValid(epoch))fail();const l=inspectMutationBrokerLimits(limits);
 measure({kind:'native-mutation-broker-bootstrap',version:1,epoch,limits:l},{bytes:4096,strings:4096,nodes:64,edges:64,depth:3,entries:64});
}
