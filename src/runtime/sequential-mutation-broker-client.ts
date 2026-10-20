import {requirePersistentResidentRole} from './persistent-resident-bootstrap.ts';
import {performance} from 'node:perf_hooks';
import {types} from 'node:util';
import {isMainThread,MessagePort,parentPort} from 'node:worker_threads';
import {validateRequestId,type RequestId} from '../protocol/ids.ts';
import {captureSequentialMutationClaim,validateSequentialMutationBootstrapDescriptor,validateSequentialMutationBrokerLimits,validateSequentialMutationReply,sequentialMutationExchangeReservation} from './sequential-mutation-broker-protocol.ts';
import type {SequentialMutationBrokerLimits,SequentialMutationBrokerRequestBody as Request,SequentialMutationBrokerReplyBody as Reply,SequentialMutationBrokerEnvelope,SequentialMutationOperation,SequentialMutationOutcome,SequentialMutationClaim} from './sequential-mutation-broker-protocol.ts';

export class BusyBeforePost extends Error {constructor(){super('Sequential mutation slot is busy');this.name='BusyBeforePost';}}
export class InvalidInputBeforePost extends Error {constructor(){super('Invalid sequential mutation input');this.name='InvalidInputBeforePost';}}
export class ClosedBeforePost extends Error {constructor(){super('Sequential mutation admission is closed');this.name='ClosedBeforePost';}}
export class SequenceExhaustedBeforePost extends Error {constructor(){super('Sequential mutation sequence cannot reserve a complete operation');this.name='SequenceExhaustedBeforePost';}}
export class BrokerOutcomeUnknown extends Error {constructor(){super('Sequential mutation outcome or sequencing is unknown; do not replay');this.name='BrokerOutcomeUnknown';}}
export interface PreparedHandle {readonly operationId:number}
export interface SequentialMutationClient {
 readonly limits:SequentialMutationBrokerLimits;
 beginOrdinary(claim:unknown):Promise<PreparedHandle>;
 beginQueue(claim:unknown):Promise<PreparedHandle>;
 beginStop(claim:unknown):Promise<PreparedHandle>;
 finish(handle:PreparedHandle,outcome:SequentialMutationOutcome):Promise<void>;
 stopNewWork():Promise<void>;
 quarantine(handle:PreparedHandle|null):void;
 closeIdle():Promise<void>;
 ownsUnsubmittedFailure(error:unknown,attemptId:string,wire:RequestId,method:string):boolean;
 snapshot():Readonly<{state:string;accepting:boolean;exchange:number;operationId:number|null;retiredThrough:number;knownFinishOperationId:number|null}>;
}
const clients=new WeakSet<object>();
export function isSequentialMutationClient(value:unknown):value is SequentialMutationClient{return value!==null&&typeof value==='object'&&clients.has(value);}
const postPort=MessagePort.prototype.postMessage,closePort=MessagePort.prototype.close;
const hasPortRef=MessagePort.prototype.hasRef;
function isNativePort(value:unknown):value is MessagePort {
 if(value===null||typeof value!=='object'||types.isProxy(value))return false;
 if(Object.getPrototypeOf(value)!==MessagePort.prototype)return false;
 try{hasPortRef.call(value);return true;}catch{return false;}
}
function closeTransferredPort(value:unknown):void {
 if(value===null||typeof value!=='object'||types.isProxy(value))return;
 const descriptor=Object.getOwnPropertyDescriptor(value,'port');
 if(descriptor!==undefined&&Object.hasOwn(descriptor,'value')&&isNativePort(descriptor.value))closePort.call(descriptor.value);
}
interface Bootstrap {readonly epoch:string;readonly limits:SequentialMutationBrokerLimits;readonly port:MessagePort}
function readBootstrap(value:unknown):Bootstrap|null {
 if(value===null||typeof value!=='object'||types.isProxy(value))return null;
 const prototype=Object.getPrototypeOf(value);
 if(prototype!==Object.prototype&&prototype!==null)return null;
 if(Object.getOwnPropertySymbols(value).length!==0)return null;
 const keys=['version','kind','epoch','limits','port'],names=Object.getOwnPropertyNames(value);
 if(names.length!==keys.length)return null;
 for(const key of names){
  const d=Object.getOwnPropertyDescriptor(value,key);
  if(!keys.includes(key)||d===undefined||!d.enumerable||!Object.hasOwn(d,'value'))return null;
 }
 const record=value as Record<string,unknown>;
 if(record.version!==2||record.kind!=='sequential-mutation-broker-bootstrap'||
  typeof record.epoch!=='string'||!/^[0-9a-f]{32}$/.test(record.epoch)||!isNativePort(record.port))return null;
 try{
  const limits=validateSequentialMutationBrokerLimits(record.limits);
  validateSequentialMutationBootstrapDescriptor(record.epoch,limits);
  return {epoch:record.epoch,limits,port:record.port};
 }catch{return null;}
}
type State='handshaking'|'ready'|'beginning'|'prepared'|'finishing'|'closing'|'closed'|'quarantined';
interface Pending {readonly exchange:number;readonly resolve:(reply:Reply)=>void;readonly reject:(error:Error)=>void}
interface StopLatch {readonly promise:Promise<void>;readonly resolve:()=>void;readonly reject:(error:Error)=>void;dispatched:boolean;settled:boolean}
function createPrivateClient(bootstrap:Bootstrap,ready:(client:SequentialMutationClient)=>void,rejectReady:(error:Error)=>void,stopped:()=>void):{fail:()=>void} {
 const {port,epoch,limits}=bootstrap;
 const handles=new WeakMap<object,{id:number;used:boolean}>();
 const unsubmitted=new WeakMap<object,{attemptId:string;wire:RequestId;method:string}>();
 let state:State='handshaking',accepting=false,pending:Pending|null=null;
 let exchange=0,nextOperationId=1,activeId:number|null=null,retiredThrough=0,knownFinishOperationId:number|null=null;
 let exchangeTimer:ReturnType<typeof setTimeout>|null=null,phaseTimer:ReturnType<typeof setTimeout>|null=null;
 let sleepTimer:ReturnType<typeof setTimeout>|null=null,sleepReject:((error:Error)=>void)|null=null;
 let stopLatch:StopLatch|null=null,closePromise:Promise<void>|null=null,nextStatusAt=0;
 const clearExchange=()=>{if(exchangeTimer!==null)clearTimeout(exchangeTimer);exchangeTimer=null;};
 const clearPhase=()=>{if(phaseTimer!==null)clearTimeout(phaseTimer);phaseTimer=null;};
 const fail=():void=>{
  if(state==='quarantined'||state==='closed')return;
  state='quarantined';accepting=false;clearExchange();clearPhase();
  const error=new BrokerOutcomeUnknown(),p=pending;pending=null;p?.reject(error);
  if(sleepTimer!==null)clearTimeout(sleepTimer);sleepTimer=null;sleepReject?.(error);sleepReject=null;
  if(stopLatch!==null&&!stopLatch.settled){stopLatch.settled=true;stopLatch.reject(error);}
  cleanup();closePort.call(port);
 };
 function cleanup():void {port.off('message',onMessage);port.off('messageerror',fail);port.off('close',onClose);stopped();}
 function onClose():void {if(state!=='closed')fail();}
 function onMessage(value:unknown):void {
  const reply=validateSequentialMutationReply(value,epoch),p=pending;
  if(!reply||!p||reply.exchange!==p.exchange){fail();return;}
  pending=null;clearExchange();p.resolve(Object.freeze(reply.body));
  drainStop();
 }
 const rawSend=(body:Request):Promise<Reply>=>new Promise((resolve,reject)=>{
  if(state==='quarantined'||state==='closed'){reject(new BrokerOutcomeUnknown());return;}
  if(pending!==null||exchange>=limits.maxExchangeId){reject(new BrokerOutcomeUnknown());fail();return;}
  const sequence=++exchange;pending={exchange:sequence,resolve,reject};
  exchangeTimer=setTimeout(fail,body.kind==='ready'?limits.handshakeTimeoutMs:limits.exchangeTimeoutMs);
  const frame:SequentialMutationBrokerEnvelope<Request>={version:2,epoch,exchange:sequence,body};
  try{postPort.call(port,frame);}catch{fail();}
 });
 function drainStop():void {
  const latch=stopLatch;if(!latch||latch.dispatched||latch.settled||pending!==null||state==='quarantined'||state==='closed')return;
  latch.dispatched=true;
  void rawSend({kind:'stop-new-work'}).then(reply=>{
   if(reply.kind!=='stopped-new-work'){fail();return;}
   latch.settled=true;latch.resolve();
  },()=>fail());
 }
 const send=async(body:Request):Promise<Reply>=>{
  if(stopLatch!==null&&!stopLatch.settled){drainStop();await stopLatch.promise;}
  return rawSend(body);
 };
 const expect=(condition:boolean):void=>{if(!condition){fail();throw new BrokerOutcomeUnknown();}};
 // Read the live callback-mutated state instead of a lexically narrowed phase.
 const isQuarantined=():boolean=>state==='quarantined';
 const startPhase=():number=>{clearPhase();const deadline=performance.now()+limits.phaseObservationTimeoutMs;phaseTimer=setTimeout(fail,limits.phaseObservationTimeoutMs);return deadline;};
 const waitStatus=async(deadline:number):Promise<void>=>{
  expect(state!=='quarantined'&&performance.now()<deadline);
  const delay=Math.max(0,nextStatusAt-performance.now());
  if(delay>0)await new Promise<void>((resolve,reject)=>{sleepReject=reject;sleepTimer=setTimeout(()=>{sleepTimer=null;sleepReject=null;resolve();},Math.min(delay,Math.max(1,deadline-performance.now())));});
  expect(state!=='quarantined'&&performance.now()<deadline);
 };
 const observe=async(id:number,phase:'begin'|'finish',deadline:number):Promise<void>=>{
  const maximum=Math.floor(limits.phaseObservationTimeoutMs/limits.minStatusIntervalMs)+1;
  for(let posts=0;posts<maximum;posts++){
   await waitStatus(deadline);nextStatusAt=performance.now()+limits.minStatusIntervalMs;
   const reply=await send({kind:'status',operationId:id});
   if(reply.kind==='rejected')continue; // Every rejected status still consumes the finite post budget.
   expect('operationId' in reply&&reply.operationId===id);
   if(reply.kind==='pending'){expect(reply.phase===phase);continue;}
   if(phase==='begin'&&reply.kind==='begin-confirmed')return;
   if(phase==='finish'&&reply.kind==='terminal'&&reply.result==='finish-confirmed'){knownFinishOperationId=id;return;}
   fail();throw new BrokerOutcomeUnknown();
  }
  fail();throw new BrokerOutcomeUnknown();
 };
 const refuse=(error:Error,operation:SequentialMutationOperation,input:unknown):never=>{
  // Only passive original identity may produce this instance's before-post proof.
  try{
   if(input===null||typeof input!=='object'||types.isProxy(input))throw error;
   const own=(key:string):unknown=>{const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))throw error;return d.value;};
   const attemptId=own('attemptId'),method=operation==='stop'?'turn/interrupt':own('method'),wire=validateRequestId(own('wire'));
   if(typeof attemptId==='string'&&attemptId!==''&&typeof method==='string'&&method!=='')unsubmitted.set(error,{attemptId,wire,method});
  }catch{/* No remotely asserted or malformed identity acquires proof. */}
  throw error;
 };
 const begin=(operation:SequentialMutationOperation,input:unknown):Promise<PreparedHandle>=>{
  if(state==='ready'&&nextOperationId>limits.maxOperationId)return refuse(new SequenceExhaustedBeforePost(),operation,input);
  if(!accepting||state==='quarantined'||state==='closed')return refuse(new ClosedBeforePost(),operation,input);
  if(state!=='ready'||pending!==null)return refuse(new BusyBeforePost(),operation,input);
  let claim:SequentialMutationClaim;try{claim=captureSequentialMutationClaim(operation,input,limits);}catch{return refuse(new InvalidInputBeforePost(),operation,input);}
  if(nextOperationId>limits.maxOperationId||limits.maxExchangeId-exchange<sequentialMutationExchangeReservation(limits)){
   accepting=false;void client.stopNewWork().catch(()=>undefined);return refuse(new SequenceExhaustedBeforePost(),operation,input);
  }
  const id=nextOperationId++;activeId=id;state='beginning';const deadline=startPhase();
  return (async()=>{
   try{
    const reply=await send({kind:'begin',operationId:id,operation,claim});
    expect(reply.kind==='accepted'&&reply.phase==='begin'&&reply.operationId===id);
    await observe(id,'begin',deadline);
    const ack=await send({kind:'ack-begin',operationId:id});expect(ack.kind==='begin-acknowledged'&&ack.operationId===id);
    expect(!isQuarantined());clearPhase();state='prepared';const handle=Object.freeze({operationId:id});handles.set(handle,{id,used:false});return handle;
   }catch(error){fail();throw error;}
  })();
 };
 const client:SequentialMutationClient=Object.freeze({
  limits,
  beginOrdinary:(claim:unknown)=>begin('ordinary',claim),beginQueue:(claim:unknown)=>begin('queue',claim),beginStop:(claim:unknown)=>begin('stop',claim),
  finish(handle:PreparedHandle,outcome:SequentialMutationOutcome):Promise<void>{
   const data=handle!==null&&typeof handle==='object'?handles.get(handle):undefined;
   if(!data||data.used||data.id!==activeId||state!=='prepared')throw new TypeError('Expected this client\'s unused prepared handle');
   if(outcome!=='not_sent'&&outcome!=='reply_ok'&&outcome!=='reply_error')throw new TypeError('Expected original observed mutation outcome');
   data.used=true;state='finishing';const id=data.id,deadline=startPhase();
   return (async()=>{
    try{
     const reply=await send({kind:'finish',operationId:id,outcome});expect(reply.kind==='accepted'&&reply.phase==='finish'&&reply.operationId===id);
     await observe(id,'finish',deadline);
     const ack=await send({kind:'ack-terminal',operationId:id});
     expect(ack.kind==='retired'&&ack.operationId===id&&ack.retiredThrough===id);
     expect(!isQuarantined());clearPhase();retiredThrough=id;activeId=null;state='ready';
     if(ack.kind==='retired')accepting=accepting&&ack.accepting&&nextOperationId<=limits.maxOperationId;
    }catch(error){fail();throw error;}
   })();
  },
  stopNewWork():Promise<void>{
   accepting=false;
   if(stopLatch!==null)return stopLatch.promise;
   if(state==='quarantined'||state==='closed'||state==='closing')return Promise.reject(new ClosedBeforePost());
   let resolve!:()=>void,reject!:(error:Error)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
   stopLatch={promise,resolve,reject,dispatched:false,settled:false};drainStop();return promise;
  },
  quarantine(_handle:PreparedHandle|null):void{fail();},
  closeIdle():Promise<void>{
   if(closePromise!==null)return closePromise;
   if(state!=='ready'||activeId!==null)throw new TypeError('Cannot close an active sequential mutation');
   accepting=false;state='closing';
   closePromise=(async()=>{try{const reply=await send({kind:'close-idle'});expect(reply.kind==='closing'&&!isQuarantined());state='closed';clearExchange();clearPhase();cleanup();closePort.call(port);}catch(error){fail();throw error;}})();return closePromise;
  },
  ownsUnsubmittedFailure(error:unknown,attemptId:string,wire:RequestId,method:string):boolean{
   if(error===null||typeof error!=='object')return false;const proof=unsubmitted.get(error);return proof!==undefined&&proof.attemptId===attemptId&&proof.wire===wire&&proof.method===method;
  },
  snapshot:()=>Object.freeze({state,accepting,exchange,operationId:activeId,retiredThrough,knownFinishOperationId}),
 });
 clients.add(client);port.on('message',onMessage);port.on('messageerror',fail);port.on('close',onClose);
 void rawSend({kind:'ready'}).then(reply=>{if(state!=='handshaking'||reply.kind!=='ready'||reply.retiredThrough!==0){fail();rejectReady(new BrokerOutcomeUnknown());return;}state='ready';accepting=true;ready(client);},error=>{fail();rejectReady(error);});
 return {fail};
}
let receiving:Promise<SequentialMutationClient>|null=null;
/** Fixed parent bootstrap only. No caller-selected port, callback or transport. */
export function receiveSequentialMutationClient():Promise<SequentialMutationClient> {return receiveClient(false);}
/** Fixed persistent entry owns its exhaustive parent frame dispatcher. The ordinary
 * standalone client keeps its original duplicate-bootstrap listener unchanged. */
export function receivePersistentResidentMutationClient():Promise<SequentialMutationClient> {
 requirePersistentResidentRole();return receiveClient(true);
}
function receiveClient(fixedPersistentDispatcher:boolean):Promise<SequentialMutationClient> {
 if(receiving!==null)return receiving;
 if(isMainThread||parentPort===null){receiving=Promise.reject(new ClosedBeforePost());return receiving;}
 const parent=parentPort;
 receiving=new Promise((resolve,reject)=>{
  let consumed=false,control:{fail:()=>void}|null=null;
  const cleanup=():void=>{parent.off('message',onBootstrap);parent.off('messageerror',onFailure);parent.off('close',onFailure);};
  const onFailure=():void=>{if(control!==null)control.fail();else{cleanup();reject(new BrokerOutcomeUnknown());}};
  const onBootstrap=(value:unknown):void=>{
   if(consumed){closeTransferredPort(value);onFailure();return;}
   consumed=true;const bootstrap=readBootstrap(value);
   if(bootstrap===null){closeTransferredPort(value);onFailure();return;}
   if(fixedPersistentDispatcher)parent.off('message',onBootstrap);
   control=createPrivateClient(bootstrap,resolve,reject,cleanup);
  };
  parent.on('message',onBootstrap);parent.on('messageerror',onFailure);parent.on('close',onFailure);
 });
 return receiving;
}
