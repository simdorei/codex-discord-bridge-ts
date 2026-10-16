import {randomBytes,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {isMainThread,MessageChannel,type MessagePort,Worker} from 'node:worker_threads';
import {types} from 'node:util';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {decodeDeadGenerationTransfer} from '../app-server/dead-generation-transfer.ts';
import {NativeDeadGenerationOwner} from './native-dead-generation.ts';
import {NativeIdleBeforeOwner} from './native-idle-before.ts';
import {NativeObservationLedgerOwner} from './native-observation-ledger.ts';
import {NativeResponseCompletionTransport,type NativeResponseCompletionJob} from './native-response-completion-transport.ts';
import {pinNativeRuntimePath} from './runtime-paths/path-text.ts';
import {
 SERVICE_PROFILES,SERVICE_LIMITS,checkedServiceReservation,checkExchangeHeadroom,
 validateServiceRequest,captureServicePayload,captureServiceResult,slotAllowsPayload,
 type ServiceFamily,type ServicePayload,type ServiceReplyBody,type ServiceEndpointDescriptor,
} from './persistent-resident-services-protocol.ts';

const FAMILIES:readonly ServiceFamily[]=Object.freeze(['dead','idle','verify','gap','response']);
const fixedFailure=()=>new Error('Original resident service result unavailable; no automatic retry');
type Terminal={kind:'ok';value:unknown}|{kind:'failed';category:'owner-failed'|'cancelled'|'transport-unknown'};
interface Operation {
 readonly id:number;readonly slot:number;readonly controller:AbortController;
 input:ServicePayload|null;fixedJob:unknown;task:Promise<void>|null;joined:boolean;
 result:Terminal|null;terminalFrame:ServiceReplyBody|null;delivered:boolean;cancelled:boolean;
 remaining:number;statusPosts:number;lastStatus:number;
 watchdog:ReturnType<typeof setTimeout>|null;retention:ReturnType<typeof setTimeout>|null;
}
interface Endpoint {
 readonly service:ServiceFamily;readonly port:MessagePort;transfer:MessagePort|null;
 readonly slots:Array<Operation|null>;readonly lastRetired:number[];readonly disposedPromise:Promise<void>;resolveDisposed:()=>void;
 ready:boolean;stopped:boolean;closed:boolean;disposed:boolean;controlBusy:boolean;
 lastExchange:number;lastOperation:number;retiredThrough:number;controlRemaining:number;
 handshake:ReturnType<typeof setTimeout>|null;
}
function identity(value:string,max:number):string{
 if(typeof value!=='string'||value.length===0||value.includes('\0')||value.length>max||Buffer.byteLength(value)>max||Buffer.from(value).toString('utf8')!==value)throw new TypeError('Invalid pinned resident service identity');
 return value;
}

/** Internal fixed component owner. Correlation is not original business authority.
 * Five ports belong to the exact constructor Worker; the independent 948 endpoint
 * is deliberately absent here. Reservations are logical representation accounting,
 * not an allocation or a native/SQLite/process memory claim. */
export class PersistentResidentServicesOwner {
 readonly #path:string;readonly #runtime:string;readonly #channel:bigint|null;
 readonly #requester:Worker;readonly #epoch=randomBytes(16).toString('hex');
 readonly #endpoints:Endpoint[]=[];
 readonly #reservation=checkedServiceReservation();
 readonly custodyActivated:Promise<void>;
 #resolveActivation!:()=>void;#rejectActivation!:(reason:unknown)=>void;
 #activationAttempted=false;#activated=false;#initialized=false;#bound=false;
 #dead:NativeDeadGenerationOwner|null=null;#idle:NativeIdleBeforeOwner|null=null;
 #response:NativeResponseCompletionTransport|null=null;
 #verify:NativeObservationLedgerOwner|null=null;#gap:NativeObservationLedgerOwner|null=null;
 #quarantined=false;#normalDisposed=false;#exited=false;#exitCode:number|null=null;
 #reservationReleased=false;#startupCleanupIndex=0;#startupClose:Promise<void>|null=null;
 constructor(path:string,runtime:string,startupChannel:bigint|null,requester:Worker){
  if(!isMainThread||types.isProxy(requester)||!(requester instanceof Worker))throw new TypeError('Expected original main-owned resident Worker');
  this.#path=pinNativeRuntimePath(identity(path,32768));identity(this.#path,32768);
  this.#runtime=identity(runtime,4096);this.#channel=startupChannel;this.#requester=requester;
  if(startupChannel!==null&&(typeof startupChannel!=='bigint'||startupChannel<0n||startupChannel>=(1n<<63n)))throw new TypeError('Invalid pinned startup channel');
  this.custodyActivated=new Promise<void>((resolve,reject)=>{this.#resolveActivation=resolve;this.#rejectActivation=reject;});
  void this.custodyActivated.catch(()=>undefined);
  for(const service of FAMILIES){
   const {port1,port2}=new MessageChannel(),count=SERVICE_PROFILES[service].slots;
   let resolveDisposed!:()=>void;const disposedPromise=new Promise<void>(resolve=>{resolveDisposed=resolve;});
   const endpoint:Endpoint={service,port:port1,transfer:port2,disposedPromise,resolveDisposed,slots:Array.from({length:count},()=>null),lastRetired:Array.from({length:count},()=>0),ready:false,stopped:false,closed:false,disposed:false,controlBusy:false,lastExchange:0,lastOperation:0,retiredThrough:0,controlRemaining:SERVICE_LIMITS.controlExchangeReserve,handshake:null};
   this.#endpoints.push(endpoint);
   port1.on('message',(raw:unknown)=>this.#onSubmit(endpoint,raw));
   port1.on('messageerror',()=>this.#quarantine());
   port1.on('close',()=>{endpoint.disposed=true;endpoint.resolveDisposed();if(!endpoint.closed)this.#quarantine();this.#disposeJoined(endpoint);this.#maybeReleaseReservation();});
  }
  requester.once('error',()=>this.#quarantine());
  requester.once('exit',code=>{
   this.#exited=true;this.#exitCode=code;
   if(code!==0||!this.#normalDisposed||!this.servicesClosed)this.#quarantine();
   this.#maybeReleaseReservation();
  });
 }
 get quarantined():boolean{return this.#quarantined;}
 get requesterExited():boolean{return this.#exited;}
 get normalDisposalConfirmed():boolean{return this.#normalDisposed;}
 get servicesClosed():boolean{return this.#endpoints.every(e=>e.closed&&e.slots.every(s=>s===null));}
 get releasable():boolean{return !this.#quarantined&&this.#normalDisposed&&this.#exited&&this.#exitCode===0&&this.servicesClosed&&this.#endpoints.every(e=>e.disposed);}
 get reservationRetained():boolean{return !this.#reservationReleased;}
 /** Transfer is a single fixed message to the original Worker, never a public port return. */
 bindRequester():void{
  if(this.#bound||this.#exited||this.#quarantined)throw new TypeError('Resident services already bound or unavailable');this.#bound=true;
  const endpoints:ServiceEndpointDescriptor[]=this.#endpoints.map(e=>({service:e.service,epoch:this.#epoch,port:e.transfer!}));
  try{this.#requester.postMessage({version:1,kind:'native-services',endpoints},endpoints.map(e=>e.port));}
  catch{this.#quarantine();throw fixedFailure();}
  finally{for(const e of this.#endpoints)e.transfer=null;}
  for(const e of this.#endpoints)e.handshake=setTimeout(()=>this.#quarantine(),SERVICE_LIMITS.exchangeTimeoutMs);
 }
 /** Parent first constructs the separate 948 broker after custodyActivated.
  * Preserve native construction order idle, response, verification, gaps. */
 initializeRemainingOwners():void{
  if(!this.#activated||this.#initialized||this.#quarantined)throw new TypeError('Resident service construction out of order');this.#initialized=true;
  this.#idle=new NativeIdleBeforeOwner(this.#path,()=> 'Native idle result unavailable',SERVICE_LIMITS.nativeTimeoutMs);
  this.#response=new NativeResponseCompletionTransport(this.#path,SERVICE_LIMITS.nativeTimeoutMs);
  this.#verify=new NativeObservationLedgerOwner(this.#path,SERVICE_LIMITS.nativeTimeoutMs);
  this.#gap=new NativeObservationLedgerOwner(this.#path,SERVICE_LIMITS.nativeTimeoutMs);
 }
 notifyNormalResidentDisposed():void{
  if(this.#normalDisposed||this.#quarantined||!this.servicesClosed)throw new TypeError('Missing joined normal resident disposal proof');
  this.#normalDisposed=true;this.#maybeReleaseReservation();
 }
 /** Wait for the current fixed inventory. It does not manufacture child-exit proof,
  * retire terminals, or close idle before lifecycle journalExit. */
 async join():Promise<void>{
  await Promise.all(this.#endpoints.flatMap(e=>e.slots.map(s=>s?.task??Promise.resolve())));
  await Promise.all(this.#endpoints.filter(e=>e.closed||this.#quarantined).map(e=>e.disposedPromise));
  for(const e of this.#endpoints)this.#disposeJoined(e);
  this.#maybeReleaseReservation();
 }
 /** Internal startup-failure cleanup only. Parent inserts the unchanged 948
  * mutation close between dead and response. A rejected phase remains retained;
  * callers stop at that first rejection, matching the original startup behavior. */
 closeStartupService(service:ServiceFamily):Promise<void>{
  const order:readonly ServiceFamily[]=['dead','response','idle','verify','gap'];
  if(order[this.#startupCleanupIndex]!==service)throw new TypeError('Startup cleanup service out of order');
  if(this.#startupClose!==null)return this.#startupClose;
  this.#quarantine();
  const task=this.#closeService(service).then(()=>{this.#startupCleanupIndex++;this.#startupClose=null;});
  this.#startupClose=task;void task.catch(()=>undefined);return task;
 }
 #maybeReleaseReservation():void{if(this.releasable){void this.#reservation;this.#reservationReleased=true;}}
 #quarantine():void{
  if(this.#quarantined)return;this.#quarantined=true;this.#rejectActivation(fixedFailure());
  for(const e of this.#endpoints){
   e.stopped=true;if(e.handshake!==null){clearTimeout(e.handshake);e.handshake=null;}
   for(const op of e.slots)if(op!==null){op.controller.abort(fixedFailure());if(op.watchdog!==null)clearTimeout(op.watchdog);if(op.retention!==null)clearTimeout(op.retention);op.watchdog=null;op.retention=null;}
   e.transfer?.close();e.transfer=null;e.port.close();
  }
 }
 #disposeJoined(e:Endpoint):void{
  if(!e.disposed)return;
  for(const op of e.slots)if(op?.joined){op.input=null;op.fixedJob=null;op.result=null;op.terminalFrame=null;op.task=null;}
  // Keep fixed scalar slot/debt records: endpoint disposal never licenses reuse.
 }
 #post(e:Endpoint,exchange:number,body:ServiceReplyBody):void{
  if(this.#quarantined||e.disposed)throw fixedFailure();
  e.port.postMessage({version:1,service:e.service,epoch:this.#epoch,exchange,body});
 }
 #reserved(e:Endpoint):number{return e.slots.reduce((n,s)=>n+(s?.remaining??0),0);}
 #onSubmit(e:Endpoint,raw:unknown):void{
  // owner.onSubmit is the received graph. No message history or logging retains it.
  try{
   if(this.#quarantined||e.closed||e.controlBusy)throw fixedFailure();
   const frame=validateServiceRequest(raw,e.service,this.#epoch,this.#runtime),body=frame.body;
   if(frame.exchange!==e.lastExchange+1)throw fixedFailure();
   if(body.kind==='submit'){
    if(!e.ready||e.stopped||e.slots[body.slot]!==null||body.operationId<=e.lastOperation||!slotAllowsPayload(e.service,body.slot,body.payload))throw fixedFailure();
    checkExchangeHeadroom(e.lastExchange,this.#reserved(e),1);
    const input=this.#captureInput(e.service,body.payload);raw=null;
    const op:Operation={id:body.operationId,slot:body.slot,controller:new AbortController(),input,fixedJob:null,task:null,joined:false,result:null,terminalFrame:null,delivered:false,cancelled:false,remaining:SERVICE_LIMITS.operationExchangeReserve-1,statusPosts:0,lastStatus:0,watchdog:null,retention:null};
    e.lastExchange=frame.exchange;e.lastOperation=op.id;e.slots[op.slot]=op;
    this.#post(e,frame.exchange,{kind:'accepted',operationId:op.id,slot:op.slot});
    op.watchdog=setTimeout(()=>this.#quarantine(),SERVICE_LIMITS.phaseMs);
    op.task=this.#run(e,op);return;
   }
   e.lastExchange=frame.exchange;
   if(body.kind==='ready'||body.kind==='stop-new-work'||body.kind==='close-idle'){
    if(e.controlRemaining<=0)throw fixedFailure();e.controlRemaining--;
    if(body.kind==='ready'){
     if(e.ready||e.stopped)throw fixedFailure();e.ready=true;if(e.handshake!==null)clearTimeout(e.handshake);e.handshake=null;
     this.#post(e,frame.exchange,{kind:'ready',slots:e.slots.length});return;
    }
    if(!e.ready)throw fixedFailure();
    if(body.kind==='stop-new-work'){
     if(e.stopped)throw fixedFailure();e.stopped=true;this.#post(e,frame.exchange,{kind:'stopped-new-work'});return;
    }
    if(!e.stopped||e.slots.some(s=>s!==null))throw fixedFailure();
    e.controlBusy=true;
    void this.#closeService(e.service).then(()=>{
     this.#post(e,frame.exchange,{kind:'closed'});e.closed=true;e.controlBusy=false;e.port.close();
    }).catch(()=>this.#quarantine());return;
   }
   if(!e.ready)throw fixedFailure();
   if(body.kind!=='status'&&body.kind!=='cancel'&&body.kind!=='ack-terminal')throw fixedFailure();
   const op=e.slots[body.slot];
   if(op===null||op===undefined||op.id!==body.operationId||op.remaining<=0)throw fixedFailure();op.remaining--;
   if(body.kind==='cancel'){
    if(!op.cancelled&&!op.joined){op.cancelled=true;op.controller.abort(fixedFailure());}
    this.#post(e,frame.exchange,{kind:'cancel-requested',operationId:op.id,slot:op.slot});return;
   }
   if(body.kind==='status'){
    const now=performance.now();if(op.statusPosts>=SERVICE_LIMITS.maxStatusPosts||(op.statusPosts>0&&now-op.lastStatus<SERVICE_LIMITS.statusPeriodMs))throw fixedFailure();
    op.statusPosts++;op.lastStatus=now;
    if(!op.joined||op.result===null){this.#post(e,frame.exchange,{kind:'pending',operationId:op.id,slot:op.slot});return;}
    if(op.delivered){this.#post(e,frame.exchange,{kind:'terminal-observed',operationId:op.id,slot:op.slot,result:op.result.kind});return;}
    op.delivered=true;this.#postTerminal(e,op,frame.exchange);return;
   }
   if(body.kind!=='ack-terminal'||!op.joined||!op.delivered||op.result===null)throw fixedFailure();
   if(op.retention!==null)clearTimeout(op.retention);op.retention=null;
   op.input=null;op.fixedJob=null;op.result=null;op.terminalFrame=null;op.task=null;
   e.lastRetired[op.slot]=op.id;e.retiredThrough=Math.max(e.retiredThrough,op.id);e.slots[op.slot]=null;
   this.#post(e,frame.exchange,{kind:'retired',operationId:op.id,slot:op.slot});
  }catch{this.#quarantine();}
 }
 #captureInput(service:ServiceFamily,input:unknown):ServicePayload{return captureServicePayload(service,input,this.#runtime);}
 #normalizeResult(service:ServiceFamily,input:ServicePayload,value:unknown):unknown{return captureServiceResult(service,input,value);}
 #postTerminal(e:Endpoint,op:Operation,exchange:number):void{
  // owner.postTerminal aliases the one normalized graph; never duplicate per poll.
  op.terminalFrame={kind:'terminal',operationId:op.id,slot:op.slot,result:op.result!};this.#post(e,exchange,op.terminalFrame);
 }
 async #run(e:Endpoint,op:Operation):Promise<void>{
  try{
   const value=await this.#makeFixedJob(op);op.controller.signal.throwIfAborted();
   op.result={kind:'ok',value:this.#normalizeResult(e.service,op.input!,value)};
  }catch{op.result={kind:'failed',category:'owner-failed'};}
  finally{
   // Every original owner/950 transport promise includes its actual native join.
   op.joined=true;op.input=null;op.fixedJob=null;
   if(op.watchdog!==null)clearTimeout(op.watchdog);op.watchdog=null;
   if(!this.#quarantined&&!e.disposed)op.retention=setTimeout(()=>this.#quarantine(),SERVICE_LIMITS.terminalRetentionMs);
   this.#disposeJoined(e);
  }
 }
 async #makeFixedJob(op:Operation):Promise<unknown>{
  const input=op.input!,signal=op.controller.signal;
  if(input.op==='activate-custody'){
   if(this.#activationAttempted)throw fixedFailure();this.#activationAttempted=true;
   try{
    this.#dead=await NativeDeadGenerationOwner.startWithCustodyActivation(this.#path,this.#runtime,this.#channel,()=> 'Dead-generation result unavailable',signal,SERVICE_LIMITS.nativeTimeoutMs);
    this.#activated=true;this.#resolveActivation();return null;
   }catch(error){this.#rejectActivation(fixedFailure());throw error;}
  }
  if(!this.#activated)throw fixedFailure();
  if(input.op==='capture-dead'){
   const work=decodeDeadGenerationTransfer(input.work);op.fixedJob=work;
   await this.#dead!.capture(input.instanceId,work,signal);return null;
  }
  if(!this.#initialized)throw fixedFailure();
  // Non-converting families alias captureInput as their charged fixed-job graph.
  op.fixedJob=input;
  switch(input.op){
   case 'idle-install':await this.#idle!.validateInstallation(signal);return null;
   case 'idle-before':return await this.#idle!.before(input.ownerId,input.generation,input.threadId,signal);
   case 'idle-transition':return await this.#idle!.transition(input.token,input.state,input.detail,signal);
   case 'idle-exit':await this.#idle!.settleExitedOwner(input.ownerId,input.generation,signal);return null;
   case 'observation-activate':await this.#verify!.activate(input.scope,signal);return null;
   case 'observation-verified':return await this.#verify!.verified(input.scope,input.through,signal);
   case 'gap-discover':await this.#gap!.discoverGap(input.scope,input.upper,signal);return null;
   case 'gap-unknown':await this.#gap!.markUnknownGap(input.scope,'original observation stream gap',signal);return null;
   case 'response-finish':{
    const requestId=randomUUID(),job:NativeResponseCompletionJob={requestId,scope:input.scope,authority:input.authority,payload:input.payload,outcome:input.outcome};op.fixedJob=job;
    const handle=this.#response!.prepare();signal.throwIfAborted();
    const raw=await this.#response!.submit(handle,job,signal);signal.throwIfAborted();
    if(boundedSerdeByteCount(raw,16384)===null||own(raw,'ok')!==true||own(raw,'requestId')!==requestId)throw fixedFailure();
    return null;
   }
  }
 }
 async #closeService(service:ServiceFamily):Promise<void>{
  switch(service){case 'dead':await this.#dead?.close();break;case 'idle':await this.#idle?.close();break;case 'verify':await this.#verify?.close();break;case 'gap':await this.#gap?.close();break;case 'response':await this.#response?.close();break;}
 }
}
Object.freeze(PersistentResidentServicesOwner.prototype);
