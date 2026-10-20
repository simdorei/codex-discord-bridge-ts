import {performance} from 'node:perf_hooks';
import {types} from 'node:util';
import {isMainThread, MessagePort, parentPort} from 'node:worker_threads';
import {
 captureMutationClaim, validateMutationBootstrapDescriptor, validateMutationBrokerLimits,
 validateMutationReply,
} from './native-mutation-broker-protocol.ts';
import type {
 MutationBrokerEnvelope, MutationBrokerLimits, MutationBrokerReplyBody, MutationBrokerRequestBody,
} from './native-mutation-broker-protocol.ts';

/** Private, fixed requester. Persistence observations are never dispatch authority. */
export interface NativeMutationClient {
 begin(claim:unknown):Promise<MutationBrokerReplyBody>;
 status():Promise<MutationBrokerReplyBody>;
 acknowledgeBegin():Promise<MutationBrokerReplyBody>;
 finish(beginSequence:number,outcome:'not_sent'|'reply_ok'|'reply_error'):Promise<MutationBrokerReplyBody>;
 cancel():Promise<MutationBrokerReplyBody>;
 requestClose():Promise<MutationBrokerReplyBody>;
 acknowledgeTerminal():Promise<MutationBrokerReplyBody>;
 detach():void;
}
type Failure='Busy'|'InvalidInput'|'EndpointClosed'|'OutcomeUnknown'|'InvalidProtocol';
function failure(name:Failure):Error {
 const messages:Record<Failure,string>={Busy:'Native mutation client is busy',
  InvalidInput:'Invalid native mutation input',EndpointClosed:'Native mutation endpoint is closed',
  OutcomeUnknown:'Native mutation exchange outcome is unknown; do not replay',
  InvalidProtocol:'Invalid native mutation protocol'};
 const error=new Error(messages[name]);error.name=name;return error;
}
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
interface Bootstrap {readonly epoch:string;readonly limits:MutationBrokerLimits;readonly port:MessagePort}
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
 if(record.version!==1||record.kind!=='native-mutation-broker-bootstrap'||
  typeof record.epoch!=='string'||!/^[0-9a-f]{32}$/.test(record.epoch)||!isNativePort(record.port))return null;
 try{
  const limits=validateMutationBrokerLimits(record.limits);
  validateMutationBootstrapDescriptor(record.epoch,limits);
  return {epoch:record.epoch,limits,port:record.port};
 }catch{return null;}
}
type Reply=MutationBrokerReplyBody;
type Request=MutationBrokerRequestBody;
type State='handshaking'|'ready'|'begin-pending'|'begin-ack'|'prepared'|'finish-pending'|'terminal-ack'|'closed';
interface Pending {
 readonly kind:Request['kind'];readonly exchange:number;
 readonly resolve:(reply:Reply)=>void;readonly reject:(reason:Error)=>void;
}
interface Latch {
 readonly promise:Promise<Reply>;readonly resolve:(reply:Reply)=>void;
 readonly reject:(reason:Error)=>void;dispatched:boolean;settled:boolean;
}
function newLatch():Latch {
 let resolve!:(reply:Reply)=>void,reject!:(reason:Error)=>void;
 const promise=new Promise<Reply>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject,dispatched:false,settled:false};
}
function rejected(reason:'wrong-state'|'rate-limited'):Promise<Reply> {
 return Promise.resolve(Object.freeze({kind:'rejected',reason}));
}
function createPrivateClient(bootstrap:Bootstrap,ready:(client:NativeMutationClient)=>void,
 rejectReady:(reason:Error)=>void,stopped:()=>void):{fail:(reason:Error)=>void} {
 const {port,epoch,limits}=bootstrap;
 let state:State='handshaking',pending:Pending|null=null;
 let timer:ReturnType<typeof setTimeout>|null=null;
 let exchange=0,beginSequence:number|null=null,nextStatusAt=0;
 let beginUsed=false,finishUsed=false,admissionClosed=false;
 let cancelLatch:Latch|null=null,closeLatch:Latch|null=null;
 const clearTimer=():void=>{if(timer!==null){clearTimeout(timer);timer=null;}};
 const fail=(reason:Error):void=>{
  if(state==='closed')return;
  state='closed';admissionClosed=true;clearTimer();
  const active=pending;pending=null;
  port.off('message',onMessage);port.off('messageerror',onMessageError);port.off('close',onPortClose);
  stopped();closePort.call(port);
  active?.reject(reason);
  for(const latch of [cancelLatch,closeLatch])if(latch!==null&&!latch.settled){latch.settled=true;latch.reject(reason);}
 };
 const onMessageError=():void=>fail(failure('OutcomeUnknown'));
 const onPortClose=():void=>fail(failure('OutcomeUnknown'));
 const unavailable=():Error|null=>state==='closed'||admissionClosed?failure('EndpointClosed'):
  pending!==null?failure('Busy'):null;
 const start=(body:Request,resolve:(reply:Reply)=>void,reject:(reason:Error)=>void):void=>{
  if(state==='closed'){reject(failure('EndpointClosed'));return;}
  if(pending!==null){reject(failure('Busy'));return;}
  if(exchange===Number.MAX_SAFE_INTEGER){const e=failure('OutcomeUnknown');fail(e);reject(e);return;}
  const sequence=++exchange;
  pending={kind:body.kind,exchange:sequence,resolve,reject};
  timer=setTimeout(()=>fail(failure('OutcomeUnknown')),body.kind==='ready'?limits.handshakeTimeoutMs:limits.exchangeTimeoutMs);
  const envelope:MutationBrokerEnvelope<Request>={version:1,epoch,exchange:sequence,body};
  try{postPort.call(port,envelope);}catch{fail(failure('OutcomeUnknown'));}
 };
 const send=(body:Request):Promise<Reply>=>new Promise((resolve,reject)=>start(body,resolve,reject));
 const drain=():void=>{
  if(state==='closed'||pending!==null)return;
  const latch=closeLatch??cancelLatch;
  if(latch===null||latch.dispatched||latch.settled)return;
  latch.dispatched=true;
  start({kind:latch===closeLatch?'close':'cancel'},reply=>{
   latch.settled=true;latch.resolve(reply);
   if(latch===closeLatch||reply.kind==='closing')fail(failure('EndpointClosed'));
  },reason=>{if(!latch.settled){latch.settled=true;latch.reject(reason);}});
 };
 const observe=(kind:Request['kind'],reply:Reply,sequence:number):void=>{
  if(reply.kind==='rejected')return;
  if(reply.kind==='closing'){
   if(kind!=='close'&&kind!=='cancel')throw failure('InvalidProtocol');
   admissionClosed=true;return;
  }
  if(kind==='ready'){
   if(reply.kind!=='ready'||state!=='handshaking')throw failure('InvalidProtocol');
   state='ready';return;
  }
  if(kind==='begin'||kind==='finish'){
   if(reply.kind!=='accepted'||reply.phase!==kind||reply.beginSequence!==beginSequence||
    (kind==='begin'&&sequence!==beginSequence))throw failure('InvalidProtocol');
   return;
  }
  if(kind==='ack-begin'){
   if(reply.kind!=='acknowledged'||reply.phase!=='begin'||state!=='begin-ack')throw failure('InvalidProtocol');
   state='prepared';return;
  }
  if(kind==='ack-terminal'){
   if(reply.kind!=='acknowledged'||reply.phase!=='terminal'||state!=='terminal-ack')throw failure('InvalidProtocol');
   return;
  }
  if(kind!=='status'&&kind!=='cancel'&&kind!=='close')throw failure('InvalidProtocol');
  if(reply.kind==='pending'){
   if(reply.beginSequence!==beginSequence||reply.phase!==(finishUsed?'finish':'begin')||
    (state!=='begin-pending'&&state!=='finish-pending'))throw failure('InvalidProtocol');
   return;
  }
  // Results may only be delivered once, and only through status.
  if(kind!=='status')throw failure('InvalidProtocol');
  if(reply.kind==='begin-confirmed'){
   if(state!=='begin-pending'||reply.beginSequence!==beginSequence)throw failure('InvalidProtocol');
   state='begin-ack';return;
  }
  if(reply.kind==='terminal'){
   if(state==='terminal-ack'||reply.beginSequence!==beginSequence||
    (reply.result==='finish-confirmed'&&state!=='finish-pending'))throw failure('InvalidProtocol');
   state='terminal-ack';return;
  }
  throw failure('InvalidProtocol');
 };
 function onMessage(value:unknown):void {
  if(state==='closed')return;
  const reply=validateMutationReply(value,epoch),active=pending;
  if(reply===null||active===null||reply.exchange!==active.exchange){fail(failure('InvalidProtocol'));return;}
  clearTimer();pending=null;
  try{
   observe(active.kind,reply.body,active.exchange);
   active.resolve(Object.freeze(reply.body));
   if((active.kind==='ack-terminal'&&reply.body.kind==='acknowledged')||
    (reply.body.kind==='pending'&&reply.body.closing)||
    (reply.body.kind==='rejected'&&reply.body.reason==='closed'))fail(failure('EndpointClosed'));
  }catch{const e=failure('InvalidProtocol');active.reject(e);fail(e);return;}
  drain();
 }
 const client:NativeMutationClient=Object.freeze({
  begin(claim:unknown):Promise<Reply>{
   const error=unavailable();if(error!==null)return Promise.reject(error);
   if(state!=='ready'||beginUsed)return rejected('wrong-state');
   let captured:ReturnType<typeof captureMutationClaim>;
   try{captured=captureMutationClaim(claim,limits);}catch{return Promise.reject(failure('InvalidInput'));}
   beginUsed=true;beginSequence=exchange+1;state='begin-pending';
   // Capture is the one private claim slot; postMessage synchronously snapshots it.
   return send({kind:'begin',claim:captured});
  },
  status():Promise<Reply>{
   const error=unavailable();if(error!==null)return Promise.reject(error);
   if(state==='begin-ack'||state==='terminal-ack')return rejected('wrong-state');
   const now=performance.now();if(now<nextStatusAt)return rejected('rate-limited');
   nextStatusAt=now+limits.minStatusIntervalMs;return send({kind:'status'});
  },
  acknowledgeBegin():Promise<Reply>{
   const error=unavailable();if(error!==null)return Promise.reject(error);
   return state==='begin-ack'?send({kind:'ack-begin'}):rejected('wrong-state');
  },
  finish(sequence:number,outcome:'not_sent'|'reply_ok'|'reply_error'):Promise<Reply>{
   const error=unavailable();if(error!==null)return Promise.reject(error);
   if(state!=='prepared'||finishUsed||sequence!==beginSequence||
    (outcome!=='not_sent'&&outcome!=='reply_ok'&&outcome!=='reply_error'))return rejected('wrong-state');
   finishUsed=true;state='finish-pending';return send({kind:'finish',beginSequence:sequence,outcome});
  },
  cancel():Promise<Reply>{
   if(cancelLatch!==null)return cancelLatch.promise;
   if(state==='closed'||admissionClosed)return Promise.reject(failure('EndpointClosed'));
   cancelLatch=newLatch();drain();return cancelLatch.promise;
  },
  requestClose():Promise<Reply>{
   if(closeLatch!==null)return closeLatch.promise;
   if(state==='closed')return Promise.reject(failure('EndpointClosed'));
   admissionClosed=true;
   if(cancelLatch!==null&&!cancelLatch.dispatched&&!cancelLatch.settled){
    cancelLatch.settled=true;cancelLatch.reject(failure('EndpointClosed'));
   }
   closeLatch=newLatch();drain();return closeLatch.promise;
  },
  acknowledgeTerminal():Promise<Reply>{
   const error=unavailable();if(error!==null)return Promise.reject(error);
   return state==='terminal-ack'?send({kind:'ack-terminal'}):rejected('wrong-state');
  },
  detach():void{fail(failure('OutcomeUnknown'));},
 });
 port.on('message',onMessage);port.on('messageerror',onMessageError);port.on('close',onPortClose);
 start({kind:'ready'},reply=>{
  if(reply.kind!=='ready'){rejectReady(failure('InvalidProtocol'));fail(failure('InvalidProtocol'));return;}
  ready(client);
 },rejectReady);
 return {fail};
}

let receiving:Promise<NativeMutationClient>|null=null;
/** One-shot trusted worker bootstrap. Failure never reconnects or replays. */
export function receiveNativeMutationClient():Promise<NativeMutationClient> {
 if(receiving!==null)return receiving;
 if(isMainThread||parentPort===null){receiving=Promise.reject(failure('EndpointClosed'));return receiving;}
 const parent=parentPort;
 receiving=new Promise((resolve,reject)=>{
  let consumed=false,control:{fail:(reason:Error)=>void}|null=null;
  const cleanup=():void=>{
   parent.off('message',onBootstrap);parent.off('messageerror',onParentFailure);parent.off('close',onParentFailure);
  };
  const stop=(reason:Error):void=>{if(control!==null)control.fail(reason);else{cleanup();reject(reason);}};
  const onParentFailure=():void=>stop(failure('OutcomeUnknown'));
  const onBootstrap=(value:unknown):void=>{
   if(consumed){closeTransferredPort(value);stop(failure('InvalidProtocol'));return;}
   consumed=true;const bootstrap=readBootstrap(value);
   if(bootstrap===null){closeTransferredPort(value);stop(failure('InvalidProtocol'));return;}
   control=createPrivateClient(bootstrap,resolve,reject,cleanup);
  };
  parent.on('message',onBootstrap);parent.on('messageerror',onParentFailure);parent.on('close',onParentFailure);
 });
 return receiving;
}
