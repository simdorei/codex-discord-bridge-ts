import {MessagePort} from 'node:worker_threads';
import {types} from 'node:util';
import {captureServerPromptComponentTransfer,type DiscordComponent} from '../discord/components.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import type {IdempotentChunk} from './completion/receipt-sender.ts';
import {requirePersistentResidentStoreOpen} from './persistent-resident-bootstrap.ts';
import {SERVER_REQUEST_PROMPT_DOMAIN} from './server-prompt-identity.ts';
import type {PromptAuthorityReads} from './server-prompt-authority-reads.ts';
import {
 RECEIVER_LIMITS,captureReceiverDescriptor,captureReceiverOperation,captureReceiverReply,
 captureReceiverControlReply,receiverFrame,throwReceiverFailure,
 type ReceiverDescriptor,type ReceiverOperation,type ReceiverTerminal,type ReceiverCommand,
} from './persistent-receiver-protocol.ts';

/** A joined failed bridge exchange says nothing about business acceptance or
 * replay. It is deliberately distinct from every original read/sender error. */
export class PersistentReceiverBridgeUnconfirmedError extends Error{
 readonly operation:ReceiverOperation['op']|null;
 constructor(operation:ReceiverOperation['op']|null=null){super('Persistent receiver exchange unconfirmed; service admission permanently closed');this.name='PersistentReceiverBridgeUnconfirmedError';this.operation=operation;}
}
type Phase='Boot'|'Idle'|'WaitingTerminal'|'WaitingRetired'|'Closing'|'ClosingAck'|'Closed';
interface Deferred<T>{readonly promise:Promise<T>;readonly resolve:(value:T)=>void;readonly reject:(reason:unknown)=>void}
function deferred<T>():Deferred<T>{let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
interface Slot extends Deferred<unknown>{
 readonly id:number;readonly operation:ReceiverOperation;readonly signal:AbortSignal|undefined;
 terminal:ReceiverTerminal|null;posted:boolean;cancelSent:boolean;abortListener:(()=>void)|null;
}
const signalAborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!;
const throwIfAborted=AbortSignal.prototype.throwIfAborted;
const addAbort=EventTarget.prototype.addEventListener,removeAbort=EventTarget.prototype.removeEventListener;
const onPort=MessagePort.prototype.on,startPort=MessagePort.prototype.start,postPort=MessagePort.prototype.postMessage,closePort=MessagePort.prototype.close;
const claimedPorts=new WeakSet<MessagePort>();
function aborted(signal:AbortSignal):boolean{return Reflect.apply(signalAborted,signal,[]) as boolean;}
function checkSignal(signal:AbortSignal|undefined):void{
 if(signal!==undefined){if(types.isProxy(signal)||!(signal instanceof AbortSignal))throw new TypeError('Expected original receiver cancellation signal');Reflect.apply(throwIfAborted,signal,[]);}
}

/** One construction-bound receiver, one serial slot, and no queued operations.
 * A terminal is original task-join evidence; terminal acknowledgement is only
 * retirement bookkeeping. Faults never turn elapsed time or port closure into
 * an operation join. This client cannot construct a main-owned service. */
export class PersistentReceiverServicesClient{
 readonly #path:string;readonly #epoch:string;readonly #data:MessagePort;readonly #control:MessagePort;
 readonly #failure=new AbortController();
 #phase:Phase='Boot';#sealed=false;#dataFault=false;#controlFault=false;
 #dataClosed=false;#controlClosed=false;#highWater=0;#retiredThrough=0;
 #slot:Slot|null=null;#ready:Deferred<void>|null=null;#close:Deferred<void>|null=null;
 #stopId:number|null=null;#controlJoined=false;#faultClosureReady=false;
 constructor(path:string,input:ReceiverDescriptor){
  requirePersistentResidentStoreOpen(path);const descriptor=captureReceiverDescriptor(input);
  if(claimedPorts.has(descriptor.data)||claimedPorts.has(descriptor.control))throw new TypeError('Persistent receiver ports already belong to a client');
  claimedPorts.add(descriptor.data);claimedPorts.add(descriptor.control);
  this.#path=path;this.#epoch=descriptor.epoch;this.#data=descriptor.data;this.#control=descriptor.control;
  onPort.call(this.#data,'message',this.#onData);onPort.call(this.#data,'messageerror',this.#onDataFault);onPort.call(this.#data,'error',this.#onDataFault);onPort.call(this.#data,'close',this.#onDataClose);
  onPort.call(this.#control,'message',this.#onControl);onPort.call(this.#control,'messageerror',this.#onControlFault);onPort.call(this.#control,'error',this.#onControlFault);onPort.call(this.#control,'close',this.#onControlClose);
  startPort.call(this.#data);startPort.call(this.#control);Object.freeze(this);
 }
 get failure():AbortSignal{return this.#failure.signal;}
 get closed():boolean{return this.#phase==='Closed';}
 /** Only actual terminal/control join evidence can clear a posted slot. This
  * does not assert clean endpoint retirement or component/root release. */
 get joined():boolean{return this.#slot===null;}
 snapshot(){return Object.freeze({phase:this.#phase,sealed:this.#sealed,highWater:this.#highWater,retiredThrough:this.#retiredThrough,
  pendingId:this.#slot?.id??null,pendingOperation:this.#slot?.operation.op??null,terminalKnown:this.#slot?.terminal!==null&&this.#slot!==null,
  cancelSent:this.#slot?.cancelSent??false,stopRequested:this.#stopId!==null,controlJoined:this.#controlJoined,
  dataFault:this.#dataFault,controlFault:this.#controlFault,dataClosed:this.#dataClosed,controlClosed:this.#controlClosed,joined:this.#slot===null,closed:this.#phase==='Closed'});}
 ready():Promise<void>{
  if(this.#ready!==null)return this.#ready.promise;
  if(this.#sealed||this.#phase!=='Boot')return Promise.reject(new PersistentReceiverBridgeUnconfirmedError());
  this.#ready=deferred<void>();this.#postData({kind:'ready'});return this.#ready.promise;
 }
 /** Original functions close over this exact client and verify the pinned path
  * before capture/post. No caller callback or arbitrary transport is accepted. */
 promptReads():PromptAuthorityReads{
  const pinned=this.#path,check=(path:string)=>{if(path!==pinned)throw new TypeError('Persistent receiver reads belong to another database');};
  return Object.freeze({
   hasObservedCompletion:async(path,thread,turn)=>{check(path);return await this.#call({op:'observed-completion',thread,turn}) as Awaited<ReturnType<PromptAuthorityReads['hasObservedCompletion']>>;},
   listQueueJobs:async path=>{check(path);return await this.#call({op:'all-jobs'}) as Awaited<ReturnType<PromptAuthorityReads['listQueueJobs']>>;},
   mirroredThreadId:async(path,channel)=>{check(path);return await this.#call({op:'channel-mapping',channel}) as Awaited<ReturnType<PromptAuthorityReads['mirroredThreadId']>>;},
  });
 }
 async sendChunk(channel:bigint,chunk:IdempotentChunk,components:readonly DiscordComponent[],signal?:AbortSignal):Promise<void>{
  // In particular, pre-abort precedes component capture and ID reservation.
  checkSignal(signal);
  if(own(chunk,'domain')!==SERVER_REQUEST_PROMPT_DOMAIN)throw new TypeError('Expected original server prompt domain');
  const index=own(chunk,'chunkIndex');
  if((typeof index!=='bigint'&&typeof index!=='number')||(typeof index==='number'&&(!Number.isSafeInteger(index)||index<0)))throw new TypeError('Expected original lossless chunk index');
  await this.#call({op:'server-prompt-chunk',channel,logicalKey:own(chunk,'logicalKey'),chunkIndex:BigInt(index),content:own(chunk,'content'),components:captureServerPromptComponentTransfer(components)},signal);
 }
 close():Promise<void>{
  if(this.#close!==null)return this.#close.promise;
  if(this.#sealed)return Promise.reject(new PersistentReceiverBridgeUnconfirmedError(this.#slot?.operation.op??null));
  if(this.#phase!=='Idle'||this.#slot!==null)return Promise.reject(new TypeError('Receiver services must be idle and joined before close'));
  this.#close=deferred<void>();this.#phase='Closing';this.#postData({kind:'close'});return this.#close.promise;
 }
 #call(input:unknown,signal?:AbortSignal):Promise<unknown>{
  checkSignal(signal);
  if(this.#sealed)throw new PersistentReceiverBridgeUnconfirmedError();
  if(this.#phase!=='Idle'||this.#slot!==null)throw new TypeError('Persistent receiver has no serial operation credit');
  if(this.#highWater>=RECEIVER_LIMITS.maxId)throw new RangeError('Persistent receiver operation IDs exhausted');
  const operation=captureReceiverOperation(input),id=this.#highWater+1;
  const slot:Slot={...deferred<unknown>(),id,operation,signal,terminal:null,posted:false,cancelSent:false,abortListener:null};
  this.#slot=slot;this.#phase='WaitingTerminal';
  // Frame construction is still local. Never consume an ID before the actual
  // post boundary; a post exception itself cannot prove non-submission.
  let frame:ReturnType<typeof receiverFrame>;
  try{
   if(signal!==undefined){slot.abortListener=()=>this.#cancel(slot);Reflect.apply(addAbort,signal,['abort',slot.abortListener,{once:true}]);}
   frame=receiverFrame(this.#epoch,{kind:'submit',id,operation});if(signal!==undefined)Reflect.apply(throwIfAborted,signal,[]);
  }
  catch(error){this.#removeAbort(slot);this.#slot=null;this.#phase='Idle';slot.reject(error);return slot.promise;}
  this.#highWater=id;slot.posted=true;
  try{postPort.call(this.#data,frame);}catch{this.#failData();}
  if(signal!==undefined&&aborted(signal))this.#cancel(slot);
  return slot.promise;
 }
 #removeAbort(slot:Slot):void{
  if(slot.signal!==undefined&&slot.abortListener!==null)Reflect.apply(removeAbort,slot.signal,['abort',slot.abortListener]);slot.abortListener=null;
 }
 #cancel(slot:Slot):void{
  if(this.#slot!==slot||!slot.posted||slot.cancelSent||slot.terminal!==null||this.#dataFault||this.#phase!=='WaitingTerminal')return;
  if(slot.operation.op!=='server-prompt-chunk'||slot.signal===undefined||!aborted(slot.signal))return;
  slot.cancelSent=true;this.#postData({kind:'cancel',id:slot.id});
 }
 #postData(body:ReceiverCommand):void{
  if(this.#dataFault)return;
  try{postPort.call(this.#data,receiverFrame(this.#epoch,body));}catch{this.#failData();}
 }
 #seal():void{
  if(this.#sealed)return;this.#sealed=true;
  const error=new PersistentReceiverBridgeUnconfirmedError(this.#slot?.operation.op??null);
  this.#ready?.reject(error);this.#close?.reject(error);
  // The composition listener starts abnormal resident disposal immediately,
  // without awaiting a slot whose original service join may be unavailable.
  this.#failure.abort(error);
 }
 #failData():void{
  if(this.#phase==='Closed'||this.#dataFault)return;
  this.#dataFault=true;this.#seal();this.#stopAndJoin();
  // A previously validated business terminal already establishes actual join.
  // Its exact result survives loss of retirement or the independent control.
  if(this.#slot?.terminal!==null&&this.#slot!==null)this.#settle(this.#slot);
  this.#closeFaultedPorts();
 }
 #failControl():void{
  if(this.#phase==='Closed'||this.#controlFault)return;this.#controlFault=true;
  // With no slot, every submitted operation was already truly joined (or none
  // was ever submitted). Losing control cannot create an unjoined operation.
  if(this.#slot===null)this.#faultClosureReady=true;
  this.#seal();if(this.#slot!==null&&this.#slot.terminal!==null)this.#settle(this.#slot);this.#closeFaultedPorts();
 }
 #closeFaultedPorts():void{
  if(!this.#sealed||this.#slot!==null||(!this.#controlJoined&&!this.#faultClosureReady))return;
  // No posted slot can disappear without true join evidence. Once there is no
  // work left to join, release physical port handles so abnormal child disposal
  // need not await worker exit while main itself awaits that same worker exit.
  // Permanent quarantine and closed=false survive these physical closures.
  try{closePort.call(this.#data);}catch{/* Actual close observations remain required. */}
  try{closePort.call(this.#control);}catch{/* Actual close observations remain required. */}
 }
 #stopAndJoin():void{
  if(this.#stopId!==null)return;
  this.#stopId=this.#slot?.id??this.#highWater;
  if(this.#controlFault)return;
  try{postPort.call(this.#control,receiverFrame(this.#epoch,{kind:'stop-and-join',id:this.#stopId}));}catch{this.#failControl();}
 }
 #onDataFault=():void=>{this.#failData();};
 #onControlFault=():void=>{this.#failControl();};
 #onDataClose=():void=>{this.#dataClosed=true;if(this.#phase==='ClosingAck'&&!this.#sealed)this.#finishClose();else if(this.#phase!=='Closed')this.#failData();};
 #onControlClose=():void=>{this.#controlClosed=true;if(this.#phase==='ClosingAck'&&!this.#sealed)this.#finishClose();else if(this.#phase!=='Closed')this.#failControl();};
 #finishClose():void{if(this.#phase==='ClosingAck'&&!this.#sealed&&this.#dataClosed&&this.#controlClosed){this.#phase='Closed';this.#close!.resolve();}}
 #onData=(raw:unknown):void=>{
  if(this.#dataFault||this.#phase==='Closed')return;
  try{
   const slot=this.#slot,reply=captureReceiverReply(raw,this.#epoch,slot?.operation);
   if(reply.kind==='sealed-no-admission'){
    if(slot===null||!slot.posted||slot.terminal!==null||this.#phase!=='WaitingTerminal'||reply.id!==slot.id||reply.id!==this.#highWater||reply.retiredThrough!==this.#retiredThrough)throw new TypeError('Unexpected receiver no-admission proof');
    this.#seal();this.#removeAbort(slot);this.#slot=null;this.#phase='Idle';this.#faultClosureReady=true;slot.reject(new PersistentReceiverBridgeUnconfirmedError(slot.operation.op));this.#closeFaultedPorts();return;
   }
   if(reply.kind==='ready'){
    if(this.#sealed||this.#phase!=='Boot'||this.#ready===null)throw new TypeError('Unexpected receiver ready');
    this.#phase='Idle';this.#ready.resolve();return;
   }
   if(reply.kind==='terminal'){
    if(slot===null||this.#phase!=='WaitingTerminal'||reply.id!==slot.id||reply.id<=this.#retiredThrough||reply.operation!==slot.operation.op||slot.terminal!==null)throw new TypeError('Unexpected receiver terminal');
    if(reply.result.kind==='error'&&reply.result.failure.kind==='cancelled'&&(slot.signal===undefined||!aborted(slot.signal)))throw new TypeError('Receiver cancellation has no matching local signal');
    slot.terminal=reply.result;this.#removeAbort(slot);this.#phase='WaitingRetired';this.#postData({kind:'ack-terminal',id:slot.id});return;
   }
   if(reply.kind==='retired'){
    if(slot===null||this.#phase!=='WaitingRetired'||slot.terminal===null||reply.id!==slot.id||reply.id<=this.#retiredThrough)throw new TypeError('Unexpected receiver retirement');
    this.#retiredThrough=slot.id;this.#settle(slot);return;
   }
   if(this.#sealed||this.#phase!=='Closing'||this.#close===null||slot!==null)throw new TypeError('Unexpected receiver close');
   this.#phase='ClosingAck';this.#postData({kind:'ack-close'});
  }catch{this.#failData();}
 };
 #onControl=(raw:unknown):void=>{
  if(this.#controlFault||this.#phase==='Closed')return;
  try{
   const reply=captureReceiverControlReply(raw,this.#epoch);
   if(this.#stopId===null||reply.id!==this.#stopId||this.#controlJoined)throw new TypeError('Unexpected receiver join');
   this.#controlJoined=true;
   if(this.#slot!==null)this.#settle(this.#slot);
   this.#closeFaultedPorts();
  }catch{this.#failControl();}
 };
 #settle(slot:Slot):void{
  if(this.#slot!==slot)return;
  if(slot.terminal===null&&!this.#controlJoined)return;
  if(this.#sealed)this.#faultClosureReady=true;
  this.#removeAbort(slot);this.#slot=null;this.#phase='Idle';
  const terminal=slot.terminal;
  if(terminal===null)slot.reject(new PersistentReceiverBridgeUnconfirmedError(slot.operation.op));
  else if(terminal.kind==='ok')slot.resolve(terminal.value);
  else try{throwReceiverFailure(slot.operation,terminal.failure,slot.signal);}catch(error){slot.reject(error);}
  this.#closeFaultedPorts();
 }
}
Object.freeze(PersistentReceiverServicesClient.prototype);
