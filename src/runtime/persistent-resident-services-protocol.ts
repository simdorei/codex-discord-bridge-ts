import {types} from 'node:util';
import type {MessagePort} from 'node:worker_threads';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import type {IdleReleaseToken} from '../app-server/idle-release-journal.ts';

/** Disposable component protocol. Correlation is never business authority. */
export type ServiceFamily='dead'|'idle'|'verify'|'gap'|'response';
export const SERVICE_FAMILIES=Object.freeze(['dead','idle','verify','gap','response'] as const);
export interface PassiveBounds {readonly bytes:number;readonly units:number;readonly nodes:number;readonly edges:number;readonly depth:number;readonly entries:number}
const bounds=(bytes:number,nodes:number,depth=64):PassiveBounds=>Object.freeze({bytes,units:bytes,nodes,edges:nodes,depth,entries:nodes});
export const SERVICE_PROFILES=Object.freeze({
 dead:Object.freeze({slots:1,input:bounds(1114112,65536),output:bounds(32768,4096)}),
 idle:Object.freeze({slots:4,input:bounds(131072,4096),output:bounds(65536,4096)}),
 verify:Object.freeze({slots:2,input:bounds(16384,256),output:bounds(16384,64)}),
 gap:Object.freeze({slots:1,input:bounds(16384,256),output:bounds(16384,64)}),
 response:Object.freeze({slots:2,input:bounds(8388608,262144),output:bounds(16384,64)}),
});
export const SERVICE_LIMITS=Object.freeze({maxId:2147483647,operationExchangeReserve:10005,controlExchangeReserve:3,maxStatusPosts:10001,statusPeriodMs:1,phaseMs:10000,nativeTimeoutMs:5000,exchangeTimeoutMs:5000,terminalRetentionMs:5000});
export const SERVICE_WRAPPER_BOUNDS=bounds(2048,32,8);
export const ORIGINAL_GAP_DETAIL='original observation stream gap';
export interface ServiceScope {readonly ownerId:string;readonly generation:bigint}
export type ServiceRequestId=string|bigint;
export interface DeadTransfer {readonly generation:bigint;readonly closedReason:string;readonly activeTurns:readonly {readonly threadId:string;readonly turnId:string}[];readonly serverRequests:readonly {readonly id:ServiceRequestId;readonly occurrence:readonly number[];readonly method:string;readonly params:unknown}[]}
export interface ServiceResponseScope {readonly runtime:string;readonly resident:string;readonly generation:bigint;readonly request:{readonly id:ServiceRequestId;readonly occurrence:readonly bigint[];readonly method:string;readonly params:unknown}}
export type ServicePayload=
 |{readonly op:'activate-custody'}
 |{readonly op:'capture-dead';readonly instanceId:string;readonly work:DeadTransfer}
 |{readonly op:'idle-install'}
 |{readonly op:'idle-before';readonly ownerId:string;readonly generation:bigint;readonly threadId:string}
 |{readonly op:'idle-transition';readonly token:IdleReleaseToken;readonly state:string;readonly detail:string}
 |{readonly op:'idle-exit';readonly ownerId:string;readonly generation:bigint}
 |{readonly op:'observation-activate';readonly scope:ServiceScope}
 |{readonly op:'observation-verified';readonly scope:ServiceScope;readonly through:bigint}
 |{readonly op:'gap-discover';readonly scope:ServiceScope;readonly upper:bigint}
 |{readonly op:'gap-unknown';readonly scope:ServiceScope}
 |{readonly op:'response-finish';readonly scope:ServiceResponseScope;readonly authority:unknown;readonly payload:unknown;readonly outcome:'flushed'|'not_sent'};
interface OperationRef {readonly operationId:number;readonly slot:number}
export type ServiceRequestBody={readonly kind:'ready'|'stop-new-work'|'close-idle'}|({readonly kind:'submit';readonly payload:ServicePayload}&OperationRef)|({readonly kind:'status'|'cancel'|'ack-terminal'}&OperationRef);
export type ServiceFailureCategory='owner-failed'|'cancelled'|'transport-unknown';
export type ServiceTerminalResult={readonly kind:'ok';readonly value:unknown}|{readonly kind:'failed';readonly category:ServiceFailureCategory};
export type ServiceReplyBody={readonly kind:'ready';readonly slots:number}|{readonly kind:'stopped-new-work'|'closed'}|({readonly kind:'accepted'|'pending'|'cancel-requested'|'retired'}&OperationRef)|({readonly kind:'terminal';readonly result:ServiceTerminalResult}&OperationRef)|({readonly kind:'terminal-observed';readonly result:'ok'|'failed'}&OperationRef);
export interface ServiceEnvelope<T=ServiceRequestBody|ServiceReplyBody> {readonly version:1;readonly service:ServiceFamily;readonly epoch:string;readonly exchange:number;readonly body:T}
export interface ServiceEndpointDescriptor {readonly service:ServiceFamily;readonly epoch:string;readonly port:MessagePort}
export interface PassiveDimensions {readonly bytes:number;readonly units:number;readonly nodes:number;readonly edges:number}
const I64_MIN=-(1n<<63n),I64_MAX=(1n<<63n)-1n,U64_MAX=(1n<<64n)-1n;
function invalid():never{throw new TypeError('Invalid bounded resident service value');}
function data(object:object,key:string):unknown {const d=Object.getOwnPropertyDescriptor(object,key);if(!d||!Object.hasOwn(d,'value')||!d.enumerable)invalid();return d.value;}
function passiveRecord(value:unknown):Record<string,unknown>{
 if(value===null||typeof value!=='object'||types.isProxy(value)||Array.isArray(value))invalid();
 const p=Object.getPrototypeOf(value);if(p!==null&&p!==Object.prototype)invalid();return value as Record<string,unknown>;
}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
 const r=passiveRecord(value),own=Reflect.ownKeys(r);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))invalid();for(const k of keys)data(r,k);return r;
}
function wellFormed(value:string):void {for(const c of value){const cp=c.codePointAt(0)!;if(cp>=0xd800&&cp<=0xdfff)invalid();}}
function text(value:unknown,empty=false,max=4096,nul=false):asserts value is string {
 if(typeof value!=='string'||(!empty&&value==='')||(!nul&&value.includes('\0'))||value.length>max||Buffer.byteLength(value,'utf8')>max)invalid();wellFormed(value);
}
function integer(value:unknown,min=0n,max=I64_MAX):asserts value is bigint {if(typeof value!=='bigint'||value<min||value>max)invalid();}
function id(value:unknown):void {if(typeof value==='string'){text(value,true);return;}integer(value,I64_MIN);}
function vector(value:unknown,max:number):asserts value is unknown[]{
 if(value===null||typeof value!=='object'||types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)invalid();
 const length=Object.getOwnPropertyDescriptor(value,'length')?.value;if(!Number.isSafeInteger(length)||length<0||length>max||Reflect.ownKeys(value).length!==length+1)invalid();for(let i=0;i<length;i++)data(value,String(i));
}
/** No clone, getter, toJSON, user callback, or stringification of a graph. Aliases
 * are visited again; only the active ancestor set is retained. Object key lists
 * and serializer internals are not a physical-memory upper-bound claim. */
export function measurePassiveValue(value:unknown,limit:PassiveBounds):PassiveDimensions {
 let bytes=0,units=0,nodes=0,edges=0;const ancestors=new Set<object>();
 const addBytes=(n:number)=>{bytes+=n;if(bytes>limit.bytes)invalid();};
 const string=(s:string)=>{units+=s.length;if(units>limit.units)invalid();addBytes(2);for(const c of s){const cp=c.codePointAt(0)!;if(cp>=0xd800&&cp<=0xdfff)invalid();addBytes(cp===34||cp===92?2:cp<32?([8,9,10,12,13].includes(cp)?2:6):Buffer.byteLength(c,'utf8'));}};
 const visit=(v:unknown,depth:number):void=>{
  if(++nodes>limit.nodes||depth>limit.depth)invalid();
  if(v===null){addBytes(4);return;}
  switch(typeof v){case 'string':string(v);return;case 'boolean':addBytes(v?4:5);return;case 'bigint':integer(v,I64_MIN,U64_MAX);addBytes(v.toString().length);return;case 'number':if(!Number.isFinite(v))invalid();addBytes(serializeSerdeValue(v).length);return;case 'object':break;default:invalid();}
  const o=v as object;if(types.isProxy(o)||ancestors.has(o))invalid();
  const array=Array.isArray(o);if(array){if(Object.getPrototypeOf(o)!==Array.prototype)invalid();const len=Object.getOwnPropertyDescriptor(o,'length')?.value;if(!Number.isSafeInteger(len)||len<0||len>limit.entries)invalid();}else passiveRecord(o);
  const keys=Reflect.ownKeys(o);const count=keys.length-(array?1:0);if(count>limit.entries||keys.some(k=>typeof k!=='string'))invalid();
  if(array&&count!==(o as unknown[]).length)invalid();
  ancestors.add(o);addBytes(2);
  try{for(let i=0;i<count;i++){if(++edges>limit.edges)invalid();if(i>0)addBytes(1);const key=array?String(i):keys[i] as string;if(!array){string(key);addBytes(1);}visit(data(o,key),depth+1);}}finally{ancestors.delete(o);}
 };
 visit(value,0);return Object.freeze({bytes,units,nodes,edges});
}
function scope(value:unknown):void {const s=exact(value,['ownerId','generation']);text(s.ownerId);integer(s.generation);}
function token(value:unknown):asserts value is IdleReleaseToken {
 const t=exact(value,['intentId','ownerId','generation','threadId','turnId','jobId','revision','state','detail']);text(t.intentId);text(t.ownerId);integer(t.generation);integer(t.revision,I64_MIN);
 for(const k of ['threadId','turnId','jobId','state'])text(t[k],true);text(t.detail,true,32768,true);
}
const OPS:Readonly<Record<ServiceFamily,readonly string[]>>=Object.freeze({dead:Object.freeze(['activate-custody','capture-dead']),idle:Object.freeze(['idle-install','idle-before','idle-transition','idle-exit']),verify:Object.freeze(['observation-activate','observation-verified']),gap:Object.freeze(['gap-discover','gap-unknown']),response:Object.freeze(['response-finish'])});
export function validateServicePayload(service:ServiceFamily,value:unknown,pinnedRuntime?:string):ServicePayload {
 if(!SERVICE_FAMILIES.includes(service))invalid();measurePassiveValue(value,SERVICE_PROFILES[service].input);
 const p=passiveRecord(value),op=data(p,'op');if(typeof op!=='string'||!OPS[service].includes(op))invalid();
 switch(op){
  case 'activate-custody':case 'idle-install':exact(p,['op']);break;
  case 'capture-dead':{
   exact(p,['op','instanceId','work']);text(p.instanceId);const w=exact(p.work,['generation','closedReason','activeTurns','serverRequests']);integer(w.generation,1n);if(typeof w.closedReason!=='string')invalid();wellFormed(w.closedReason);vector(w.activeTurns,65536);vector(w.serverRequests,65536);
   for(const value of w.activeTurns){const t=exact(value,['threadId','turnId']);text(t.threadId);text(t.turnId);}
   for(const value of w.serverRequests){const q=exact(value,['id','occurrence','method','params']);id(q.id);text(q.method);vector(q.occurrence,16);if(q.occurrence.length!==16)invalid();for(const b of q.occurrence)if(typeof b!=='number'||!Number.isInteger(b)||b<0||b>255)invalid();}
   measurePassiveValue(w,{...SERVICE_PROFILES.dead.input,bytes:1048576});break;
  }
  case 'idle-before':exact(p,['op','ownerId','generation','threadId']);text(p.ownerId);integer(p.generation);text(p.threadId,true);break;
  case 'idle-transition':exact(p,['op','token','state','detail']);token(p.token);text(p.state,true);text(p.detail,true,32768,true);break;
  case 'idle-exit':exact(p,['op','ownerId','generation']);text(p.ownerId);integer(p.generation);break;
  case 'observation-activate':case 'gap-unknown':exact(p,['op','scope']);scope(p.scope);break;
  case 'observation-verified':exact(p,['op','scope','through']);scope(p.scope);integer(p.through);break;
  case 'gap-discover':exact(p,['op','scope','upper']);scope(p.scope);integer(p.upper);break;
  case 'response-finish':{
   exact(p,['op','scope','authority','payload','outcome']);if(p.outcome!=='flushed'&&p.outcome!=='not_sent')invalid();const s=exact(p.scope,['runtime','resident','generation','request']);text(s.runtime);text(s.resident);integer(s.generation);if(pinnedRuntime!==undefined&&s.runtime!==pinnedRuntime)invalid();
   const q=exact(s.request,['id','occurrence','method','params']);id(q.id);text(q.method);vector(q.occurrence,16);if(q.occurrence.length!==16)invalid();for(const b of q.occurrence)integer(b,0n,255n);break;
  }
  default:invalid();
 }
 return value as ServicePayload;
}
export function captureServicePayload(service:ServiceFamily,value:unknown,pinnedRuntime?:string):ServicePayload {validateServicePayload(service,value,pinnedRuntime);return cloneOwnedSerdeValue(value) as ServicePayload;}
export function serviceSlotClass(payload:ServicePayload):'ordinary'|'owned-transition'|'exit' {return payload.op==='idle-exit'?'exit':payload.op==='idle-transition'&&payload.state!=='Dispatching'?'owned-transition':'ordinary';}
export function slotAllowsPayload(service:ServiceFamily,slot:number,payload:ServicePayload):boolean {if(!Number.isInteger(slot)||slot<0||slot>=SERVICE_PROFILES[service].slots)return false;if(service!=='idle')return true;const c=serviceSlotClass(payload);return c==='ordinary'?slot===0:c==='exit'?slot===3:slot===1||slot===2;}
export function validateServiceResult(service:ServiceFamily,payload:ServicePayload,value:unknown):unknown {
 if(!SERVICE_FAMILIES.includes(service)||!OPS[service].includes(payload.op))invalid();
 measurePassiveValue(value,SERVICE_PROFILES[service].output);
 if(payload.op==='idle-before'){
  if(value===null)return value;token(value);if(value.state!=='Resubscribing'||value.ownerId!==payload.ownerId||value.generation!==payload.generation||value.threadId!==payload.threadId)invalid();
 }else if(payload.op==='idle-transition'){
  token(value);const old=payload.token;for(const k of ['intentId','ownerId','generation','threadId','turnId','jobId'] as const)if(value[k]!==old[k])invalid();
  if(value.revision!==old.revision+1n||value.state!==payload.state||value.detail!==Array.from(payload.detail).slice(0,512).join(''))invalid();
 }else if(payload.op==='observation-verified'){if(typeof value!=='boolean')invalid();}else if(value!==null)invalid();
 return value;
}
export function captureServiceResult(service:ServiceFamily,payload:ServicePayload,value:unknown):unknown {validateServiceResult(service,payload,value);return cloneOwnedSerdeValue(value);}
function counter(value:unknown):asserts value is number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>SERVICE_LIMITS.maxId)invalid();}
function operationRef(b:Record<string,unknown>,service:ServiceFamily):void {counter(b.operationId);if(typeof b.slot!=='number'||!Number.isInteger(b.slot)||b.slot<0||b.slot>=SERVICE_PROFILES[service].slots)invalid();}
function envelope(value:unknown,service:ServiceFamily,epoch:string):{outer:Record<string,unknown>;body:Record<string,unknown>} {
 if(!SERVICE_FAMILIES.includes(service)||typeof epoch!=='string'||! /^[0-9a-f]{32}$/.test(epoch))invalid();
 const outer=exact(value,['version','service','epoch','exchange','body']);if(outer.version!==1||outer.service!==service||outer.epoch!==epoch)invalid();counter(outer.exchange);return {outer,body:passiveRecord(outer.body)};
}
/** Wrapper is independently bounded with the already separately bounded payload
 * replaced by null; no second serialization or clone of the input graph. */
function wrapper(outer:Record<string,unknown>,body:Record<string,unknown>):void {measurePassiveValue({version:outer.version,service:outer.service,epoch:outer.epoch,exchange:outer.exchange,body},SERVICE_WRAPPER_BOUNDS);}
export function validateServiceRequest(value:unknown,service:ServiceFamily,epoch:string,pinnedRuntime?:string):ServiceEnvelope<ServiceRequestBody> {
 const {outer,body:b}=envelope(value,service,epoch),kind=data(b,'kind');
 if(kind==='ready'||kind==='stop-new-work'||kind==='close-idle'){exact(b,['kind']);wrapper(outer,b);}
 else if(kind==='submit'){exact(b,['kind','operationId','slot','payload']);operationRef(b,service);const p=validateServicePayload(service,b.payload,pinnedRuntime);if(!slotAllowsPayload(service,b.slot as number,p))invalid();wrapper(outer,{kind,operationId:b.operationId,slot:b.slot,payload:null});}
 else if(kind==='status'||kind==='cancel'||kind==='ack-terminal'){exact(b,['kind','operationId','slot']);operationRef(b,service);wrapper(outer,b);}else invalid();
 return value as ServiceEnvelope<ServiceRequestBody>;
}
export function validateServiceReply(value:unknown,service:ServiceFamily,epoch:string,originalPayload?:ServicePayload):ServiceEnvelope<ServiceReplyBody> {
 const {outer,body:b}=envelope(value,service,epoch),kind=data(b,'kind');
 if(kind==='ready'){exact(b,['kind','slots']);if(b.slots!==SERVICE_PROFILES[service].slots)invalid();wrapper(outer,b);}
 else if(kind==='stopped-new-work'||kind==='closed'){exact(b,['kind']);wrapper(outer,b);}
 else if(kind==='accepted'||kind==='pending'||kind==='cancel-requested'||kind==='retired'){exact(b,['kind','operationId','slot']);operationRef(b,service);wrapper(outer,b);}
 else if(kind==='terminal-observed'){exact(b,['kind','operationId','slot','result']);operationRef(b,service);if(b.result!=='ok'&&b.result!=='failed')invalid();wrapper(outer,b);}
 else if(kind==='terminal'){
  exact(b,['kind','operationId','slot','result']);operationRef(b,service);const r=passiveRecord(b.result),rk=data(r,'kind');
  if(rk==='ok'){exact(r,['kind','value']);if(originalPayload===undefined)invalid();validateServiceResult(service,originalPayload,r.value);wrapper(outer,{kind,operationId:b.operationId,slot:b.slot,result:{kind:'ok',value:null}});}
  else if(rk==='failed'){exact(r,['kind','category']);if(r.category!=='owner-failed'&&r.category!=='cancelled'&&r.category!=='transport-unknown')invalid();wrapper(outer,b);}else invalid();
 }else invalid();
 return value as ServiceEnvelope<ServiceReplyBody>;
}
export interface LogicalReservation {readonly bytes:number;readonly nodes:number;readonly edges:number}
function safe(n:bigint):number {if(n<0n||n>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Resident service reservation overflow');return Number(n);}
function reservation(b:bigint,n:bigint,e:bigint):LogicalReservation {return Object.freeze({bytes:safe(b),nodes:safe(n),edges:safe(e)});}
export function checkedServiceReservation():Readonly<{perService:Readonly<Record<ServiceFamily,LogicalReservation>>;total:LogicalReservation}> {
 const perService={} as Record<ServiceFamily,LogicalReservation>;let b=22249600n+51200n+6n*49152n,n=393488n+256n+6n*192n,e=393484n+256n+6n*192n;
 for(const service of SERVICE_FAMILIES){const p=SERVICE_PROFILES[service],i=p.input,o=p.output,C=2n*BigInt(i.units)+BigInt(i.bytes)+8n*BigInt(i.nodes),R=2n*BigInt(o.units)+BigInt(o.bytes)+8n*BigInt(o.nodes);const slot=reservation(6n*C+4n*R+32n*2048n,6n*BigInt(i.nodes)+4n*BigInt(o.nodes)+32n*32n,6n*BigInt(i.edges)+4n*BigInt(o.edges)+32n*32n);perService[service]=slot;b+=BigInt(slot.bytes)*BigInt(p.slots);n+=BigInt(slot.nodes)*BigInt(p.slots);e+=BigInt(slot.edges)*BigInt(p.slots);}
 const total=reservation(b,n,e);if(total.bytes!==389939328||total.nodes!==4130192||total.edges!==4130188)throw new RangeError('Resident service reservation ledger mismatch');return Object.freeze({perService:Object.freeze(perService),total});
}
export const SERVICE_RESERVATION=checkedServiceReservation();
/** outstanding reservations are remaining credits, not original allocation sizes. */
export function checkExchangeHeadroom(lastExchange:number,reservedRemaining:number,newOperations=1):void {
 for(const v of [lastExchange,reservedRemaining,newOperations])if(!Number.isSafeInteger(v)||v<0)throw new RangeError('Invalid resident service counter');
 const need=BigInt(reservedRemaining)+BigInt(newOperations)*BigInt(SERVICE_LIMITS.operationExchangeReserve)+BigInt(SERVICE_LIMITS.controlExchangeReserve);
 if(BigInt(lastExchange)>BigInt(SERVICE_LIMITS.maxId)||need>BigInt(SERVICE_LIMITS.maxId)-BigInt(lastExchange))throw new RangeError('Resident service exchange counter exhausted');
}
