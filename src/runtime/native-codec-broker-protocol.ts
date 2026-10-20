import {Buffer} from 'node:buffer';
import {types} from 'node:util';
import type {GatewayInboundMessage} from '../remote-agent/gateway-inbound.ts';

/** This catalog carries decoded data only. It grants no dispatch, storage,
 * session, path, native-I/O, or mutation authority. */
export const NATIVE_CODEC_OPERATION='remote.gateway.decode.v1' as const;
export const NATIVE_CODEC_MAX_INPUT_BYTES=12_000_000;
export const NATIVE_CODEC_RESULT_ALLOWANCE=32_768;
export const NATIVE_CODEC_MAX_RESULT_VALUES=4_096;
export const NATIVE_CODEC_MAX_RESULT_DEPTH=16;
const MAX_TIMER_MS=2_147_483_647;
const MIN_I64=-9_223_372_036_854_775_808n;
const MAX_U64=18_446_744_073_709_551_615n;
const GATEWAY_VARIANTS=new Set<string>([
 'hello_ack','project_ack','project_info','list_files','read_file','write_file',
 'project_operation','project_session','device_session',
]);

export interface NativeCodecBrokerLimits {
 readonly maxInputBytes:number;
 readonly maxResultStringUnits:number;
 readonly maxRetainedPayloadBytes:number;
 readonly nativeTimeoutMs:number;
 readonly handshakeTimeoutMs:number;
 readonly exchangeTimeoutMs:number;
 readonly terminalRetentionMs:number;
 readonly minStatusIntervalMs:number;
}
export type NativeCodecLimits=NativeCodecBrokerLimits;

export interface BrokerReservation {
 readonly inputPayloadBytes:number;
 readonly resultPayloadBytes:number;
 readonly requiredPayloadBytes:number;
 readonly resultValueCopies:4;
 readonly maxResultValues:4096;
 readonly maxResultEdges:4095;
 readonly reservedResultValues:16384;
 readonly reservedResultEdges:16380;
 readonly reservedEnvelopeValues:256;
 readonly reservedEnvelopeEdges:256;
 readonly requiredGraphValues:16640;
 readonly requiredGraphEdges:16636;
}

export type SubmissionRefusal='closed'|'invalid-input'|'reservation-failure';
export type Submission=
 | Readonly<{accepted:true;requestId:number}>
 | Readonly<{accepted:false;requestId:number;reason:SubmissionRefusal}>;
export type JoinedErrorClassification='adapter-failed'|'invalid-result';
export type RequestStatus=
 | Readonly<{state:'pending';cancellationRequested:boolean;nativeOwnership:'retained-or-not-started'}>
 | Readonly<{state:'joined-result';cancellationRequested:boolean;result:GatewayInboundMessage}>
 | Readonly<{state:'joined-error';cancellationRequested:boolean;error:JoinedErrorClassification}>
 | Readonly<{state:'delivered-await-ack';cancellationRequested:boolean}>
 | Readonly<{state:'retired-no-replay'}>;
export type EndpointStatus=Readonly<{state:'closing-retained'|'closed-joined'}>;

export interface BrokerEnvelope<K extends string,I extends number|null,B> {
 readonly v:1;
 readonly epoch:string;
 readonly exchangeId:number;
 readonly kind:K;
 readonly requestId:I;
 readonly body:B;
}
export type BrokerRequestEnvelope=
 | BrokerEnvelope<'ready',null,null>
 | BrokerEnvelope<'submit',number,Readonly<{operation:typeof NATIVE_CODEC_OPERATION;raw:string}>>
 | BrokerEnvelope<'status'|'cancel'|'acknowledge-terminal',number,null>
 | BrokerEnvelope<'close',null,null>;
export type BrokerReplyEnvelope=
 | BrokerEnvelope<'ready-ack',null,null>
 | BrokerEnvelope<'accepted',number,Readonly<{accepted:true}>>
 | BrokerEnvelope<'not-accepted',number,Readonly<{reason:SubmissionRefusal}>>
 | BrokerEnvelope<'status',number,RequestStatus>
 | BrokerEnvelope<'close-status',null,EndpointStatus>
 | BrokerEnvelope<'terminal-ack',number,null>
 | BrokerEnvelope<'protocol-error',number|null,Readonly<{code:'invalid-protocol'}>>;

const LIMIT_KEYS=[
 'maxInputBytes','maxResultStringUnits','maxRetainedPayloadBytes','nativeTimeoutMs',
 'handshakeTimeoutMs','exchangeTimeoutMs','terminalRetentionMs','minStatusIntervalMs',
] as const;
const ENVELOPE_KEYS=['v','epoch','exchangeId','kind','requestId','body'] as const;

/** A proxy is rejected before prototype/key/descriptor reflection. Accessors,
 * hidden fields, symbol fields and custom prototypes are never read. */
function passiveRecord(value:unknown,keys:readonly string[]):Record<string,unknown>|null {
 if(value===null||typeof value!=='object'||types.isProxy(value))return null;
 const prototype=Object.getPrototypeOf(value);
 if(prototype!==Object.prototype&&prototype!==null)return null;
 if(Object.getOwnPropertySymbols(value).length!==0)return null;
 const names=Object.getOwnPropertyNames(value);
 if(names.length!==keys.length)return null;
 for(const key of names){
  if(!keys.includes(key))return null;
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(descriptor===undefined||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable)return null;
 }
 return value as Record<string,unknown>;
}
function integerIn(value:unknown,min:number,max:number):value is number {
 return typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
}
export function isBrokerCounter(value:unknown):value is number {
 return integerIn(value,1,Number.MAX_SAFE_INTEGER);
}
export function isBrokerEpoch(value:unknown):value is string {
 return typeof value==='string'&&value.length===32&&/^[a-f0-9]{32}$/u.test(value);
}
function checkedAdd(a:number,b:number):number {
 const value=a+b;
 if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<0||b<0||!Number.isSafeInteger(value))throw new RangeError('Unsafe native codec reservation');
 return value;
}
function checkedMultiply(a:number,b:number):number {
 const value=a*b;
 if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<0||b<0||!Number.isSafeInteger(value))throw new RangeError('Unsafe native codec reservation');
 return value;
}

/** Logical scalar/string capacity, not exact V8 heap, queue, or RSS sizing.
 * Three raw copies and four result copies cover the approved clone overlap.
 * The fixed 4096 allowance is for bounded envelopes/error scalars. Graph counts
 * separately reserve four maximum result graphs plus a conservative, fixed
 * 256-value/256-edge allowance for the bounded bootstrap, request, reply and
 * status records. These are logical counts, not object-header byte estimates. */
export function calculateBrokerReservation(maxInputBytes:number):BrokerReservation {
 if(!integerIn(maxInputBytes,1,NATIVE_CODEC_MAX_INPUT_BYTES))throw new RangeError('Invalid native codec input limit');
 const inputPayloadBytes=checkedMultiply(2,maxInputBytes);
 const resultUnits=checkedAdd(maxInputBytes,NATIVE_CODEC_RESULT_ALLOWANCE);
 const resultPayloadBytes=checkedAdd(checkedAdd(checkedMultiply(2,resultUnits),checkedMultiply(8,NATIVE_CODEC_MAX_RESULT_VALUES)),NATIVE_CODEC_MAX_RESULT_VALUES);
 const requiredPayloadBytes=checkedAdd(checkedAdd(checkedMultiply(3,inputPayloadBytes),checkedMultiply(4,resultPayloadBytes)),4096);
 return Object.freeze({
  inputPayloadBytes,resultPayloadBytes,requiredPayloadBytes,
  resultValueCopies:4,maxResultValues:4096,maxResultEdges:4095,
  reservedResultValues:16384,reservedResultEdges:16380,
  reservedEnvelopeValues:256,reservedEnvelopeEdges:256,
  requiredGraphValues:16640,requiredGraphEdges:16636,
 });
}

/** Validate every mandatory primitive field and copy it before any channel or
 * worker submission. A narrowed result limit never shrinks native allowance. */
export function validateBrokerLimits(value:unknown):Readonly<NativeCodecBrokerLimits> {
 const record=passiveRecord(value,LIMIT_KEYS);
 if(record===null)throw new TypeError('Invalid native codec broker limits');
 if(!integerIn(record.maxInputBytes,1,NATIVE_CODEC_MAX_INPUT_BYTES))throw new RangeError('Invalid native codec input limit');
 if(!integerIn(record.maxResultStringUnits,1,checkedAdd(record.maxInputBytes,NATIVE_CODEC_RESULT_ALLOWANCE)))throw new RangeError('Invalid native codec result limit');
 if(!integerIn(record.maxRetainedPayloadBytes,1,Number.MAX_SAFE_INTEGER))throw new RangeError('Invalid native codec payload limit');
 if(!integerIn(record.nativeTimeoutMs,1,10000))throw new RangeError('Invalid native codec timeout');
 for(const key of ['handshakeTimeoutMs','exchangeTimeoutMs','terminalRetentionMs','minStatusIntervalMs'] as const){
  if(!integerIn(record[key],1,MAX_TIMER_MS))throw new RangeError('Invalid native codec broker timer');
 }
 const reservation=calculateBrokerReservation(record.maxInputBytes);
 if(record.maxRetainedPayloadBytes<reservation.requiredPayloadBytes)throw new RangeError('Insufficient native codec payload reservation');
 return Object.freeze({
  maxInputBytes:record.maxInputBytes,
  maxResultStringUnits:record.maxResultStringUnits,
  maxRetainedPayloadBytes:record.maxRetainedPayloadBytes,
  nativeTimeoutMs:record.nativeTimeoutMs,
  handshakeTimeoutMs:record.handshakeTimeoutMs as number,
  exchangeTimeoutMs:record.exchangeTimeoutMs as number,
  terminalRetentionMs:record.terminalRetentionMs as number,
  minStatusIntervalMs:record.minStatusIntervalMs as number,
 });
}

/** Direct primitive input only: no coercion, getters, or serializer hooks. */
export function isGatewayInput(raw:unknown,maxInputBytes:number):raw is string {
 return integerIn(maxInputBytes,1,NATIVE_CODEC_MAX_INPUT_BYTES)&&typeof raw==='string'&&raw.length<=maxInputBytes&&Buffer.byteLength(raw,'utf8')<=maxInputBytes;
}

export interface GatewayResultAccounting {
 readonly visitedValues:number;
 readonly edges:number;
 readonly stringUnits:number;
 readonly bigintCount:number;
 readonly booleanCount:number;
 readonly payloadBytes:number;
}
interface ValidatedGatewayGraph {
 readonly accounting:GatewayResultAccounting;
 readonly objects:readonly object[];
}
/** This is passive graph validation, not a replacement wire schema parser.
 * The original native gateway parser supplies full protocol validation. */
function inspectGatewayGraph(value:unknown,maxStringUnits:number):ValidatedGatewayGraph {
 if(!integerIn(maxStringUnits,1,NATIVE_CODEC_MAX_INPUT_BYTES+NATIVE_CODEC_RESULT_ALLOWANCE))throw new RangeError('Invalid native codec result budget');
 let visitedValues=0,edges=0,stringUnits=0,bigintCount=0,booleanCount=0;
 const ancestors=new Set<object>(),objects=new Set<object>();
 const addUnits=(units:number):void=>{
  stringUnits=checkedAdd(stringUnits,units);
  if(stringUnits>maxStringUnits)throw new RangeError('Native codec result text exceeds budget');
 };
 const visit=(item:unknown,depth:number):void=>{
  if(++visitedValues>NATIVE_CODEC_MAX_RESULT_VALUES||depth>NATIVE_CODEC_MAX_RESULT_DEPTH)throw new RangeError('Native codec result graph exceeds budget');
  if(typeof item==='string'){addUnits(item.length);return;}
  if(item===null)return;
  if(typeof item==='boolean'){booleanCount++;return;}
  if(typeof item==='bigint'){
   if(item<MIN_I64||item>MAX_U64)throw new RangeError('Native codec result integer exceeds budget');
   bigintCount++;return;
  }
  if(typeof item!=='object'||types.isProxy(item))throw new TypeError('Invalid native codec result value');
  if(ancestors.has(item))throw new TypeError('Cyclic native codec result');
  const prototype=Object.getPrototypeOf(item),array=Array.isArray(item);
  if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)throw new TypeError('Opaque native codec result');
  if(Object.getOwnPropertySymbols(item).length!==0)throw new TypeError('Symbol native codec result field');
  const names=Object.getOwnPropertyNames(item);
  if(names.length>NATIVE_CODEC_MAX_RESULT_VALUES+1)throw new RangeError('Native codec result graph exceeds budget');
  let arrayLength=0;
  if(array){
   const length=Object.getOwnPropertyDescriptor(item,'length');
   if(length===undefined||!Object.hasOwn(length,'value')||length.enumerable||!integerIn(length.value,0,NATIVE_CODEC_MAX_RESULT_VALUES-1))throw new TypeError('Invalid native codec result array');
   arrayLength=length.value;
   if(names.length!==arrayLength+1)throw new TypeError('Sparse or extended native codec result array');
  }
  ancestors.add(item);objects.add(item);
  for(const key of names){
   if(array&&key==='length')continue;
   if(array){
    const index=Number(key);
    if(!Number.isSafeInteger(index)||index<0||index>=arrayLength||String(index)!==key)throw new TypeError('Extended native codec result array');
   }
   const descriptor=Object.getOwnPropertyDescriptor(item,key);
   if(descriptor===undefined||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable)throw new TypeError('Active native codec result field');
   addUnits(key.length);
   if(++edges>NATIVE_CODEC_MAX_RESULT_VALUES-1)throw new RangeError('Native codec result edges exceed budget');
   visit(descriptor.value,depth+1);
  }
  ancestors.delete(item);
 };
 visit(value,0);
 if(value===null||typeof value!=='object'||Array.isArray(value))throw new TypeError('Invalid native gateway result');
 const discriminator=Object.getOwnPropertyDescriptor(value,'type');
 if(discriminator===undefined||!Object.hasOwn(discriminator,'value')||typeof discriminator.value!=='string'||!GATEWAY_VARIANTS.has(discriminator.value))throw new TypeError('Invalid native gateway result type');
 const payloadBytes=checkedAdd(checkedAdd(checkedMultiply(2,stringUnits),checkedMultiply(8,bigintCount)),booleanCount);
 return {accounting:Object.freeze({visitedValues,edges,stringUnits,bigintCount,booleanCount,payloadBytes}),objects:[...objects]};
}
export function validateGatewayResult(value:unknown,maxStringUnits:number):GatewayResultAccounting {
 return inspectGatewayGraph(value,maxStringUnits).accounting;
}
/** Call only for the receiver's privately owned clone. Nothing is frozen until
 * the entire graph passes, so malformed input is discarded without handoff. */
export function validateAndFreezeGatewayResult(value:unknown,maxStringUnits:number):GatewayInboundMessage {
 const graph=inspectGatewayGraph(value,maxStringUnits);
 for(const object of graph.objects)Object.freeze(object);
 return value as GatewayInboundMessage;
}

function envelopeRecord(value:unknown,epoch:string):Record<string,unknown>|null {
 const record=passiveRecord(value,ENVELOPE_KEYS);
 if(record===null||record.v!==1||!isBrokerEpoch(epoch)||record.epoch!==epoch||!isBrokerCounter(record.exchangeId)||typeof record.kind!=='string')return null;
 if(record.requestId!==null&&!isBrokerCounter(record.requestId))return null;
 return record;
}
export function validateRequestEnvelope(value:unknown,epoch:string):BrokerRequestEnvelope|null {
 const record=envelopeRecord(value,epoch);
 if(record===null)return null;
 switch(record.kind){
  case 'ready':case 'close':
   if(record.requestId!==null||record.body!==null)return null;
   break;
  case 'status':case 'cancel':case 'acknowledge-terminal':
   if(!isBrokerCounter(record.requestId)||record.body!==null)return null;
   break;
  case 'submit':{
   if(!isBrokerCounter(record.requestId))return null;
   const body=passiveRecord(record.body,['operation','raw']);
   if(body===null||body.operation!==NATIVE_CODEC_OPERATION||typeof body.raw!=='string')return null;
   break;
  }
  default:return null;
 }
 return value as BrokerRequestEnvelope;
}
function isRefusal(value:unknown):value is SubmissionRefusal {
 return value==='closed'||value==='invalid-input'||value==='reservation-failure';
}
function requestStatus(value:unknown,maxStringUnits:number):boolean {
 if(value===null||typeof value!=='object'||types.isProxy(value))return false;
 // Discover the discriminator through its data descriptor, never a property get.
 const prototype=Object.getPrototypeOf(value);
 if(prototype!==Object.prototype&&prototype!==null)return false;
 const discriminator=Object.getOwnPropertyDescriptor(value,'state');
 if(discriminator===undefined||!Object.hasOwn(discriminator,'value')||!discriminator.enumerable)return false;
 switch(discriminator.value){
  case 'pending':{
   const record=passiveRecord(value,['state','cancellationRequested','nativeOwnership']);
   return record!==null&&typeof record.cancellationRequested==='boolean'&&record.nativeOwnership==='retained-or-not-started';
  }
  case 'joined-result':{
   const record=passiveRecord(value,['state','cancellationRequested','result']);
   if(record===null||typeof record.cancellationRequested!=='boolean')return false;
   try{validateGatewayResult(record.result,maxStringUnits);return true;}catch{return false;}
  }
  case 'joined-error':{
   const record=passiveRecord(value,['state','cancellationRequested','error']);
   return record!==null&&typeof record.cancellationRequested==='boolean'&&(record.error==='adapter-failed'||record.error==='invalid-result');
  }
  case 'delivered-await-ack':{
   const record=passiveRecord(value,['state','cancellationRequested']);
   return record!==null&&typeof record.cancellationRequested==='boolean';
  }
  case 'retired-no-replay':return passiveRecord(value,['state'])!==null;
  default:return false;
 }
}
export function validateReplyEnvelope(value:unknown,epoch:string,maxResultStringUnits=NATIVE_CODEC_MAX_INPUT_BYTES+NATIVE_CODEC_RESULT_ALLOWANCE):BrokerReplyEnvelope|null {
 const record=envelopeRecord(value,epoch);
 if(record===null)return null;
 switch(record.kind){
  case 'ready-ack':
   if(record.requestId!==null||record.body!==null)return null;
   break;
  case 'terminal-ack':
   if(!isBrokerCounter(record.requestId)||record.body!==null)return null;
   break;
  case 'accepted':{
   const body=passiveRecord(record.body,['accepted']);
   if(!isBrokerCounter(record.requestId)||body===null||body.accepted!==true)return null;
   break;
  }
  case 'not-accepted':{
   const body=passiveRecord(record.body,['reason']);
   if(!isBrokerCounter(record.requestId)||body===null||!isRefusal(body.reason))return null;
   break;
  }
  case 'status':
   if(!isBrokerCounter(record.requestId)||!requestStatus(record.body,maxResultStringUnits))return null;
   break;
  case 'close-status':{
   const body=passiveRecord(record.body,['state']);
   if(record.requestId!==null||body===null||(body.state!=='closing-retained'&&body.state!=='closed-joined'))return null;
   break;
  }
  case 'protocol-error':{
   const body=passiveRecord(record.body,['code']);
   if(body===null||body.code!=='invalid-protocol')return null;
   break;
  }
  default:return null;
 }
 return value as BrokerReplyEnvelope;
}
