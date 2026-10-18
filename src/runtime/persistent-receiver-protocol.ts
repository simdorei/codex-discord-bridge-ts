import {types} from 'node:util';
import {MessagePort} from 'node:worker_threads';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {restoreServerPromptComponentTransfer} from '../discord/components.ts';
import {requireDiscordText} from '../discord/text.ts';
import {capturePersistentPromptReadRequest,capturePersistentPromptReadSuccess,type PersistentPromptReadRequest} from './persistent-prompt-read-values.ts';
import {captureNativeStoreReadDiagnostic,NativeStoreReadError,type NativeStoreReadDiagnostic} from './native-store-read-diagnostic.ts';
import {OwnedWorkerBusyError,OwnedWorkerBudgetError} from './owned-worker-slot.ts';
import {NativeControlEvidenceUnavailable} from './action-executor/control-evidence-native.ts';
import {NativeQueueReadUnavailableError} from './queue-runner/native-read-state.ts';
import {NativePromptIntakeUnavailableError} from './prompt-intake/native-state.ts';
import {CompletionHeldError,CompletionDeliveryError,isCompletionHeld} from './completion/receipt-sender.ts';
import {CompletionReceiptUnconfirmedError} from './completion/native-receipt-store.ts';

/** Closed disposable receiver value protocol. Correlation and diagnostics carry
 * no native admission, response authority, replay permission or root release. */
export type ReceiverOperation=PersistentPromptReadRequest|Readonly<{
 op:'server-prompt-chunk';channel:bigint;logicalKey:string;chunkIndex:bigint;content:string;components:string;
}>;
export type ReceiverOperationTag=ReceiverOperation['op'];
type AdmissionFailure=Readonly<{kind:'admission-unavailable';reason:'Busy'|'Budget'}>;
export type ReceiverFailure=AdmissionFailure
 |Readonly<{kind:'store';diagnostic:NativeStoreReadDiagnostic}>
 |Readonly<{kind:'native-unavailable';source:'Observed'|'List'|'MirrorTarget'}>
 |Readonly<{kind:'unclassified-read-failure'}>
 |Readonly<{kind:'held'|'delivery'|'cancelled'|'unclassified-chunk-failure'}>
 |Readonly<{kind:'receipt-unconfirmed';operation:'Begin'|'Confirm'|'Release'|'Block'}>;
export type ReceiverTerminal=Readonly<{kind:'ok';value:unknown}>|Readonly<{kind:'error';failure:ReceiverFailure}>;
export type ReceiverCommand=Readonly<{kind:'ready'|'close'|'ack-close'}>
 |Readonly<{kind:'submit';id:number;operation:ReceiverOperation}>
 |Readonly<{kind:'cancel'|'ack-terminal';id:number}>;
export type ReceiverReply=Readonly<{kind:'ready'|'closed'}>
 |Readonly<{kind:'sealed-no-admission';id:number;retiredThrough:number}>
 |Readonly<{kind:'terminal';id:number;operation:ReceiverOperationTag;result:ReceiverTerminal}>
 |Readonly<{kind:'retired';id:number}>;
export type ReceiverControlCommand=Readonly<{kind:'stop-and-join';id:number}>;
export type ReceiverControlReply=Readonly<{kind:'joined';id:number}>;
type ReceiverBody=ReceiverCommand|ReceiverReply|ReceiverControlCommand|ReceiverControlReply;
export interface ReceiverFrame<T extends ReceiverBody=ReceiverBody>{readonly version:1;readonly epoch:string;readonly body:T}
export interface ReceiverDescriptor{readonly version:1;readonly kind:'persistent-receiver-services-v1';readonly epoch:string;readonly data:MessagePort;readonly control:MessagePort}
export const RECEIVER_LIMITS=Object.freeze({
 maxId:2147483647,requestBytes:262144,chunkBytes:131072,readSuccessBytes:16777216,
 failureBytes:2048,wrapperBytes:2048,receiptKeyBytes:65536,componentBytes:8192,
 // Representation bound only. The original sender still applies its unchanged
 // 1,900-scalar content rule and original typed delivery failure.
 contentScalars:2000,valueNodes:16777216,valueEdges:16777216,valueContainers:16777216,
 successDepth:4,componentNodes:64,componentEdges:64,
});
const DOMAIN='server-request/prompt/v1',SAFE_CAUSE='Original receiver operation unavailable';
// Weak membership only recognizes immutable locally captured value records. It
// retains no history and provides no business/native authority.
const capturedOperations=new WeakSet<object>();
const JOB_KEYS=Object.freeze(['jobId','targetThreadId','channelId','ownerUserId','discordMessageId',
 'appServerGeneration','executionGeneration','turnObservationGeneration','goalWaiting','prompt',
 'queued','ackSent','state','attemptCount','turnId','baselineTurnIds','lastError','createdAt','updatedAt']);
function invalid():never{throw new TypeError('Invalid persistent receiver protocol value');}
function record(value:unknown):Record<string,unknown>{
 if(value===null||typeof value!=='object'||types.isProxy(value)||Array.isArray(value))invalid();
 const p=Object.getPrototypeOf(value);if(p!==Object.prototype&&p!==null)invalid();return value as Record<string,unknown>;
}
function data(value:object,key:string):unknown{
 const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))invalid();return d.value;
}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
 const r=record(value),actual=Reflect.ownKeys(r);if(actual.length!==keys.length||actual.some(k=>typeof k!=='string'||!keys.includes(k)))invalid();
 for(const key of keys)data(r,key);return r;
}
function bounded(value:unknown,bytes:number):void{if(boundedSerdeByteCount(value,bytes)===null)invalid();}
function epoch(value:unknown):asserts value is string{if(typeof value!=='string'||!/^[0-9a-f]{32}$/.test(value))invalid();}
function id(value:unknown,allowZero=false):asserts value is number{
 if(typeof value!=='number'||!Number.isSafeInteger(value)||Object.is(value,-0)||value<(allowZero?0:1)||value>RECEIVER_LIMITS.maxId)invalid();
}
function dense(value:unknown):asserts value is unknown[]{
 if(value===null||typeof value!=='object'||types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)invalid();
 const length=Object.getOwnPropertyDescriptor(value,'length')?.value;
 if(!Number.isSafeInteger(length)||length<0||length>RECEIVER_LIMITS.valueContainers||Reflect.ownKeys(value).length!==length+1)invalid();
 for(let i=0;i<length;i++)data(value,String(i));
}
/** No path, guard, callback, domain selector or prepared HTTP request crosses. */
export function captureReceiverOperation(input:unknown):ReceiverOperation{
 if(input!==null&&typeof input==='object'&&capturedOperations.has(input))return input as ReceiverOperation;
 const source=record(input),op=data(source,'op');
 if(op!=='server-prompt-chunk'){
  const captured=capturePersistentPromptReadRequest(input);bounded(captured,RECEIVER_LIMITS.requestBytes);capturedOperations.add(captured);return captured;
 }
 const q=exact(source,['op','channel','logicalKey','chunkIndex','content','components']);
 if(typeof q.channel!=='bigint'||q.channel<=0n||q.channel>=(1n<<63n)||typeof q.chunkIndex!=='bigint'||q.chunkIndex<0n||q.chunkIndex>=(1n<<64n))invalid();
 requireDiscordText(q.logicalKey);requireDiscordText(q.content);requireDiscordText(q.components);
 bounded(q,RECEIVER_LIMITS.chunkBytes);
 // This is the exact original serialized receipt key boundary, without a new
 // restriction on request-ID material inside logicalKey.
 bounded([q.channel,DOMAIN,q.logicalKey,q.chunkIndex],RECEIVER_LIMITS.receiptKeyBytes);
 let scalars=0;for(const _ of q.content)if(++scalars>RECEIVER_LIMITS.contentScalars)invalid();
 restoreServerPromptComponentTransfer(q.components);
 const captured=Object.freeze({op,channel:q.channel,logicalKey:q.logicalKey,chunkIndex:q.chunkIndex,content:q.content,components:q.components});capturedOperations.add(captured);return captured;
}
function readSource(operation:PersistentPromptReadRequest):'Observed'|'List'|'MirrorTarget'{
 return operation.op==='observed-completion'?'Observed':operation.op==='all-jobs'?'List':'MirrorTarget';
}
function captureFailure(operation:ReceiverOperation,input:unknown):ReceiverFailure{
 const f=record(input),kind=data(f,'kind');let result:ReceiverFailure;
 if(kind==='admission-unavailable'){
  exact(f,['kind','reason']);if(f.reason!=='Busy'&&f.reason!=='Budget')invalid();result=Object.freeze({kind,reason:f.reason});
 }else if(operation.op==='server-prompt-chunk'){
  if(kind==='held'||kind==='delivery'||kind==='cancelled'||kind==='unclassified-chunk-failure'){exact(f,['kind']);result=Object.freeze({kind});}
  else if(kind==='receipt-unconfirmed'){
   exact(f,['kind','operation']);if(f.operation!=='Begin'&&f.operation!=='Confirm'&&f.operation!=='Release'&&f.operation!=='Block')invalid();
   result=Object.freeze({kind,operation:f.operation});
  }else invalid();
 }else if(kind==='store'){
  exact(f,['kind','diagnostic']);result=Object.freeze({kind,diagnostic:captureNativeStoreReadDiagnostic(f.diagnostic)});
 }else if(kind==='native-unavailable'){
  exact(f,['kind','source']);const source=readSource(operation);if(f.source!==source)invalid();result=Object.freeze({kind,source});
 }else if(kind==='unclassified-read-failure'){exact(f,['kind']);result=Object.freeze({kind});}
 else invalid();
 bounded(result,RECEIVER_LIMITS.failureBytes);return result;
}
/** Check the original byte envelope first. Then validate the closed shape and
 * depth/count inventory before the original successful-value codec clones it.
 * No arbitrary object can be visited as a job field. Counts cannot lower the
 * native byte domain: every counted item consumes at least one serialized byte. */
function readSuccessShape(operation:PersistentPromptReadRequest,value:unknown):void{
 if(operation.op==='observed-completion'){if(typeof value!=='boolean')invalid();return;}
 if(operation.op==='channel-mapping'){
  if(value!==null)requireDiscordText(value);
  bounded({ok:true,operation:'MirrorTarget',value:{channel:operation.channel,target:value}},RECEIVER_LIMITS.readSuccessBytes);return;
 }
 bounded({ok:true,value},RECEIVER_LIMITS.readSuccessBytes);dense(value);
 let nodes=3,edges=2,containers=2;
 const charge=(n:number,e:number,c:number)=>{nodes+=n;edges+=e;containers+=c;if(nodes>RECEIVER_LIMITS.valueNodes||edges>RECEIVER_LIMITS.valueEdges||containers>RECEIVER_LIMITS.valueContainers)invalid();};
 for(const input of value){
  const row=exact(input,JOB_KEYS);charge(1,1,1);
  for(const key of JOB_KEYS){
   const field=row[key];charge(1,1,0);
   if(key==='baselineTurnIds'){
    dense(field);charge(0,0,1);for(const turn of field){requireDiscordText(turn);charge(1,1,0);}
   }else if(field!==null&&typeof field!=='string'&&typeof field!=='number'&&typeof field!=='bigint'&&typeof field!=='boolean')invalid();
  }
 }
}
export function captureReceiverTerminal(operation:ReceiverOperation,input:unknown):ReceiverTerminal{
 const original=captureReceiverOperation(operation),r=record(input),kind=data(r,'kind');
 if(kind==='error'){exact(r,['kind','failure']);return Object.freeze({kind,failure:captureFailure(original,r.failure)});}
 if(kind!=='ok')invalid();exact(r,['kind','value']);
 if(original.op==='server-prompt-chunk'){if(r.value!==null)invalid();return Object.freeze({kind,value:null});}
 readSuccessShape(original,r.value);
 const success=capturePersistentPromptReadSuccess(original,{op:original.op,value:r.value});
 return Object.freeze({kind,value:success.value});
}
function genuine(error:unknown,prototype:object):error is Error{
 return error!==null&&typeof error==='object'&&!types.isProxy(error)&&types.isNativeError(error)&&Object.getPrototypeOf(error)===prototype;
}
const abortState=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!;
const abortReason=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'reason')!.get!;
function cancellation(signal:AbortSignal|undefined):{aborted:boolean;reason:unknown}{
 if(signal===undefined)return {aborted:false,reason:undefined};if(types.isProxy(signal))invalid();
 return {aborted:Reflect.apply(abortState,signal,[]) as boolean,reason:Reflect.apply(abortReason,signal,[])};
}
/** Called only after the owner's fixed original operation rejects. Prototype and
 * original class/held provenance are required; names, text and nested causes
 * never classify an error or recreate private non-submission evidence. */
export function projectReceiverFailure(operation:ReceiverOperation,error:unknown,signal?:AbortSignal):ReceiverFailure{
 const original=captureReceiverOperation(operation),unknown:ReceiverFailure=Object.freeze({kind:original.op==='server-prompt-chunk'?'unclassified-chunk-failure':'unclassified-read-failure'});
 try{
  if(original.op==='server-prompt-chunk'){
   const state=cancellation(signal);if(state.aborted&&error===state.reason)return Object.freeze({kind:'cancelled'});
  }
  if(genuine(error,OwnedWorkerBudgetError.prototype))return Object.freeze({kind:'admission-unavailable',reason:'Budget'});
  if(genuine(error,OwnedWorkerBusyError.prototype))return Object.freeze({kind:'admission-unavailable',reason:'Busy'});
  if(original.op==='server-prompt-chunk'){
   if(isCompletionHeld(error))return Object.freeze({kind:'held'});
   if(genuine(error,CompletionDeliveryError.prototype))return Object.freeze({kind:'delivery'});
   if(genuine(error,CompletionReceiptUnconfirmedError.prototype))return captureFailure(original,{kind:'receipt-unconfirmed',operation:data(error,'operation')});
  }else{
   if(genuine(error,NativeStoreReadError.prototype))return captureFailure(original,{kind:'store',diagnostic:data(error,'diagnostic')});
   const source=readSource(original);
   if((source==='Observed'&&genuine(error,NativeControlEvidenceUnavailable.prototype))
    ||(source==='List'&&genuine(error,NativeQueueReadUnavailableError.prototype)&&data(error,'operation')==='List')
    ||(source==='MirrorTarget'&&genuine(error,NativePromptIntakeUnavailableError.prototype)&&data(error,'operation')==='MirrorTarget'))return Object.freeze({kind:'native-unavailable',source});
  }
 }catch{return unknown;}
 return unknown;
}
export class PersistentPromptReadUnclassifiedError extends Error{
 readonly operation:PersistentPromptReadRequest['op'];
 constructor(operation:PersistentPromptReadRequest['op']){super('Original persistent prompt read failed without a classified diagnostic');this.name='PersistentPromptReadUnclassifiedError';this.operation=operation;}
}
export class PersistentPromptChunkUnclassifiedError extends Error{
 constructor(){super('Original persistent prompt chunk failed without a classified diagnostic; no replay permission');this.name='PersistentPromptChunkUnclassifiedError';}
}
export function throwReceiverFailure(operation:ReceiverOperation,input:ReceiverFailure,localSignal?:AbortSignal):never{
 const original=captureReceiverOperation(operation),failure=captureFailure(original,input);
 switch(failure.kind){
  case 'store':throw new NativeStoreReadError(failure.diagnostic);
  case 'admission-unavailable':throw failure.reason==='Budget'?new OwnedWorkerBudgetError():new OwnedWorkerBusyError();
  case 'native-unavailable':
   if(failure.source==='Observed')throw new NativeControlEvidenceUnavailable(new Error(SAFE_CAUSE));
   if(failure.source==='List')throw new NativeQueueReadUnavailableError('List',new Error(SAFE_CAUSE));
   throw new NativePromptIntakeUnavailableError('MirrorTarget',new Error(SAFE_CAUSE));
  case 'unclassified-read-failure':if(original.op==='server-prompt-chunk')invalid();throw new PersistentPromptReadUnclassifiedError(original.op);
  case 'held':throw new CompletionHeldError('Original persistent prompt output remains held');
  case 'delivery':throw new CompletionDeliveryError('Original persistent prompt delivery failed');
  case 'receipt-unconfirmed':throw new CompletionReceiptUnconfirmedError(failure.operation,new Error(SAFE_CAUSE));
  case 'cancelled':{const state=cancellation(localSignal);if(!state.aborted)invalid();throw state.reason;}
  case 'unclassified-chunk-failure':throw new PersistentPromptChunkUnclassifiedError();
 }
}
function envelope(input:unknown,expectedEpoch:string):Record<string,unknown>{
 epoch(expectedEpoch);const f=exact(input,['version','epoch','body']);if(f.version!==1||f.epoch!==expectedEpoch)invalid();return record(f.body);
}
function wrapper(epochValue:string,body:unknown):void{bounded({version:1,epoch:epochValue,body},RECEIVER_LIMITS.wrapperBytes);}
export function receiverFrame<T extends ReceiverBody>(epochValue:string,body:T):ReceiverFrame<T>{epoch(epochValue);return Object.freeze({version:1,epoch:epochValue,body});}
export function captureReceiverCommand(input:unknown,expectedEpoch:string):ReceiverCommand{
 const body=envelope(input,expectedEpoch),kind=data(body,'kind');
 if(kind==='ready'||kind==='close'||kind==='ack-close'){exact(body,['kind']);wrapper(expectedEpoch,body);return Object.freeze({kind});}
 if(kind==='submit'){
  exact(body,['kind','id','operation']);id(body.id);wrapper(expectedEpoch,{kind,id:body.id,operation:null});
  return Object.freeze({kind,id:body.id,operation:captureReceiverOperation(body.operation)});
 }
 if(kind==='cancel'||kind==='ack-terminal'){exact(body,['kind','id']);id(body.id);wrapper(expectedEpoch,body);return Object.freeze({kind,id:body.id});}
 invalid();
}
export function captureReceiverReply(input:unknown,expectedEpoch:string,expectedOperation?:ReceiverOperation):ReceiverReply{
 const body=envelope(input,expectedEpoch),kind=data(body,'kind');
 if(kind==='ready'||kind==='closed'){exact(body,['kind']);wrapper(expectedEpoch,body);return Object.freeze({kind});}
 if(kind==='retired'){exact(body,['kind','id']);id(body.id);wrapper(expectedEpoch,body);return Object.freeze({kind,id:body.id});}
 if(kind==='sealed-no-admission'){exact(body,['kind','id','retiredThrough']);id(body.id);id(body.retiredThrough,true);if(body.id!==(body.retiredThrough as number)+1)invalid();wrapper(expectedEpoch,body);return Object.freeze({kind,id:body.id,retiredThrough:body.retiredThrough});}
 if(kind==='terminal'){
  exact(body,['kind','id','operation','result']);id(body.id);if(expectedOperation===undefined)invalid();
  const operation=captureReceiverOperation(expectedOperation);if(body.operation!==operation.op)invalid();
  const result=record(body.result),resultKind=data(result,'kind');
  if(resultKind!=='ok'&&resultKind!=='error')invalid();
  wrapper(expectedEpoch,{kind,id:body.id,operation:operation.op,result:resultKind==='ok'?{kind:resultKind,value:null}:{kind:resultKind,failure:null}});
  return Object.freeze({kind,id:body.id,operation:operation.op,result:captureReceiverTerminal(operation,body.result)});
 }
 invalid();
}
export function captureReceiverControlCommand(input:unknown,expectedEpoch:string):ReceiverControlCommand{
 const body=exact(envelope(input,expectedEpoch),['kind','id']);if(body.kind!=='stop-and-join')invalid();id(body.id,true);wrapper(expectedEpoch,body);return Object.freeze({kind:'stop-and-join',id:body.id});
}
export function captureReceiverControlReply(input:unknown,expectedEpoch:string):ReceiverControlReply{
 const body=exact(envelope(input,expectedEpoch),['kind','id']);if(body.kind!=='joined')invalid();id(body.id,true);wrapper(expectedEpoch,body);return Object.freeze({kind:'joined',id:body.id});
}
function port(input:unknown):asserts input is MessagePort{
 if(input===null||typeof input!=='object'||types.isProxy(input)||Object.getPrototypeOf(input)!==MessagePort.prototype)invalid();
 // Intrinsic receiver validation rejects Object.create(MessagePort.prototype).
 try{if(typeof MessagePort.prototype.hasRef.call(input)!=='boolean')invalid();}catch{invalid();}
}
export function captureReceiverDescriptor(input:unknown):ReceiverDescriptor{
 const d=exact(input,['version','kind','epoch','data','control']);
 if(d.version!==1||d.kind!=='persistent-receiver-services-v1')invalid();epoch(d.epoch);port(d.data);port(d.control);if(d.data===d.control)invalid();
 return Object.freeze({version:1,kind:'persistent-receiver-services-v1',epoch:d.epoch,data:d.data,control:d.control});
}
