import {randomBytes} from 'node:crypto';
import {types} from 'node:util';
import {EventEmitter} from 'node:events';
import {performance} from 'node:perf_hooks';
import {isMainThread,MessageChannel,Worker,type MessagePort} from 'node:worker_threads';
import {NativeMutationTransport,type NativeMutationOperation} from './native-mutation-transport.ts';
import {pinNativeRuntimePath} from './runtime-paths/path-text.ts';
import {requireDiscordText} from '../discord/text.ts';
import type {StopMutationClaim} from '../app-server/dispatch-attempt.ts';
import {
 validateSequentialMutationBrokerLimits,calculateSequentialMutationBrokerReservation,
 captureSequentialMutationClaim,validateSequentialMutationRequest,validateSequentialMutationReply,
 validateSequentialMutationNativeResult,validateSequentialMutationBootstrapDescriptor,
 type SequentialMutationBrokerLimits,type SequentialMutationBrokerEnvelope,
 type SequentialMutationBrokerRequestBody,type SequentialMutationBrokerReplyBody,
 type SequentialMutationOperation,type SequentialMutationClaim,
} from './sequential-mutation-broker-protocol.ts';

const postWorker=Worker.prototype.postMessage;
const listen=EventEmitter.prototype.on,remove=EventEmitter.prototype.removeListener;
const construction=Object.freeze({});
let root:MainSequentialMutationBroker|null=null;
type State='B'|'R'|'BI'|'BD'|'BA'|'P'|'FI'|'TD'|'TA'|'Q'|'C'|'J';
type Reason='none'|'protocol'|'transport'|'timeout'|'requester'|'aborted'|'native-unknown';
type Request=SequentialMutationBrokerEnvelope<SequentialMutationBrokerRequestBody>;
function identity(value:unknown,max:number):string {
 requireDiscordText(value);
 if(value.includes('\0')||Buffer.byteLength(value)>max)throw new TypeError('Invalid broker identity');
 return value;
}
/** Component-only fixed native scheduling. Neither a persistence observation nor
 * an acknowledged begin grants permission to write an app-server wire. */
export class MainSequentialMutationBroker {
 readonly #limits:SequentialMutationBrokerLimits;
 readonly #reservation:ReturnType<typeof calculateSequentialMutationBrokerReservation>;
 readonly #transport:NativeMutationTransport;
 readonly #epoch=randomBytes(16).toString('hex');
 #state:State='B';#accepting=false;#reason:Reason='none';
 #bound=false;#exchange=0;#operationId:number|null=null;#retiredThrough=0;
 #operation:SequentialMutationOperation|null=null;#claim:SequentialMutationClaim|null=null;
 #reserved=true;#pending:Promise<unknown>|null=null;#invocations=0;
 #terminal:'finish-confirmed'|'unknown'='unknown';
 #controller:AbortController|null=null;#port:MessagePort|null=null;#worker:Worker|null=null;
 #portDisposed=true;#requesterExited=true;#disposalStarted=false;#resourceJoined=false;#lastStatus=-Infinity;
 #handshake:ReturnType<typeof setTimeout>|null=null;
 #retention:ReturnType<typeof setTimeout>|null=null;
 readonly #joined:Promise<void>;#resolveJoined!:()=>void;
 readonly #requesterGone=()=>{this.#quarantine('requester');};
 readonly #requesterExit=(code:number)=>{
  this.#requesterExited=true;
  if(code!==0||(this.#state!=='C'&&this.#state!=='J'))this.#quarantine('requester');
  this.#dispose();
 };
 private constructor(path:string,runtime:string,limits:SequentialMutationBrokerLimits,token:object){
  if(token!==construction)throw new TypeError('Use broker factory');
  this.#limits=limits;this.#reservation=calculateSequentialMutationBrokerReservation(limits);
  validateSequentialMutationBootstrapDescriptor(this.#epoch,limits);
  this.#transport=new NativeMutationTransport(path,runtime,limits.nativeTimeoutMs);
  this.#joined=new Promise(resolve=>{this.#resolveJoined=resolve;});
 }
 static create(path:string,runtime:string,limits:SequentialMutationBrokerLimits):MainSequentialMutationBroker {
  if(!isMainThread)throw new TypeError('Main thread required');
  const fixedLimits=validateSequentialMutationBrokerLimits(limits);
  const fixedPath=pinNativeRuntimePath(identity(path,32768)),fixedRuntime=identity(runtime,4096);
  if(fixedRuntime==='')throw new TypeError('Expected runtime identity');
  if(root!==null)throw new Error('Sequential broker root retained');
  const value=new MainSequentialMutationBroker(fixedPath,fixedRuntime,fixedLimits,construction);root=value;return value;
 }
 bindRequester(worker:Worker):void {
  if(this.#state!=='B'||this.#bound)throw new Error('Endpoint unavailable');
  // Original trusted construction is a precondition. These checks detect ordinary
  // misuse; Worker.prototype.postMessage is not a hostile-object brand oracle.
  if(worker===null||typeof worker!=='object'||types.isProxy(worker)||Object.getPrototypeOf(worker)!==Worker.prototype)throw new TypeError('Expected original trusted Worker');
  for(const key of Reflect.ownKeys(worker)){const d=Object.getOwnPropertyDescriptor(worker,key)!;if(!Object.hasOwn(d,'value'))throw new TypeError('Expected passive Worker');}
  this.#bound=true;this.#worker=worker;this.#requesterExited=false;
  listen.call(worker,'error',this.#requesterGone);listen.call(worker,'exit',this.#requesterExit);
  let channel:MessageChannel;
  try{channel=new MessageChannel();}catch(error){this.#quarantine('transport');throw error;}
  this.#port=channel.port1;this.#portDisposed=false;
  channel.port1.on('message',value=>this.#receive(value));
  channel.port1.once('messageerror',()=>{this.#quarantine('transport');});
  channel.port1.once('close',()=>{
   this.#portDisposed=true;
   if(this.#state!=='C'&&this.#state!=='J'&&this.#state!=='Q')this.#quarantine('transport');
   this.#dispose();
  });
  try{postWorker.call(worker,{version:2,kind:'sequential-mutation-broker-bootstrap',epoch:this.#epoch,limits:this.#limits,port:channel.port2},[channel.port2]);}
  catch(error){channel.port2.close();this.#quarantine('transport');throw error;}
  this.#handshake=setTimeout(()=>{this.#quarantine('timeout');},this.#limits.handshakeTimeoutMs);
 }
 snapshot(){
  const retained=this.#state!=='J';
  return Object.freeze({state:this.#state,accepting:this.#accepting,epoch:this.#epoch,reason:this.#reason,
   endpointBound:this.#bound,operationId:this.#operationId,retiredThrough:this.#retiredThrough,exchange:this.#exchange,
   nativeRetention:this.#pending!==null,requesterRetention:!this.#requesterExited,portRetention:!this.#portDisposed,
   resourceJoined:this.#resourceJoined,nativeInvocations:this.#invocations,
   lifecycleLogicalBytes:this.#reserved?this.#reservation.lifecycleLogicalBytes:0,
   lifecycleNodes:this.#reserved?this.#reservation.lifecycleNodes:0,lifecycleEdges:this.#reserved?this.#reservation.lifecycleEdges:0,
   rootLogicalBytes:retained?this.#reservation.rootLogicalBytes:0,rootNodes:retained?this.#reservation.rootNodes:0,rootEdges:retained?this.#reservation.rootEdges:0,
   retainedClaims:this.#claim===null?0:1,queuedSubmissions:0});
 }
 /** Stops fresh admission without aborting already-owned completion. */
 stopNewWork():void {if(this.#state==='B'){this.#quarantine('protocol');return;}this.#accepting=false;}
 /** Normal close is available only with no active original work. */
 closeIdle():Promise<void>{
  if(this.#state==='J'||this.#state==='C')return this.#joined;
  if(this.#state!=='R'||this.#claim!==null){this.#quarantine('protocol');return this.#joined;}
  this.#gracefulClose();return this.#joined;
 }
 /** Irreversible. Resource join never clears this module's quarantine tombstone. */
 quarantine():void {this.#quarantine('aborted');}
 #quarantine(reason:Reason):void {
  if(this.#state==='Q'||this.#state==='J')return;
  this.#accepting=false;this.#state='Q';this.#reason=reason;this.#clearTimers();
  this.#controller?.abort(new Error('Sequential broker quarantined'));
  this.#port?.close();this.#dispose();
 }
 join():Promise<void>{return this.#joined;}
 #gracefulClose():void{
  this.#accepting=false;this.#state='C';this.#clearTimers();this.#port?.close();this.#dispose();
 }
 #clearTimers():void{
  if(this.#handshake!==null){clearTimeout(this.#handshake);this.#handshake=null;}
  if(this.#retention!==null){clearTimeout(this.#retention);this.#retention=null;}
 }
 #dispose():void{
  if((this.#state!=='Q'&&this.#state!=='C')||!this.#portDisposed||!this.#requesterExited||this.#pending!==null||this.#disposalStarted)return;
  this.#disposalStarted=true;
  void this.#transport.close().then(()=>{
   this.#claim=null;this.#operation=null;this.#reserved=false;this.#controller=null;this.#port=null;
   if(this.#worker!==null){remove.call(this.#worker,'error',this.#requesterGone);remove.call(this.#worker,'exit',this.#requesterExit);this.#worker=null;}
   this.#resourceJoined=true;
   if(this.#state==='C'){this.#state='J';if(root===this)root=null;}
   // Q keeps a fixed root-sized record and the module singleton permanently.
   this.#resolveJoined();
  },()=>{this.#state='Q';this.#reason='transport';});
 }
 #reply(request:Request,body:SequentialMutationBrokerReplyBody):boolean{
  if(this.#state==='Q'||this.#state==='C'||this.#state==='J')return false;
  const reply={version:2 as const,epoch:this.#epoch,exchange:request.exchange,body};
  if(validateSequentialMutationReply(reply,this.#epoch)===null){this.#quarantine('protocol');return false;}
  try{this.#port!.postMessage(reply);return true;}catch{this.#quarantine('transport');return false;}
 }
 #invoke(phase:'begin'|'finish',operation:NativeMutationOperation,input:unknown):void{
  if(this.#pending!==null){this.#quarantine('protocol');return;}
  this.#controller=new AbortController();this.#invocations++;
  let pending:Promise<unknown>;
  // An invocation, including a synchronous transport throw, is conservatively
  // unknown on failure. No error label certifies that submission did not happen.
  try{pending=this.#transport.submit(operation,input,this.#controller.signal);}
  catch{pending=Promise.reject(new Error('Unconfirmed persistence'));}
  this.#pending=pending;
  void pending.then(raw=>{
   let confirmed=false;try{confirmed=validateSequentialMutationNativeResult(raw,this.#limits);}catch{/* fixed unknown */}
   this.#nativeJoined(pending,phase,confirmed);
  },()=>this.#nativeJoined(pending,phase,false));
 }
 #nativeJoined(submission:Promise<unknown>,phase:'begin'|'finish',confirmed:boolean):void{
  if(this.#pending!==submission){this.#quarantine('protocol');return;}
  this.#pending=null;this.#controller=null;
  if(this.#state==='Q'||this.#state==='C'){this.#dispose();return;}
  if(this.#state!==(phase==='begin'?'BI':'FI')){this.#quarantine('protocol');return;}
  if(phase==='begin'&&confirmed){
   this.#state='BD';this.#retention=setTimeout(()=>{this.#quarantine('timeout');},this.#limits.preparedAwaitFinishTimeoutMs);
  }else{
   this.#terminal=confirmed?'finish-confirmed':'unknown';this.#state='TD';
   this.#retention=setTimeout(()=>{this.#quarantine('timeout');},this.#limits.terminalRetentionMs);
  }
 }
 #receive(value:unknown):void{
  if(this.#state==='Q'||this.#state==='C'||this.#state==='J')return;
  const request=validateSequentialMutationRequest(value,this.#epoch,this.#limits);
  if(request===null||this.#exchange>=this.#limits.maxExchangeId||request.exchange!==this.#exchange+1){this.#quarantine('protocol');return;}
  this.#exchange=request.exchange;const body=request.body;
  if(this.#state==='B'){
   if(body.kind!=='ready'||request.exchange!==1){this.#quarantine('protocol');return;}
   this.#clearTimers();this.#state='R';this.#accepting=true;this.#reply(request,{kind:'ready',retiredThrough:0});return;
  }
  if(body.kind==='abort'){this.#reply(request,{kind:'closing'});this.#quarantine('aborted');return;}
  if(body.kind==='stop-new-work'){this.#accepting=false;this.#reply(request,{kind:'stopped-new-work'});return;}
  if(body.kind==='close-idle'){
   if(this.#state!=='R'||this.#claim!==null){this.#quarantine('protocol');return;}
   if(this.#reply(request,{kind:'closing'}))this.#gracefulClose();return;
  }
  if(body.kind==='ready'){this.#quarantine('protocol');return;}
  if(body.kind==='begin'){
   if(this.#state!=='R'||!this.#accepting||body.operationId!==this.#retiredThrough+1||body.operationId>this.#limits.maxOperationId){this.#quarantine('protocol');return;}
   try{this.#claim=captureSequentialMutationClaim(body.operation,body.claim,this.#limits);}catch{this.#quarantine('protocol');return;}
   this.#operationId=body.operationId;this.#operation=body.operation;this.#lastStatus=-Infinity;this.#state='BI';
   const native=body.operation==='ordinary'?'beginMutationWithOrigin':body.operation==='queue'?'beginQueueMutation':'beginStopMutation';
   this.#invoke('begin',native,this.#claim);
   this.#reply(request,{kind:'accepted',operationId:body.operationId,phase:'begin'});return;
  }
  if(!('operationId' in body)||body.operationId!==this.#operationId){this.#quarantine('protocol');return;}
  const operationId=this.#operationId!;
  if(body.kind==='ack-begin'){
   if(this.#state!=='BA'){this.#quarantine('protocol');return;}
   this.#state='P';this.#reply(request,{kind:'begin-acknowledged',operationId});return;
  }
  if(body.kind==='finish'){
   if(this.#state!=='P'||this.#claim===null){this.#quarantine('protocol');return;}
   this.#clearTimers();this.#state='FI';this.#lastStatus=-Infinity;
   const c=this.#claim,stop=this.#operation==='stop';
   const completion={ownerId:c.ownerId,generation:c.generation,attemptId:c.attemptId,wire:c.wire,outcome:body.outcome,...(stop?{claim:(c as StopMutationClaim).claim}:{})};
   this.#invoke('finish',stop?'finishStopMutation':'finishMutation',completion);
   this.#reply(request,{kind:'accepted',operationId,phase:'finish'});return;
  }
  if(body.kind==='ack-terminal'){
   if(this.#state!=='TA'||this.#terminal!=='finish-confirmed'){this.#quarantine('protocol');return;}
   this.#clearTimers();this.#retiredThrough=operationId;this.#claim=null;this.#operation=null;this.#operationId=null;
   if(operationId>=this.#limits.maxOperationId)this.#accepting=false;
   this.#state='R';this.#reply(request,{kind:'retired',operationId,retiredThrough:this.#retiredThrough,accepting:this.#accepting});return;
  }
  if(body.kind==='status'){
   if(this.#state!=='BI'&&this.#state!=='FI'&&this.#state!=='BD'&&this.#state!=='TD'){this.#quarantine('protocol');return;}
   const now=performance.now();if(now-this.#lastStatus<this.#limits.minStatusIntervalMs){this.#reply(request,{kind:'rejected',reason:'rate-limited'});return;}this.#lastStatus=now;
   if(this.#state==='BI'||this.#state==='FI'){this.#reply(request,{kind:'pending',operationId,phase:this.#state==='BI'?'begin':'finish'});return;}
   if(this.#state==='BD'){this.#state='BA';this.#reply(request,{kind:'begin-confirmed',operationId});return;}
   this.#state='TA';const result=this.#terminal;this.#reply(request,{kind:'terminal',operationId,result});
   if(result==='unknown')this.#quarantine('native-unknown');return;
  }
  this.#quarantine('protocol');
 }
}
Object.freeze(MainSequentialMutationBroker.prototype);
export function createMainSequentialMutationBroker(path:string,runtime:string,limits:SequentialMutationBrokerLimits):MainSequentialMutationBroker{return MainSequentialMutationBroker.create(path,runtime,limits);}
