import {randomBytes} from 'node:crypto';
import {isMainThread,MessageChannel,MessagePort,Worker} from 'node:worker_threads';
import {types} from 'node:util';
import {pinNativeRuntimePath} from './runtime-paths/path-text.ts';
import {requireDiscordText} from '../discord/text.ts';
import {sha256SerdeValue} from '../core/serde-json.ts';
import {restoreServerPromptComponentTransfer,type DiscordComponent} from '../discord/components.ts';
import {idempotentMessageRequestWithComponents,type IdempotentMessageRequest} from '../discord/idempotent-message.ts';
import {createNativePromptAuthorityReads} from './server-prompt-authority-reads.ts';
import {sendReceiptChunk,type DiscordReceiptTransport} from './completion/receipt-sender.ts';
import {captureReceiverCommand,captureReceiverControlCommand,captureReceiverTerminal,projectReceiverFailure,receiverFrame,type ReceiverDescriptor,type ReceiverOperation,type ReceiverTerminal,type ReceiverReply} from './persistent-receiver-protocol.ts';

type Operation={readonly id:number;input:ReceiverOperation|null;controller:AbortController|null;task:Promise<void>|null;joined:boolean;cancelled:boolean;result:ReceiverTerminal|null;terminalSent:boolean};
type Phase='boot'|'idle'|'running'|'terminal'|'closing'|'closed';
const fixtureScenarios=new Set(['receiver-computer-form-recovery','receiver-browser-form-event','receiver-unsupported-form-event','receiver-approval-prompt','receiver-input-prompt','receiver-late-accept','receiver-read-json','receiver-native-join','receiver-data-loss','receiver-ack-loss','receiver-control-before-admission-probe']);
const transportScenarios=new Set(['receiver-approval-prompt','receiver-input-prompt','receiver-late-accept','receiver-native-join','receiver-data-loss','receiver-ack-loss']);
const fixedFailure=()=>new Error('Persistent receiver service unavailable; original work and component debt retained');

/** Fixed disposable transport, deliberately not an installed HTTP adapter. No
 * callback, request body, URL or credential can configure it. The first four
 * shared integers are main-only transport observations. The fifth is a worker-
 * only direct client-result observation. Probe words 5..8 record exact dropped
 * ID, pending client ID, deliberate rescue, and unresolved client slot at exit.
 * None is join or release evidence. */
class ReceiverFixtureTransport implements DiscordReceiptTransport{
 readonly observation=new SharedArrayBuffer(36);readonly #words=new Int32Array(this.observation);
 readonly #data:MessagePort;
 #scenario:string|null=null;#calls=0;#hash:string|null=null;
 #chunk:Extract<ReceiverOperation,{op:'server-prompt-chunk'}>|null=null;#components:readonly DiscordComponent[]|null=null;
 constructor(data:MessagePort){this.#data=data;}
 configure(scenario:string):void{if(this.#scenario!==null||!fixtureScenarios.has(scenario))throw new TypeError('Receiver fixture already selected or unknown');this.#scenario=scenario;}
 bindChunk(chunk:Extract<ReceiverOperation,{op:'server-prompt-chunk'}>,components:readonly DiscordComponent[]):void{
  if(this.#chunk!==null)throw new TypeError('Fixed transport already has an original chunk');this.#chunk=chunk;this.#components=components;
 }
 clearChunk():void{this.#chunk=null;this.#components=null;}
 #validateOriginalRequest(request:IdempotentMessageRequest):void{
  const chunk=this.#chunk,components=this.#components;if(chunk===null||components===null)throw new TypeError('Fixed transport has no original chunk');
  // Compare exact original helper bytes synchronously. The temporary expected
  // request is not retained across transport/receipt awaits or placed on a port.
  const expected=idempotentMessageRequestWithComponents(chunk.channel,chunk.content,components,'server-request/prompt/v1',chunk.logicalKey,chunk.chunkIndex);
  if(request.method!==expected.method||request.path!==expected.path||request.body!==expected.body||request.path!=='channels/42/messages')throw new TypeError('Fixed receiver transport request differs');
 }
 async sendValidated(request:IdempotentMessageRequest,signal?:AbortSignal):Promise<bigint>{
  if(this.#scenario===null||!transportScenarios.has(this.#scenario)||this.#calls>=4)throw new Error('Fixed receiver transport is unavailable');
  if(signal===undefined||types.isProxy(signal)||!(signal instanceof AbortSignal))throw new TypeError('Original receiver transport signal required');
  signal.throwIfAborted();
  this.#validateOriginalRequest(request);
  this.#hash=sha256SerdeValue(request);this.#calls++;Atomics.store(this.#words,3,this.#calls);Atomics.store(this.#words,0,1);Atomics.notify(this.#words,0);
  // Fixed negative instrumentation owns this exact construction's data port.
  // Real receipt begin has already joined and the original transport is entered.
  if(this.#scenario==='receiver-data-loss')this.#data.close();
  if(this.#scenario==='receiver-late-accept'||this.#scenario==='receiver-data-loss'){
   await new Promise<void>(resolve=>{const abort=()=>{signal.removeEventListener('abort',abort);Atomics.store(this.#words,1,1);Atomics.notify(this.#words,1);resolve();};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
  }
  // A validated provider acceptance remains known after original cancellation.
  Atomics.store(this.#words,2,this.#calls);Atomics.notify(this.#words,2);return 100n+BigInt(this.#calls);
 }
 snapshot(){return Object.freeze({calls:this.#calls,lastRequestHash:this.#hash,clientResultObserved:Atomics.load(this.#words,4)===1,probeDroppedId:Atomics.load(this.#words,5),probePendingId:Atomics.load(this.#words,6),probeRescueIssued:Atomics.load(this.#words,7)===1,probeClientUnjoinedAtExit:Atomics.load(this.#words,8)===1});}
}

/** Main-only, fixed service owner for the disposable original serial receiver.
 * A separate one-use control port can seal delayed data before proving actual
 * joins. Correlation/port receipts never create resident or response authority. */
export class PersistentReceiverServicesOwner{
 readonly #path:string;readonly #requester:Worker;readonly #epoch=randomBytes(16).toString('hex');
 readonly #data:MessagePort;readonly #control:MessagePort;readonly #remoteData:MessagePort;readonly #remoteControl:MessagePort;
 readonly #reads:ReturnType<typeof createNativePromptAuthorityReads>;readonly #transport:ReceiverFixtureTransport;
 readonly #failure=new AbortController();readonly #joined:Promise<void>;#joinResolve!:()=>void;
 #phase:Phase='boot';#slot:Operation|null=null;#high=0;#retired=0;#quarantined=false;#transferred=false;
 #dataValid=true;#controlValid=true;#dataClosed=false;#controlClosed=false;#controlUsed=false;#controlReplySent=false;#requesterExited=false;#scenario:string|null=null;#completed=0;
 constructor(path:string,requester:Worker){
  if(!isMainThread||types.isProxy(requester)||!(requester instanceof Worker))throw new TypeError('Original main requester owner required');
  requireDiscordText(path);this.#path=pinNativeRuntimePath(path);this.#requester=requester;this.#reads=createNativePromptAuthorityReads(this.#path);
  const data=new MessageChannel(),control=new MessageChannel();this.#data=data.port1;this.#remoteData=data.port2;this.#control=control.port1;this.#remoteControl=control.port2;
  this.#transport=new ReceiverFixtureTransport(this.#data);
  this.#joined=new Promise<void>(resolve=>{this.#joinResolve=resolve;});
  this.#data.on('message',this.#onData);this.#data.on('messageerror',()=>this.#fault('data'));
  this.#control.on('message',this.#onControl);this.#control.on('messageerror',()=>this.#fault('control'));
  this.#data.on('close',()=>{this.#dataClosed=true;if(this.#phase!=='closed')this.#fault('data');this.#checkJoined();});
  this.#control.on('close',()=>{this.#controlClosed=true;if(this.#phase!=='closed')this.#fault('control');this.#checkJoined();});
  this.#data.start();this.#control.start();
  requester.once('exit',()=>{
   this.#requesterExited=true;
   // Normal ack-close already seals an empty, actually joined owner. Local
   // port-close observations may lag the requester's exit event; wait for those
   // observations instead of inventing an abnormal-close race.
   if(this.#phase!=='closed'||this.#slot!==null)this.#fault('data');
   this.#closeAfterRequesterExit();
  });
 }
 get failure():AbortSignal{return this.#failure.signal;}
 initializeRequester():void{
  if(this.#transferred||this.#quarantined||this.#phase!=='boot')throw fixedFailure();
  const receiverServices:ReceiverDescriptor={version:1,kind:'persistent-receiver-services-v1',epoch:this.#epoch,data:this.#remoteData,control:this.#remoteControl};
  // This is the only transfer; the original requester is construction-pinned.
  this.#transferred=true;
  try{Worker.prototype.postMessage.call(this.#requester,{version:1,kind:'services-initialized',receiverServices,fixtureObservation:this.#transport.observation},[this.#remoteData,this.#remoteControl]);}
  catch(error){this.#fault('data');throw error;}
 }
 configureFixture(scenario:string):void{
  if(this.#scenario!==null||this.#quarantined||this.#phase!=='idle'||!fixtureScenarios.has(scenario))throw fixedFailure();
  this.#scenario=scenario;this.#transport.configure(scenario);
 }
 get closed():boolean{return this.#phase==='closed'&&this.#dataClosed&&this.#controlClosed;}
 get releasable():boolean{return this.closed&&!this.#quarantined&&this.#slot===null;}
 join():Promise<void>{return this.#joined;}
 quarantine():void{
  // The component's own failure listener may reenter after a control-only fault.
  // Do not turn that notification into data loss: its exact current terminal
  // remains a permitted source of real join evidence.
  if(!this.releasable&&!this.#quarantined)this.#fault('data');
 }
 async closeStartup():Promise<void>{
  this.#fault('data');
  // A failed transfer may leave either original remote handle in main. Sealed
  // zero-admission startup has no operation to join, including delayed submits.
  // Still observe actual local close events and retain permanent quarantine.
  if(this.#high===0&&this.#slot===null){this.#remoteData.close();this.#remoteControl.close();this.#controlValid=false;this.#data.close();this.#control.close();}
  await this.#joined;
 }
 snapshot(){return Object.freeze({closed:this.closed,releasable:this.releasable,quarantined:this.#quarantined,pending:this.#slot!==null&&!this.#slot.joined,terminalRetained:this.#slot?.joined===true,submitted:this.#high,retired:this.#retired,completed:this.#completed,dataClosed:this.#dataClosed,controlClosed:this.#controlClosed,controlReplySent:this.#controlReplySent,...this.#transport.snapshot()});}
 /** Diagnostic rescue only. The component dispatcher calls this only after its
  * original disposal report proves child closure. It closes this construction's
  * remaining endpoint; it never settles the client slot or releases root debt. */
 rescueBeforeAdmissionProbe():void{
  const words=new Int32Array(this.#transport.observation);
  if(this.#scenario!=='receiver-control-before-admission-probe'||!this.#quarantined||this.#controlValid||!this.#dataValid||this.#dataClosed||this.#phase!=='idle'||this.#slot!==null||this.#high!==0||this.#completed!==0||this.#retired!==0||Atomics.load(words,5)!==1||Atomics.load(words,6)!==1||Atomics.load(words,7)!==0)throw fixedFailure();
  Atomics.store(words,7,1);this.#fault('data');
 }
 #post(body:ReceiverReply):void{if(!this.#dataValid||this.#dataClosed)throw fixedFailure();try{this.#data.postMessage(receiverFrame(this.#epoch,body));}catch(error){this.#fault('data');throw error;}}
 #checkJoined():void{if(this.#dataClosed&&this.#controlClosed&&(this.#slot===null||this.#slot.joined))this.#joinResolve();}
 #closeAfterRequesterExit():void{
  if(!this.#requesterExited)return;
  if(this.#slot!==null&&!this.#slot.joined)return;
  this.#dataValid=false;this.#controlValid=false;this.#data.close();this.#control.close();this.#checkJoined();
 }
 #fault(which:'data'|'control'):void{
  if(this.releasable)return;
  this.#quarantined=true;
  if(which==='data'){this.#dataValid=false;this.#data.close();}else{this.#controlValid=false;this.#control.close();}
  const slot=this.#slot;if(slot!==null&&!slot.joined&&slot.input?.op==='server-prompt-chunk')slot.controller!.abort(fixedFailure());
  // Listener sees the original local signal; no dependency on parent quarantine.
  if(!this.#failure.signal.aborted)this.#failure.abort(fixedFailure());
  if(!this.#transferred){this.#remoteData.close();this.#remoteControl.close();this.#data.close();this.#control.close();}
  this.#closeAfterRequesterExit();this.#checkJoined();
 }
 #onData=(raw:unknown):void=>{
  if(!this.#dataValid)return;
  try{
   const command=captureReceiverCommand(raw,this.#epoch);
   if(this.#scenario==='receiver-control-before-admission-probe'&&command.kind==='submit'&&!this.#quarantined){
    if(command.id!==1||this.#phase!=='idle'||this.#slot!==null||this.#high!==0||this.#retired!==0)throw fixedFailure();
    this.#fault('control');
   }
   // Control-only fault keeps just the original terminal/cancel/retirement path.
   if(this.#quarantined&&!['cancel','ack-terminal'].includes(command.kind)){
    // Record the actual validated submit discarded at the unfixed filter.
    if(this.#scenario==='receiver-control-before-admission-probe'&&command.kind==='submit'&&command.id===1&&this.#phase==='idle'&&this.#slot===null&&this.#high===0&&!this.#controlValid)Atomics.store(new Int32Array(this.#transport.observation),5,command.id);
    return;
   }
   if(command.kind==='ready'){
    if(this.#phase!=='boot'||this.#slot!==null)throw fixedFailure();this.#phase='idle';this.#post({kind:'ready'});return;
   }
   if(command.kind==='submit'){
    if(this.#phase!=='idle'||this.#slot!==null||command.id!==this.#high+1)throw fixedFailure();
    this.#high=command.id;this.#phase='running';
    const slot:Operation={id:command.id,input:command.operation,controller:command.operation.op==='server-prompt-chunk'?new AbortController():null,task:null,joined:false,cancelled:false,result:null,terminalSent:false};
    this.#slot=slot;slot.task=this.#run(slot);void slot.task.catch(()=>this.#fault('data'));return;
   }
   if(command.kind==='cancel'){
    const slot=this.#slot;if(slot===null||slot.id!==command.id||slot.input?.op!=='server-prompt-chunk'||slot.cancelled)throw fixedFailure();
    slot.cancelled=true;if(!slot.joined)slot.controller!.abort(new Error('Original receiver chunk cancelled'));return;
   }
   if(command.kind==='ack-terminal'){
    const slot=this.#slot;if(slot===null||slot.id!==command.id||!slot.joined||!slot.terminalSent||slot.result===null)throw fixedFailure();
    if(this.#scenario==='receiver-ack-loss'&&slot.input?.op==='server-prompt-chunk'){this.#fault('data');return;}
    this.#retired=slot.id;slot.input=null;slot.controller=null;slot.task=null;slot.result=null;this.#slot=null;this.#phase='idle';this.#post({kind:'retired',id:command.id});this.#checkJoined();return;
   }
   if(command.kind==='close'){
    if(this.#phase!=='idle'||this.#slot!==null||this.#quarantined)throw fixedFailure();this.#phase='closing';this.#post({kind:'closed'});return;
   }
   if(command.kind==='ack-close'){
    if(this.#phase!=='closing'||this.#slot!==null||this.#quarantined)throw fixedFailure();this.#phase='closed';this.#dataValid=false;this.#controlValid=false;this.#data.close();this.#control.close();return;
   }
   throw fixedFailure();
  }catch{this.#fault('data');}
 };
 #onControl=(raw:unknown):void=>{
  if(!this.#controlValid)return;
  try{
   const command=captureReceiverControlCommand(raw,this.#epoch);if(this.#controlUsed)throw fixedFailure();this.#controlUsed=true;
   const slot=this.#slot,id=command.id;
   const matches=slot!==null?id===slot.id:(id===this.#retired||(this.#phase==='idle'&&this.#high===this.#retired&&id===this.#high+1));
   if(!matches||(id===0&&this.#high!==0))throw fixedFailure();
   // Seal first. A data submission already queued but not admitted is now inert.
   this.#fault('data');
   const join=slot?.task??Promise.resolve();
   void join.then(()=>{
    if(slot!==null&&!slot.joined)throw fixedFailure();
    if(!this.#controlValid||this.#controlClosed)return;
    this.#control.postMessage(receiverFrame(this.#epoch,{kind:'joined',id}));
    this.#controlReplySent=true;
   }).catch(()=>this.#fault('control'));
  }catch{this.#fault('control');}
 };
 async #execute(input:ReceiverOperation,signal?:AbortSignal):Promise<unknown>{
  switch(input.op){
   case 'observed-completion':return this.#reads.hasObservedCompletion(this.#path,input.thread,input.turn);
   case 'all-jobs':return this.#reads.listQueueJobs(this.#path);
   case 'channel-mapping':return this.#reads.mirroredThreadId(this.#path,input.channel);
   case 'server-prompt-chunk':{
    const components=restoreServerPromptComponentTransfer(input.components);
    this.#transport.bindChunk(input,components);
    try{await sendReceiptChunk(this.#path,this.#transport,input.channel,{domain:'server-request/prompt/v1',logicalKey:input.logicalKey,chunkIndex:input.chunkIndex,content:input.content},components,null,signal,true);return null;}
    finally{this.#transport.clearChunk();}
   }
  }
 }
 async #run(slot:Operation):Promise<void>{
  const input=slot.input!;
  try{
   try{const value=await this.#execute(input,slot.controller?.signal);slot.result=captureReceiverTerminal(input,{kind:'ok',value});}
   catch(error){slot.result=captureReceiverTerminal(input,{kind:'error',failure:projectReceiverFailure(input,error,slot.controller?.signal)});}
  }catch{
   slot.result={kind:'error',failure:{kind:input.op==='server-prompt-chunk'?'unclassified-chunk-failure':'unclassified-read-failure'}};
   this.#fault('data');
  }finally{
   // The original read/sender Promise already includes actual native exit and
   // receipt close. Neither timeout, cancellation nor a port event gets here early.
   slot.joined=true;
   this.#completed++;
   if(this.#slot===slot){this.#phase='terminal';if(this.#dataValid&&!this.#dataClosed){try{slot.terminalSent=true;this.#post({kind:'terminal',id:slot.id,operation:input.op,result:slot.result!});}catch{/* Original result/debt stays retained. */}}}
   this.#closeAfterRequesterExit();this.#checkJoined();
  }
 }
}
Object.freeze(PersistentReceiverServicesOwner.prototype);
