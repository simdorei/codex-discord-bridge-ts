import {performance} from 'node:perf_hooks';
import {types} from 'node:util';
import {isMainThread, MessagePort, parentPort} from 'node:worker_threads';
import {
 isBrokerCounter, isBrokerEpoch, isGatewayInput, NATIVE_CODEC_OPERATION,
 validateAndFreezeGatewayResult, validateBrokerLimits, validateReplyEnvelope,
} from './native-codec-broker-protocol.ts';
import type {
 BrokerReplyEnvelope, BrokerRequestEnvelope, EndpointStatus, NativeCodecBrokerLimits,
 RequestStatus, Submission,
} from './native-codec-broker-protocol.ts';

/** A data-only requester. There is deliberately no constructor or raw-port API. */
export interface NativeCodecClient {
 submitGateway(raw:string):Promise<Submission>;
 status(requestId:number):Promise<RequestStatus>;
 cancel(requestId:number):Promise<RequestStatus>;
 requestClose():Promise<EndpointStatus>;
 acknowledgeTerminal(requestId:number):Promise<void>;
 detach():void;
}

type Failure='Busy'|'InvalidInput'|'InvalidRequest'|'StatusRateLimited'|
 'EndpointClosed'|'OutcomeUnknown'|'InvalidProtocol';
function failure(name:Failure):Error {
 const messages:Record<Failure,string>={
  Busy:'Native codec client is busy',
  InvalidInput:'Invalid native codec input',
  InvalidRequest:'Invalid native codec request',
  StatusRateLimited:'Native codec status rate limit',
  EndpointClosed:'Native codec endpoint is closed',
  OutcomeUnknown:'Native codec exchange outcome is unknown; do not replay',
  InvalidProtocol:'Invalid native codec protocol',
 };
 const error=new Error(messages[name]);
 error.name=name;
 return error;
}

const postPort=MessagePort.prototype.postMessage;
const closePort=MessagePort.prototype.close;
const hasPortRef=MessagePort.prototype.hasRef;

function isNativePort(value:unknown):value is MessagePort {
 if(value===null||typeof value!=='object'||types.isProxy(value))return false;
 if(Object.getPrototypeOf(value)!==MessagePort.prototype)return false;
 try{hasPortRef.call(value);return true;}catch{return false;}
}
function closeTransferredPort(value:unknown):void {
 // Only a passive own data field is inspected on a failed/duplicate bootstrap.
 if(value===null||typeof value!=='object'||types.isProxy(value))return;
 const descriptor=Object.getOwnPropertyDescriptor(value,'port');
 if(descriptor!==undefined&&Object.hasOwn(descriptor,'value')&&isNativePort(descriptor.value)){
  closePort.call(descriptor.value);
 }
}
interface Bootstrap {
 readonly epoch:string;
 readonly limits:Readonly<NativeCodecBrokerLimits>;
 readonly port:MessagePort;
}
function readBootstrap(value:unknown):Bootstrap|null {
 if(value===null||typeof value!=='object'||types.isProxy(value))return null;
 const prototype=Object.getPrototypeOf(value);
 if(prototype!==Object.prototype&&prototype!==null)return null;
 if(Object.getOwnPropertySymbols(value).length!==0)return null;
 const keys=['v','kind','epoch','limits','port'];
 const names=Object.getOwnPropertyNames(value);
 if(names.length!==keys.length)return null;
 for(const key of names){
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(!keys.includes(key)||descriptor===undefined||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))return null;
 }
 const record=value as Record<string,unknown>;
 if(record.v!==1||record.kind!=='native-codec-broker-bootstrap'||!isBrokerEpoch(record.epoch)||!isNativePort(record.port))return null;
 try{return {epoch:record.epoch,limits:validateBrokerLimits(record.limits),port:record.port};}catch{return null;}
}

type RequestKind=BrokerRequestEnvelope['kind'];
interface PendingExchange {
 readonly kind:RequestKind;
 readonly exchangeId:number;
 readonly requestId:number|null;
 readonly receive:(reply:BrokerReplyEnvelope)=>void;
 readonly reject:(reason:Error)=>void;
}
interface CancelLatch {
 readonly requestId:number;
 readonly promise:Promise<RequestStatus>;
 readonly resolve:(status:RequestStatus)=>void;
 readonly reject:(reason:Error)=>void;
 dispatched:boolean;
}
interface CloseLatch {
 readonly promise:Promise<EndpointStatus>;
 readonly resolve:(status:EndpointStatus)=>void;
 readonly reject:(reason:Error)=>void;
 dispatched:boolean;
 settled:boolean;
}

function expectedReply(kind:RequestKind,reply:BrokerReplyEnvelope):boolean {
 switch(kind){
  case 'ready':return reply.kind==='ready-ack';
  case 'submit':return reply.kind==='accepted'||reply.kind==='not-accepted';
  case 'status':case 'cancel':return reply.kind==='status';
  case 'close':return reply.kind==='close-status';
  case 'acknowledge-terminal':return reply.kind==='terminal-ack';
 }
}

function createPrivateClient(
 bootstrap:Bootstrap,
 ready:(client:NativeCodecClient)=>void,
 rejectReady:(reason:Error)=>void,
 stopped:()=>void,
):{fail:(reason:Error)=>void} {
 const {port,epoch,limits}=bootstrap;
 let phase:'handshaking'|'open'|'closed'='handshaking';
 let admissionClosed=false,uncertainOutcome=false;
 let pending:PendingExchange|null=null;
 let exchangeTimer:ReturnType<typeof setTimeout>|null=null;
 let lastExchangeId=0,lastRequestId=0,retiredThrough=0;
 let activeRequestId:number|null=null;
 let delivered=false,cancellationObserved=false;
 let nextStatusAt=0;
 let cancelLatch:CancelLatch|null=null;
 let closeLatch:CloseLatch|null=null;

 const clearExchangeTimer=():void=>{
  if(exchangeTimer!==null){clearTimeout(exchangeTimer);exchangeTimer=null;}
 };
 const fail=(reason:Error):void=>{
  if(phase==='closed')return;
  phase='closed';admissionClosed=true;
  uncertainOutcome=activeRequestId!==null&&!delivered;
  clearExchangeTimer();
  const exchange=pending;pending=null;
  const cancellation=cancelLatch;cancelLatch=null;
  port.off('message',onMessage);
  port.off('messageerror',onMessageError);
  port.off('close',onPortClose);
  stopped();
  closePort.call(port);
  // No failure certifies that a submitted operation was unstarted or joined.
  exchange?.reject(reason);
  cancellation?.reject(reason);
  if(closeLatch!==null&&!closeLatch.settled){closeLatch.settled=true;closeLatch.reject(reason);}
 };
 const onMessageError=():void=>fail(failure('OutcomeUnknown'));
 const onPortClose=():void=>fail(failure('OutcomeUnknown'));
 const requestKnown=(requestId:number):boolean=>isBrokerCounter(requestId)&&
  (requestId<=retiredThrough||requestId===activeRequestId);
 const openFailure=(observingUnknownRequest=false):Error|null=>phase!=='open'||admissionClosed?
  failure(phase==='closed'&&uncertainOutcome&&observingUnknownRequest?'OutcomeUnknown':'EndpointClosed'):null;

 const startExchange=(
  kind:RequestKind,requestId:number|null,body:BrokerRequestEnvelope['body'],
  receive:(reply:BrokerReplyEnvelope)=>void,reject:(reason:Error)=>void,
 ):void=>{
  if(phase==='closed'){reject(failure('EndpointClosed'));return;}
  if(pending!==null){reject(failure('Busy'));return;}
  if(lastExchangeId===Number.MAX_SAFE_INTEGER){
   const reason=failure('OutcomeUnknown');fail(reason);reject(reason);return;
  }
  const exchangeId=++lastExchangeId;
  pending={kind,exchangeId,requestId,receive,reject};
  exchangeTimer=setTimeout(()=>fail(failure('OutcomeUnknown')),
   kind==='ready'?limits.handshakeTimeoutMs:limits.exchangeTimeoutMs);
  // The private sender has exactly one credit. There is no outbound queue.
  const envelope={v:1,epoch,exchangeId,kind,requestId,body} as BrokerRequestEnvelope;
  try{postPort.call(port,envelope);}catch{fail(failure('OutcomeUnknown'));}
 };

 const handoffStatus=(
  requestId:number,reply:BrokerReplyEnvelope,resolve:(value:RequestStatus)=>void,
  reject:(reason:Error)=>void,
 ):void=>{
  if(reply.kind!=='status')throw failure('InvalidProtocol');
  const status=reply.body;
  if(requestId<=retiredThrough){
   if(status.state!=='retired-no-replay')throw failure('InvalidProtocol');
   resolve(Object.freeze({state:'retired-no-replay'}));return;
  }
  if(requestId!==activeRequestId||status.state==='retired-no-replay')throw failure('InvalidProtocol');
  if(cancellationObserved&&!status.cancellationRequested)throw failure('InvalidProtocol');
  cancellationObserved=status.cancellationRequested;
  switch(status.state){
   case 'pending':
    if(delivered)throw failure('InvalidProtocol');
    resolve(Object.freeze({state:'pending',cancellationRequested:status.cancellationRequested,nativeOwnership:'retained-or-not-started'}));return;
   case 'delivered-await-ack':
    if(!delivered)throw failure('InvalidProtocol');
    resolve(Object.freeze({state:'delivered-await-ack',cancellationRequested:status.cancellationRequested}));return;
   case 'joined-result':{
    if(delivered)throw failure('InvalidProtocol');
    if(admissionClosed){reject(failure('EndpointClosed'));return;}
    // This is the receiver's private clone. Validate and freeze while retained,
    // fulfill the application Promise, then retain only the delivered bit.
    const result=validateAndFreezeGatewayResult(status.result,limits.maxResultStringUnits);
    resolve(Object.freeze({state:'joined-result',cancellationRequested:status.cancellationRequested,result}));
    delivered=true;return;
   }
   case 'joined-error':
    if(delivered)throw failure('InvalidProtocol');
    if(admissionClosed){reject(failure('EndpointClosed'));return;}
    resolve(Object.freeze({state:'joined-error',cancellationRequested:status.cancellationRequested,error:status.error}));
    delivered=true;return;
  }
 };

 const drainLatches=():void=>{
  if(phase!=='open'||pending!==null)return;
  if(closeLatch!==null&&!closeLatch.dispatched&&!closeLatch.settled){
   const latch=closeLatch;latch.dispatched=true;
   startExchange('close',null,null,reply=>{
    if(reply.kind!=='close-status')throw failure('InvalidProtocol');
    latch.settled=true;
    latch.resolve(Object.freeze({state:reply.body.state}));
    // Native ownership remains with main even if its close status is retained.
    fail(failure('EndpointClosed'));
   },reason=>{if(!latch.settled){latch.settled=true;latch.reject(reason);}});
   return;
  }
  if(cancelLatch!==null&&!cancelLatch.dispatched){
   const latch=cancelLatch;latch.dispatched=true;
   startExchange('cancel',latch.requestId,null,reply=>{
    // Do not retain a settled Promise that could own a delivered result graph.
    if(cancelLatch===latch)cancelLatch=null;
    handoffStatus(latch.requestId,reply,latch.resolve,latch.reject);
   },reason=>{if(cancelLatch===latch)cancelLatch=null;latch.reject(reason);});
  }
 };

 function onMessage(value:unknown):void {
  if(phase==='closed')return;
  const reply=validateReplyEnvelope(value,epoch,limits.maxResultStringUnits);
  const exchange=pending;
  if(reply===null||exchange===null||reply.exchangeId!==exchange.exchangeId||
   reply.requestId!==exchange.requestId||!expectedReply(exchange.kind,reply)){
   fail(failure('InvalidProtocol'));return;
  }
  clearExchangeTimer();pending=null;
  try{exchange.receive(reply);}catch{
   const reason=failure('InvalidProtocol');exchange.reject(reason);fail(reason);return;
  }
  drainLatches();
 }

 const client:NativeCodecClient=Object.freeze({
  submitGateway(raw:string):Promise<Submission>{
   const unavailable=openFailure();if(unavailable!==null)return Promise.reject(unavailable);
   if(pending!==null||activeRequestId!==null)return Promise.reject(failure('Busy'));
   if(!isGatewayInput(raw,limits.maxInputBytes))return Promise.reject(failure('InvalidInput'));
   if(lastRequestId===Number.MAX_SAFE_INTEGER){
    const reason=failure('OutcomeUnknown');fail(reason);return Promise.reject(reason);
   }
   const requestId=++lastRequestId;
   activeRequestId=requestId;delivered=false;cancellationObserved=false;
   return new Promise<Submission>((resolve,reject)=>startExchange('submit',requestId,
    {operation:NATIVE_CODEC_OPERATION,raw},reply=>{
     if(reply.kind==='accepted'){resolve(Object.freeze({accepted:true,requestId}));return;}
     if(reply.kind!=='not-accepted'||requestId!==retiredThrough+1)throw failure('InvalidProtocol');
     retiredThrough=requestId;activeRequestId=null;delivered=false;
     resolve(Object.freeze({accepted:false,requestId,reason:reply.body.reason}));
    },reject));
  },
  status(requestId:number):Promise<RequestStatus>{
   const unavailable=openFailure(requestId===activeRequestId);if(unavailable!==null)return Promise.reject(unavailable);
   if(!requestKnown(requestId))return Promise.reject(failure('InvalidRequest'));
   if(pending!==null)return Promise.reject(failure('Busy'));
   const now=performance.now();
   if(now<nextStatusAt)return Promise.reject(failure('StatusRateLimited'));
   nextStatusAt=now+limits.minStatusIntervalMs;
   return new Promise<RequestStatus>((resolve,reject)=>startExchange('status',requestId,null,
    reply=>handoffStatus(requestId,reply,resolve,reject),reject));
  },
  cancel(requestId:number):Promise<RequestStatus>{
   const unavailable=openFailure(requestId===activeRequestId);if(unavailable!==null)return Promise.reject(unavailable);
   if(!requestKnown(requestId))return Promise.reject(failure('InvalidRequest'));
   if(cancelLatch!==null)return cancelLatch.requestId===requestId?cancelLatch.promise:Promise.reject(failure('Busy'));
   let resolve!:(value:RequestStatus)=>void,reject!:(reason:Error)=>void;
   const promise=new Promise<RequestStatus>((yes,no)=>{resolve=yes;reject=no;});
   cancelLatch={requestId,promise,resolve,reject,dispatched:false};
   drainLatches();return promise;
  },
  requestClose():Promise<EndpointStatus>{
   if(closeLatch!==null)return closeLatch.promise;
   if(phase!=='open')return Promise.reject(failure('EndpointClosed'));
   admissionClosed=true;
   if(cancelLatch!==null){
    const cancellation=cancelLatch;cancelLatch=null;
    cancellation.reject(failure('EndpointClosed'));
   }
   let resolve!:(value:EndpointStatus)=>void,reject!:(reason:Error)=>void;
   const promise=new Promise<EndpointStatus>((yes,no)=>{resolve=yes;reject=no;});
   closeLatch={promise,resolve,reject,dispatched:false,settled:false};
   drainLatches();return promise;
  },
  acknowledgeTerminal(requestId:number):Promise<void>{
   const unavailable=openFailure();if(unavailable!==null)return Promise.reject(unavailable);
   if(!isBrokerCounter(requestId)||requestId!==activeRequestId||!delivered)return Promise.reject(failure('InvalidRequest'));
   if(pending!==null)return Promise.reject(failure('Busy'));
   return new Promise<void>((resolve,reject)=>startExchange('acknowledge-terminal',requestId,null,reply=>{
    if(reply.kind!=='terminal-ack'||requestId!==retiredThrough+1)throw failure('InvalidProtocol');
    retiredThrough=requestId;activeRequestId=null;delivered=false;cancellationObserved=false;
    resolve();
   },reject));
  },
  detach():void{fail(failure('OutcomeUnknown'));},
 });
 port.on('message',onMessage);
 port.on('messageerror',onMessageError);
 port.on('close',onPortClose);
 startExchange('ready',null,null,reply=>{
  if(reply.kind!=='ready-ack')throw failure('InvalidProtocol');
  phase='open';ready(client);
 },rejectReady);
 return {fail};
}

let receiving:Promise<NativeCodecClient>|null=null;

/** Fixed, one-shot worker bootstrap. Repeated calls share its single Promise;
 * failure never creates another listener, channel, epoch, or replay attempt.
 * The trusted fixture uses workerData for its script and sends reports outward,
 * so all incoming parent messages belong exclusively to this bootstrap. */
export function receiveNativeCodecClient():Promise<NativeCodecClient> {
 if(receiving!==null)return receiving;
 if(isMainThread||parentPort===null){
  receiving=Promise.reject(failure('EndpointClosed'));return receiving;
 }
 const parent=parentPort;
 receiving=new Promise<NativeCodecClient>((resolve,reject)=>{
  let consumed=false;
  let control:{fail:(reason:Error)=>void}|null=null;
  const cleanup=():void=>{
   parent.off('message',onBootstrap);
   parent.off('messageerror',onParentFailure);
   parent.off('close',onParentFailure);
  };
  const stop=(reason:Error):void=>{
   if(control!==null)control.fail(reason);
   else{cleanup();reject(reason);}
  };
  const onParentFailure=():void=>stop(failure('OutcomeUnknown'));
  const onBootstrap=(value:unknown):void=>{
   if(consumed){closeTransferredPort(value);stop(failure('InvalidProtocol'));return;}
   consumed=true;
   const bootstrap=readBootstrap(value);
   if(bootstrap===null){closeTransferredPort(value);stop(failure('InvalidProtocol'));return;}
   control=createPrivateClient(bootstrap,resolve,reject,cleanup);
  };
  parent.on('message',onBootstrap);
  parent.on('messageerror',onParentFailure);
  parent.on('close',onParentFailure);
 });
 return receiving;
}
