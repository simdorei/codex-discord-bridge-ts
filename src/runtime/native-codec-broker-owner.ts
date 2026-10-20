import {randomBytes} from 'node:crypto';
import {types} from 'node:util';
import {EventEmitter} from 'node:events';
import {isMainThread,MessageChannel,Worker,type MessagePort} from 'node:worker_threads';
import {RemoteNativeCodecOwner} from '../remote-agent/native-decode.ts';
import {
 validateBrokerLimits,calculateBrokerReservation,isGatewayInput,validateRequestEnvelope,validateGatewayResult,
 type NativeCodecBrokerLimits,type BrokerReservation,type BrokerRequestEnvelope,type RequestStatus,type EndpointStatus,
} from './native-codec-broker-protocol.ts';
import type {GatewayInboundMessage} from '../remote-agent/gateway-inbound.ts';

const transfer=Worker.prototype.postMessage;
const listen=EventEmitter.prototype.on;
const removeListener=EventEmitter.prototype.removeListener;
const construction=Object.freeze({});
let liveRoot: MainNativeCodecBroker|null=null;
type RecordState={id:number;abort:AbortController;cancellationRequested:boolean;joined:boolean;delivered:boolean;result:GatewayInboundMessage|null;error:'adapter-failed'|'invalid-result'|null};
export interface MainBrokerStatus {
 readonly state:'binding'|'handshaking'|'open'|'closing-retained'|'closed-joined';
 readonly endpointBound:boolean;readonly retainedRequestId:number|null;
 /** An unjoined adapter task, not proof that a native Worker was constructed. */
 readonly nativeRetention:boolean;
 readonly retiredThrough:number;readonly reservedPayloadBytes:number;readonly reservationCapacityBytes:number;
 readonly reservedGraphValues:number;readonly reservedGraphEdges:number;readonly queuedSubmissions:0;
}
/** Main-owned, production-unwired pure-codec custody. This canonical module's
 * singleton is not confinement against duplicated module loaders or isolates. */
export class MainNativeCodecBroker {
 readonly #limits:NativeCodecBrokerLimits;readonly #capacity:number;readonly #reservation:BrokerReservation;readonly #codec:RemoteNativeCodecOwner;
 readonly #epoch=randomBytes(16).toString('hex');
 #worker:Worker|null=null;#port:MessagePort|null=null;#bound=false;#closed=false;#transportDisposed=true;#released=false;#disposalStarted=false;#ready=false;
 #exchange=0;#nextRequest=1;#retired=0;#record:RecordState|null=null;
 #handshakeTimer:ReturnType<typeof setTimeout>|null=null;#terminalTimer:ReturnType<typeof setTimeout>|null=null;
 readonly #joined:Promise<void>;#resolveJoined!:()=>void;
 readonly #requesterGone=()=>this.close();
 private constructor(limits:NativeCodecBrokerLimits,token:object){
  if(token!==construction)throw new TypeError('UseBrokerFactory');
  this.#limits=limits;this.#reservation=calculateBrokerReservation(limits.maxInputBytes);this.#capacity=this.#reservation.requiredPayloadBytes;
  this.#codec=new RemoteNativeCodecOwner();this.#joined=new Promise(resolve=>{this.#resolveJoined=resolve;});
 }
 static create(limits:unknown):MainNativeCodecBroker{
  if(!isMainThread)throw new TypeError('MainThreadRequired');
  const validated=validateBrokerLimits(limits);
  if(liveRoot!==null)throw new Error('BrokerRootRetained');
  const root=new MainNativeCodecBroker(validated,construction);liveRoot=root;return root;
 }
 bindRequester(worker:Worker):void{
  if(this.#closed||this.#bound)throw new Error('EndpointUnavailable');
  // Reject ordinary active/invalid inputs before invoking captured methods.
  // The original Worker is supplied by trusted main construction, not proven
  // genuine against hostile same-isolate mutation or EventEmitter hooks.
  if(worker===null||typeof worker!=='object'||types.isProxy(worker)||Object.getPrototypeOf(worker)!==Worker.prototype)throw new TypeError('ExpectedExactWorker');
  for(const key of Reflect.ownKeys(worker)){const descriptor=Object.getOwnPropertyDescriptor(worker,key)!;if(!Object.hasOwn(descriptor,'value'))throw new TypeError('ExpectedPassiveWorkerInstance');}
  this.#bound=true;this.#worker=worker;
  const channel=new MessageChannel();this.#port=channel.port1;this.#transportDisposed=false;
  channel.port1.on('message',value=>this.#receive(value));
  channel.port1.once('messageerror',()=>this.close());
  channel.port1.once('close',()=>{this.#transportDisposed=true;this.close();this.#disposeIfJoined();});
  try{
   transfer.call(worker,{v:1,kind:'native-codec-broker-bootstrap',epoch:this.#epoch,limits:this.#limits,port:channel.port2},[channel.port2]);
  }catch{
   channel.port2.close();this.close();throw new Error('BootstrapTransferFailed');
  }
  listen.call(worker,'error',this.#requesterGone);listen.call(worker,'exit',this.#requesterGone);
  this.#handshakeTimer=setTimeout(()=>this.close(),this.#limits.handshakeTimeoutMs);
 }
 status():MainBrokerStatus{
  return Object.freeze({state:this.#released?'closed-joined':this.#closed?'closing-retained':!this.#bound?'binding':!this.#ready?'handshaking':'open',endpointBound:this.#bound,
   retainedRequestId:this.#record?.id??null,nativeRetention:this.#record!==null&&!this.#record.joined,
   retiredThrough:this.#retired,reservedPayloadBytes:this.#record===null?0:this.#capacity,reservationCapacityBytes:this.#capacity,reservedGraphValues:this.#record===null?0:this.#reservation.requiredGraphValues,reservedGraphEdges:this.#record===null?0:this.#reservation.requiredGraphEdges,queuedSubmissions:0});
 }
 close():void{
  if(!this.#closed){this.#closed=true;this.#clearHandshake();this.#clearTerminal();this.#cancel();this.#port?.close();}
  this.#disposeIfJoined();
 }
 join():Promise<void>{return this.#joined;}
 #clearHandshake():void{if(this.#handshakeTimer!==null){clearTimeout(this.#handshakeTimer);this.#handshakeTimer=null;}}
 #clearTerminal():void{if(this.#terminalTimer!==null){clearTimeout(this.#terminalTimer);this.#terminalTimer=null;}}
 #cancel():void{const r=this.#record;if(r!==null&&!r.cancellationRequested){r.cancellationRequested=true;if(!r.joined)r.abort.abort(new Error('BrokerCancellationRequested'));}}
 #disposeIfJoined():void{
  if(!this.#closed||!this.#transportDisposed||this.#released||this.#disposalStarted||this.#record!==null&&!this.#record.joined)return;
  this.#disposalStarted=true;
  // Adapter completion has already awaited actual native exit. Retain singleton
  // through a final original-owner join as well as observed port disposal.
  void this.#codec.join().then(()=>{
   if(this.#released)return;this.#record=null;this.#port=null;this.#released=true;
   if(this.#worker!==null){removeListener.call(this.#worker,'error',this.#requesterGone);removeListener.call(this.#worker,'exit',this.#requesterGone);this.#worker=null;}
   if(liveRoot===this)liveRoot=null;this.#resolveJoined();
  });
 }
 #reply(request:BrokerRequestEnvelope,kind:string,body:unknown):void{
  if(this.#closed||this.#transportDisposed)return;
  try{this.#port!.postMessage({v:1,epoch:this.#epoch,exchangeId:request.exchangeId,kind,requestId:request.requestId,body});}catch{this.close();}
 }
 #fatal(request?:BrokerRequestEnvelope):void{if(request!==undefined)this.#reply(request,'protocol-error',{code:'invalid-protocol'});this.close();}
 #receive(value:unknown):void{
  if(this.#closed)return;
  const request=validateRequestEnvelope(value,this.#epoch);
  if(request===null){this.#fatal();return;}
  if(this.#exchange===Number.MAX_SAFE_INTEGER||request.exchangeId!==this.#exchange+1){this.#fatal(request);return;}
  if(!this.#ready){
   if(request.kind!=='ready'||request.exchangeId!==1){this.#fatal(request);return;}
   this.#exchange=1;this.#ready=true;this.#clearHandshake();this.#reply(request,'ready-ack',null);return;
  }
  if(request.kind==='ready'){this.#fatal(request);return;}
  // Unexpected busy does not consume an ID or advance either counter.
  if(request.kind==='submit'&&(this.#record!==null||request.requestId!==this.#nextRequest)){this.#fatal(request);return;}
  if(request.kind!=='submit'&&request.kind!=='close'&&(request.requestId===null||request.requestId>this.#retired&&request.requestId!==this.#record?.id)){this.#fatal(request);return;}
  this.#exchange=request.exchangeId;
  if(request.kind==='close'){
   this.#cancel();const body:EndpointStatus={state:'closing-retained'};
   this.#reply(request,'close-status',body);this.close();return;
  }
  if(request.kind==='submit'){
   if(this.#nextRequest===Number.MAX_SAFE_INTEGER){this.#fatal(request);return;}
   const id=this.#nextRequest++;
   if(!isGatewayInput(request.body.raw,this.#limits.maxInputBytes)){this.#retired=id;this.#reply(request,'not-accepted',{reason:'invalid-input'});return;}
   const record:RecordState={id,abort:new AbortController(),cancellationRequested:false,joined:false,delivered:false,result:null,error:null};
   this.#record=record;
   // Reservation precedes invocation. Adapter errors never prove unsubmitted.
   const pending=this.#codec.decodeGatewayMessageOffThread(request.body.raw,this.#limits.maxInputBytes,record.abort.signal,this.#limits.nativeTimeoutMs);
   this.#reply(request,'accepted',{accepted:true});
   void pending.then(result=>{try{validateGatewayResult(result,this.#limits.maxResultStringUnits);record.result=result;}catch{record.error='invalid-result';}},()=>{record.error='adapter-failed';}).then(()=>{
    record.joined=true;
    if(!this.#closed)this.#terminalTimer=setTimeout(()=>this.close(),this.#limits.terminalRetentionMs);
    this.#disposeIfJoined();
   });return;
  }
  if(request.requestId!<=this.#retired){
   if(request.kind==='acknowledge-terminal'){this.#fatal(request);return;}
   this.#reply(request,'status',{state:'retired-no-replay'});return;
  }
  const record=this.#record!;
  if(request.kind==='acknowledge-terminal'){
   if(!record.joined||!record.delivered){this.#fatal(request);return;}
   this.#clearTerminal();this.#retired=record.id;this.#record=null;this.#reply(request,'terminal-ack',null);return;
  }
  if(request.kind==='cancel')this.#cancel();
  let body:RequestStatus;
  if(!record.joined)body={state:'pending',cancellationRequested:record.cancellationRequested,nativeOwnership:'retained-or-not-started'};
  else if(record.delivered)body={state:'delivered-await-ack',cancellationRequested:record.cancellationRequested};
  else{
   body=record.error===null?{state:'joined-result',cancellationRequested:record.cancellationRequested,result:record.result!}:{state:'joined-error',cancellationRequested:record.cancellationRequested,error:record.error};
   record.delivered=true;
  }
  this.#reply(request,'status',body);
 }
}
export function createMainNativeCodecBroker(limits:NativeCodecBrokerLimits):MainNativeCodecBroker{return MainNativeCodecBroker.create(limits);}
