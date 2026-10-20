import {randomBytes} from 'node:crypto';
import {types} from 'node:util';
import {EventEmitter} from 'node:events';
import {performance} from 'node:perf_hooks';
import {isMainThread,MessageChannel,Worker,type MessagePort} from 'node:worker_threads';
import {NativeMutationTransport} from './native-mutation-transport.ts';
import {pinNativeRuntimePath} from './runtime-paths/path-text.ts';
import {requireDiscordText} from '../discord/text.ts';
import type {MaintenanceClaim} from '../app-server/maintenance-attempt.ts';
import {
 validateMutationBrokerLimits,calculateMutationBrokerReservation,captureMutationClaim,
 validateMutationRequest,validateMutationReply,validateMutationNativeResult,validateMutationBootstrapDescriptor,
 type MutationBrokerLimits,type MutationBrokerRequestBody,type MutationBrokerReplyBody,type MutationBrokerEnvelope,
} from './native-mutation-broker-protocol.ts';

const postWorker=Worker.prototype.postMessage;
const listen=EventEmitter.prototype.on,remove=EventEmitter.prototype.removeListener;
const construction=Object.freeze({});
let root:MainNativeMutationBroker|null=null;
type State='waiting-ready'|'ready'|'begin-inflight'|'begin-result-await-delivery'|'begin-result-await-ack'|'prepared-await-finish'|'finish-inflight'|'terminal-await-delivery'|'terminal-await-ack'|'closing'|'disposed';
type Request=MutationBrokerEnvelope<MutationBrokerRequestBody>;
function text(value:unknown,max:number):string {
 requireDiscordText(value);
 if(value.includes('\0')||Buffer.byteLength(value)>max)throw new TypeError('Invalid broker identity');
 return value;
}
/** Production-unwired persistence observation only. No receipt or dispatch API.
 * The module singleton is a trusted-construction rule, not hostile-isolate confinement. */
export class MainNativeMutationBroker {
 readonly #limits:MutationBrokerLimits;
 readonly #reservation:ReturnType<typeof calculateMutationBrokerReservation>;
 readonly #transport:NativeMutationTransport;
 readonly #epoch=randomBytes(16).toString('hex');
 #state:State='waiting-ready';#bound=false;#exchange=0;#beginSequence:number|null=null;
 #claim:MaintenanceClaim|null=null;#reserved=true;#inflight=false;#finishUsed=false;
 #terminal:'finish-confirmed'|'unknown'|'not-submitted'='unknown';
 #controller:AbortController|null=null;#port:MessagePort|null=null;#worker:Worker|null=null;
 #portDisposed=true;#requesterExited=true;#closed=false;#disposalStarted=false;#lastStatus=-Infinity;
 #handshake:ReturnType<typeof setTimeout>|null=null;
 #retention:ReturnType<typeof setTimeout>|null=null;
 #invocations=0;
 readonly #joined:Promise<void>;#resolveJoined!:()=>void;
 readonly #requesterGone=()=>{void this.close();};
 readonly #requesterExit=()=>{this.#requesterExited=true;void this.close();this.#dispose();};
 private constructor(path:string,runtime:string,limits:MutationBrokerLimits,token:object){
  if(token!==construction)throw new TypeError('Use broker factory');
  this.#limits=limits;this.#reservation=calculateMutationBrokerReservation(limits);
  validateMutationBootstrapDescriptor(this.#epoch,limits);
  this.#transport=new NativeMutationTransport(path,runtime,limits.nativeTimeoutMs);
  this.#joined=new Promise(resolve=>{this.#resolveJoined=resolve;});
 }
 static create(path:string,runtime:string,limits:MutationBrokerLimits):MainNativeMutationBroker {
  if(!isMainThread)throw new TypeError('Main thread required');
  const fixedLimits=validateMutationBrokerLimits(limits);
  const fixedPath=pinNativeRuntimePath(text(path,32768)),fixedRuntime=text(runtime,4096);
  if(fixedRuntime==='')throw new TypeError('Expected runtime identity');
  if(root!==null)throw new Error('Broker root retained');
  const value=new MainNativeMutationBroker(fixedPath,fixedRuntime,fixedLimits,construction);root=value;return value;
 }
 bindRequester(worker:Worker):void {
  if(this.#closed||this.#bound)throw new Error('Endpoint unavailable');
  if(worker===null||typeof worker!=='object'||types.isProxy(worker)||Object.getPrototypeOf(worker)!==Worker.prototype)throw new TypeError('Expected original trusted Worker');
  for(const key of Reflect.ownKeys(worker)){const d=Object.getOwnPropertyDescriptor(worker,key)!;if(!Object.hasOwn(d,'value'))throw new TypeError('Expected passive Worker');}
  this.#bound=true;this.#worker=worker;this.#requesterExited=false;
  const channel=new MessageChannel();this.#port=channel.port1;this.#portDisposed=false;
  channel.port1.on('message',value=>this.#receive(value));
  channel.port1.once('messageerror',()=>{void this.close();});
  channel.port1.once('close',()=>{this.#portDisposed=true;void this.close();this.#dispose();});
  listen.call(worker,'error',this.#requesterGone);listen.call(worker,'exit',this.#requesterExit);
  try{postWorker.call(worker,{version:1,kind:'native-mutation-broker-bootstrap',epoch:this.#epoch,limits:this.#limits,port:channel.port2},[channel.port2]);}
  catch{channel.port2.close();void this.close();throw new Error('Bootstrap transfer failed');}
  this.#handshake=setTimeout(()=>{void this.close();},this.#limits.handshakeTimeoutMs);
 }
 snapshot(){
  const alive=this.#state!=='disposed';
  return Object.freeze({state:this.#state,endpointBound:this.#bound,beginSequence:this.#beginSequence,
   nativeRetention:this.#inflight,requesterRetention:!this.#requesterExited,nativeInvocations:this.#invocations,finishConsumed:this.#finishUsed,
   lifecycleLogicalBytes:this.#reserved?this.#reservation.lifecycleLogicalBytes:0,
   lifecycleNodes:this.#reserved?this.#reservation.lifecycleNodes:0,lifecycleEdges:this.#reserved?this.#reservation.lifecycleEdges:0,
   rootLogicalBytes:alive?this.#reservation.rootLogicalBytes:0,rootNodes:alive?this.#reservation.rootNodes:0,rootEdges:alive?this.#reservation.rootEdges:0,
   queuedSubmissions:0});
 }
 close():Promise<void>{
  if(!this.#closed){
   this.#closed=true;this.#state='closing';this.#clearTimers();
   this.#controller?.abort(new Error('Broker endpoint closed'));
   this.#port?.close();
  }
  this.#dispose();return this.#joined;
 }
 join():Promise<void>{return this.#joined;}
 #clearTimers():void{
  if(this.#handshake!==null){clearTimeout(this.#handshake);this.#handshake=null;}
  if(this.#retention!==null){clearTimeout(this.#retention);this.#retention=null;}
 }
 #dispose():void{
  if(!this.#closed||!this.#portDisposed||!this.#requesterExited||this.#inflight||this.#disposalStarted)return;
  this.#disposalStarted=true;
  void this.#transport.close().then(()=>{
   this.#claim=null;this.#reserved=false;this.#controller=null;this.#port=null;
   if(this.#worker!==null){remove.call(this.#worker,'error',this.#requesterGone);remove.call(this.#worker,'exit',this.#requesterExit);this.#worker=null;}
   this.#state='disposed';if(root===this)root=null;this.#resolveJoined();
  });
 }
 #reply(request:Request,body:MutationBrokerReplyBody):void{
  if(this.#closed)return;
  const reply={version:1 as const,epoch:this.#epoch,exchange:request.exchange,body};
  if(validateMutationReply(reply,this.#epoch)===null){void this.close();return;}
  try{this.#port!.postMessage(reply);}catch{void this.close();}
 }
 #reject(request:Request,reason:'wrong-state'|'capacity'|'closed'|'rate-limited'|'malformed'):void{this.#reply(request,{kind:'rejected',reason});}
 #invoke(phase:'begin'|'finish',input:unknown):void{
  this.#inflight=true;this.#controller=new AbortController();this.#invocations++;
  let pending:Promise<unknown>;
  // Crossing submit is sufficient for unknown on any failure; wasAdmitted and
  // error labels intentionally do not participate in provenance classification.
  try{pending=this.#transport.submit(phase==='begin'?'beginMutationWithOrigin':'finishMutation',input,this.#controller.signal);}
  catch{pending=Promise.reject(new Error('Unconfirmed persistence'));}
  void pending.then(raw=>{
   let confirmed=false;try{confirmed=validateMutationNativeResult(raw,this.#limits);}catch{/* fixed unknown */}
   this.#nativeJoined(phase,confirmed);
  },()=>this.#nativeJoined(phase,false));
 }
 #nativeJoined(phase:'begin'|'finish',confirmed:boolean):void{
  this.#inflight=false;this.#controller=null;
  if(this.#closed){this.#terminal='unknown';this.#dispose();return;}
  if(phase==='begin'&&confirmed){
   this.#state='begin-result-await-delivery';
   this.#retention=setTimeout(()=>{void this.close();},this.#limits.preparedAwaitFinishTimeoutMs);
  }else{
   this.#terminal=confirmed?'finish-confirmed':'unknown';this.#state='terminal-await-delivery';
   this.#retention=setTimeout(()=>{void this.close();},this.#limits.terminalRetentionMs);
  }
 }
 #receive(value:unknown):void{
  if(this.#closed)return;
  const request=validateMutationRequest(value,this.#epoch,this.#limits);
  if(request===null||this.#exchange===Number.MAX_SAFE_INTEGER||request.exchange!==this.#exchange+1){void this.close();return;}
  this.#exchange=request.exchange;const body=request.body;
  if(this.#state==='waiting-ready'){
   if(body.kind!=='ready'||request.exchange!==1){void this.close();return;}
   this.#clearTimers();this.#state='ready';this.#reply(request,{kind:'ready'});return;
  }
  if(body.kind==='ready'){this.#reject(request,'wrong-state');return;}
  if(body.kind==='close'||body.kind==='cancel'){
   this.#reply(request,{kind:'closing'});void this.close();return;
  }
  if(body.kind==='begin'){
   if(this.#state!=='ready'){this.#reject(request,'wrong-state');return;}
   // Construction already reserved all client/main lifecycle representations.
   this.#reserved=true;this.#beginSequence=request.exchange;
   try{this.#claim=captureMutationClaim(body.claim,this.#limits);}
   catch{
    this.#terminal='not-submitted';this.#state='terminal-await-delivery';
    this.#retention=setTimeout(()=>{void this.close();},this.#limits.terminalRetentionMs);
    this.#reject(request,'capacity');return;
   }
   this.#state='begin-inflight';this.#invoke('begin',this.#claim);
   this.#reply(request,{kind:'accepted',phase:'begin',beginSequence:this.#beginSequence});return;
  }
  if(body.kind==='finish'){
   if(this.#state!=='prepared-await-finish'||this.#finishUsed||body.beginSequence!==this.#beginSequence){this.#reject(request,'wrong-state');return;}
   this.#finishUsed=true;this.#clearTimers();this.#state='finish-inflight';const c=this.#claim!;
   this.#invoke('finish',{ownerId:c.ownerId,generation:c.generation,attemptId:c.attemptId,wire:c.wire,outcome:body.outcome});
   this.#reply(request,{kind:'accepted',phase:'finish',beginSequence:this.#beginSequence!});return;
  }
  if(body.kind==='ack-begin'){
   if(this.#state!=='begin-result-await-ack'){this.#reject(request,'wrong-state');return;}
   this.#state='prepared-await-finish';this.#reply(request,{kind:'acknowledged',phase:'begin'});return;
  }
  if(body.kind==='ack-terminal'){
   if(this.#state!=='terminal-await-ack'){this.#reject(request,'wrong-state');return;}
   this.#reply(request,{kind:'acknowledged',phase:'terminal'});void this.close();return;
  }
  if(body.kind==='status'){
   const now=performance.now();if(now-this.#lastStatus<this.#limits.minStatusIntervalMs){this.#reject(request,'rate-limited');return;}this.#lastStatus=now;
   if(this.#state==='begin-inflight'||this.#state==='finish-inflight'){
    this.#reply(request,{kind:'pending',phase:this.#state==='begin-inflight'?'begin':'finish',beginSequence:this.#beginSequence!,closing:false});return;
   }
   if(this.#state==='begin-result-await-delivery'){
    this.#state='begin-result-await-ack';this.#reply(request,{kind:'begin-confirmed',beginSequence:this.#beginSequence!});return;
   }
   if(this.#state==='terminal-await-delivery'){
    this.#state='terminal-await-ack';this.#reply(request,{kind:'terminal',beginSequence:this.#beginSequence,result:this.#terminal});return;
   }
   this.#reject(request,'wrong-state');return;
  }
 }
}
Object.freeze(MainNativeMutationBroker.prototype);
export function createMainNativeMutationBroker(path:string,runtime:string,limits:MutationBrokerLimits):MainNativeMutationBroker{return MainNativeMutationBroker.create(path,runtime,limits);}
