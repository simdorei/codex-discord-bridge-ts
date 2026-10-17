import {isMainThread, MessagePort} from 'node:worker_threads';
import {types} from 'node:util';
import {ServerRequestOccurrence} from '../protocol/ids.ts';
import {encodeDeadGenerationTransfer} from '../app-server/dead-generation-transfer.ts';
import type {DeadGenerationWork} from '../app-server/dead-generation-work.ts';
import {cloneIdleReleaseToken, type IdleReleaseToken} from '../app-server/idle-release-journal.ts';
import {IdleObservationError} from '../app-server/notification-state.ts';
import {MutationOutcomeUnknownError} from '../app-server/maintenance-attempt.ts';
import type {DurableResponseClaim, DurableResponseCompletion} from '../app-server/response-attempt.ts';
import {responseCustodyScope} from './response-custody-fence.ts';
import {createRuntimeFenceErrors} from './fence-errors.ts';
import {
 SERVICE_PROFILES, SERVICE_LIMITS, captureServicePayload, captureServiceResult,
 validateServicePayload, validateServiceReply, slotAllowsPayload, checkExchangeHeadroom,
 checkedServiceReservation, measurePassiveValue,
 type ServiceFamily, type ServicePayload, type ServiceRequestBody,
 type ServiceReplyBody, type ServiceEndpointDescriptor,
} from './persistent-resident-services-protocol.ts';

// Private provenance only: these errors never cross the endpoint or prove that
// an invoked native owner did not submit. Completion failures are always Unknown.
class LocalInputError extends Error { constructor(){super('Invalid local native service input');} }
class LocalCreditError extends Error { constructor(){super('No local native service credit');} }
class LocalClosedError extends Error { constructor(){super('Native service closed before posting');} }
class LocalCounterError extends Error { constructor(){super('Native service counter headroom exhausted');} }
const UNKNOWN='native service result not confirmed; original ownership retained; no automatic replay';
function failure(service:ServiceFamily):Error {
 if(service==='response')return new MutationOutcomeUnknownError('server/response',UNKNOWN);
 if(service==='dead'){
  try{createRuntimeFenceErrors(()=>UNKNOWN).fail('DeadGenerationFence',null);}catch(error){return error as Error;}
 }
 return new IdleObservationError(UNKNOWN);
}
function signalValid(signal:AbortSignal|undefined):void{
 if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new LocalInputError();
}
function own(input:unknown,key:string):unknown{
 if(input===null||typeof input!=='object'||types.isProxy(input))throw new LocalInputError();
 const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,'value')||!d.enumerable)throw new LocalInputError();return d.value;
}
// Shallow passive preflight views borrow upstream payloads; they are discarded
// before the required existing conversion helpers allocate their owned copies.
function preflightResponse(runtime:string,claim:DurableResponseClaim):void{
 const request=own(claim,'request');
 const scope={runtime,resident:own(claim,'ownerId'),generation:own(claim,'generation'),request:{
  id:own(request,'id'),method:own(request,'method'),params:own(request,'params'),
  occurrence:Array.from(ServerRequestOccurrence.prototype.asBytes.call(own(request,'occurrence')),byte=>BigInt(byte)),
 }};
 validateServicePayload('response',{op:'response-finish',scope,authority:own(claim,'authority'),payload:own(claim,'payload'),outcome:'not_sent'},runtime);
}
function preflightDead(instanceId:string,work:DeadGenerationWork):void{
 const requests=own(work,'serverRequests');
 if(!Array.isArray(requests)||types.isProxy(requests)||Object.getPrototypeOf(requests)!==Array.prototype||requests.length>65536||Reflect.ownKeys(requests).length!==requests.length+1)throw new LocalInputError();
 const empty={generation:own(work,'generation'),closedReason:own(work,'closedReason'),activeTurns:own(work,'activeTurns'),serverRequests:[]};
 const view={op:'capture-dead',instanceId,work:empty},limit=SERVICE_PROFILES.dead.input;
 validateServicePayload('dead',view);
 const base=measurePassiveValue(view,limit);
 let bytes=base.bytes,units=base.units,nodes=base.nodes,edges=base.edges;
 let transferBytes=measurePassiveValue(empty,limit).bytes;
 for(let i=0;i<requests.length;i++){
  const original=own(requests,String(i));
  if(original===null||typeof original!=='object'||types.isProxy(original)||Reflect.ownKeys(original).length!==4||Reflect.ownKeys(original).some(key=>typeof key!=='string'||!['id','occurrence','method','params'].includes(key)))throw new LocalInputError();
  // One borrowed request projection at a time, never a 65k projection array.
  const request={id:own(original,'id'),method:own(original,'method'),params:own(original,'params'),occurrence:Array.from(ServerRequestOccurrence.prototype.asBytes.call(own(original,'occurrence')))};
  validateServicePayload('dead',{op:'capture-dead',instanceId,work:{generation:empty.generation,closedReason:empty.closedReason,activeTurns:[],serverRequests:[request]}});
  const d=measurePassiveValue(request,{...limit,depth:limit.depth-3});
  bytes+=d.bytes+(i===0?0:1);units+=d.units;nodes+=d.nodes;edges+=d.edges+1;transferBytes+=d.bytes+(i===0?0:1);
  if(bytes>limit.bytes||units>limit.units||nodes>limit.nodes||edges>limit.edges||transferBytes>1048576)throw new LocalInputError();
 }
}
interface Exchange {
 readonly id:number;readonly kind:ServiceRequestBody['kind'];
 readonly resolve:(body:ServiceReplyBody)=>void;readonly reject:(error:unknown)=>void;
 readonly timer:ReturnType<typeof setTimeout>;
}
interface Operation {
 id:number;readonly slot:number;
 // Named copy-ledger sites. Aliasing is charged conservatively, never history.
 captureLocalInput:ServicePayload|null;
 makePassivePayload:ServicePayload|null;
 freezeSubmit:ServicePayload|null;
 exchange:Exchange|null; remaining:number; posted:boolean; accepted:boolean;
 cancelled:boolean; cancelSent:boolean; retired:boolean; abandoned:boolean;
 task:Promise<unknown>|null;
}
class Endpoint {
 readonly #service:ServiceFamily;readonly #epoch:string;readonly #runtime:string;readonly #port:MessagePort;
 readonly #slots:(Operation|null)[];readonly #lastRetired:number[];
 #exchange=0;#operation=0;#control:Exchange|null=null;#controlRemaining=3;
 #ready:Promise<void>|null=null;#close:Promise<void>|null=null;
 #admitting=true;#closed=false;#quarantined=false;
 constructor(runtime:string,descriptor:ServiceEndpointDescriptor){
  this.#service=descriptor.service;this.#epoch=descriptor.epoch;this.#runtime=runtime;this.#port=descriptor.port;
  this.#slots=Array.from({length:SERVICE_PROFILES[this.#service].slots},()=>null);
  this.#lastRetired=this.#slots.map(()=>0);
  this.#port.on('message',this.#onMessage);
  this.#port.on('messageerror',this.#onFault);
  this.#port.on('close',this.#onFault);
  this.#port.start();
 }
 #onFault=():void=>{if(!this.#closed)this.#quarantine();};
 #quarantine():void{
  if(this.#quarantined)return;this.#quarantined=true;this.#admitting=false;
  const reject=(exchange:Exchange|null)=>{if(exchange){clearTimeout(exchange.timer);exchange.reject(failure(this.#service));}};
  reject(this.#control);this.#control=null;
  for(const slot of this.#slots)if(slot){reject(slot.exchange);slot.exchange=null;slot.freezeSubmit=null;slot.makePassivePayload=null;}
  // No native slot release, success, replacement, or replay follows port disposal.
  this.#port.close();
 }
 #onMessage=(raw:unknown):void=>{
  if(this.#quarantined||this.#closed)return;
  try{
   const id=own(raw,'exchange');
   const slot=this.#slots.find(item=>item?.exchange?.id===id)??null;
   const pending=slot?.exchange??(this.#control?.id===id?this.#control:null);
   if(pending===null)throw new Error('Unexpected exchange');
   const reply=validateServiceReply(raw,this.#service,this.#epoch,slot?.captureLocalInput??undefined);
   if(reply.exchange!==pending.id)throw new Error('Unexpected exchange');
   const body=reply.body;
   if(slot){
    if(!('operationId' in body)||body.operationId!==slot.id||!('slot' in body)||body.slot!==slot.slot)throw new Error('Unexpected operation');
   }
   const expected:Record<ServiceRequestBody['kind'],readonly string[]>={
    ready:['ready'],submit:['accepted'],status:['pending','terminal'],cancel:['cancel-requested'],
    'ack-terminal':['retired'],'stop-new-work':['stopped-new-work'],'close-idle':['closed'],
   };
   if(!expected[pending.kind].includes(body.kind))throw new Error('Unexpected reply phase');
   if(body.kind==='ready'&&body.slots!==this.#slots.length)throw new Error('Unexpected capacity');
   if(body.kind==='closed')this.#closed=true;
   clearTimeout(pending.timer);if(slot)slot.exchange=null;else this.#control=null;
   pending.resolve(body);
  }catch{this.#quarantine();}
  // raw/onTerminal is not retained in a registry or a polling history.
 };
 #rpc(body:ServiceRequestBody,slot:Operation|null=null):Promise<ServiceReplyBody>{
  if(this.#quarantined||this.#closed)return Promise.reject(failure(this.#service));
  if((slot?slot.exchange:this.#control)!==null){this.#quarantine();return Promise.reject(failure(this.#service));}
  if(this.#exchange>=SERVICE_LIMITS.maxId||(slot?slot.remaining:this.#controlRemaining)<=0){this.#quarantine();return Promise.reject(failure(this.#service));}
  const id=++this.#exchange;if(slot)slot.remaining--;else this.#controlRemaining--;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>this.#quarantine(),SERVICE_LIMITS.exchangeTimeoutMs);
   const pending:Exchange={id,kind:body.kind,resolve,reject,timer};if(slot)slot.exchange=pending;else this.#control=pending;
   try{this.#port.postMessage({version:1,service:this.#service,epoch:this.#epoch,exchange:id,body});}catch{this.#quarantine();}
  });
 }
 quarantine():void{this.#quarantine();}
 ready():Promise<void>{
  if(this.#ready===null)this.#ready=this.#rpc({kind:'ready'}).then(()=>undefined);
  return this.#ready;
 }
 reserveInput(selector:{op:ServicePayload['op'];state?:string}):Operation{
  if(!this.#admitting||this.#quarantined||this.#closed)throw new LocalClosedError();
  // Internal selector is used only for slot class; it is never serialized.
  const index=this.#slots.findIndex((slot,i)=>slot===null&&slotAllowsPayload(this.#service,i,selector as ServicePayload));
  if(index<0)throw new LocalCreditError();
  const reserved=this.#slots.reduce((n,slot)=>n+(slot?.remaining??0),0);
  try{if(this.#operation+this.#slots.filter(slot=>slot!==null&&!slot.posted).length>=SERVICE_LIMITS.maxId)throw new Error();checkExchangeHeadroom(this.#exchange,reserved);}catch{throw new LocalCounterError();}
  const slot:Operation={id:0,slot:index,captureLocalInput:null,makePassivePayload:null,freezeSubmit:null,exchange:null,remaining:SERVICE_LIMITS.operationExchangeReserve,
   posted:false,accepted:false,cancelled:false,cancelSent:false,retired:false,abandoned:false,task:null};
  this.#slots[index]=slot;return slot;
 }
 captureReserved(slot:Operation,passive:unknown):Operation{
  if(slot.retired||slot.posted||slot.captureLocalInput!==null||this.#slots[slot.slot]!==slot)throw new LocalInputError();
  try{
   const payload=validateServicePayload(this.#service,passive,this.#runtime);
   if(!slotAllowsPayload(this.#service,slot.slot,payload))throw new LocalInputError();
   slot.captureLocalInput=captureServicePayload(this.#service,payload,this.#runtime);
   slot.makePassivePayload=payload;return slot;
  }catch{this.releaseLocal(slot);throw new LocalInputError();}
 }
 captureLocalInput(passive:unknown):Operation{
  let payload:ServicePayload;
  try{payload=validateServicePayload(this.#service,passive,this.#runtime);}catch{throw new LocalInputError();}
  const slot=this.reserveInput(payload);return this.captureReserved(slot,payload);
 }
 releaseLocal(slot:Operation):void{
  slot.abandoned=true;
  if(slot.retired||slot.posted)return;
  if(this.#slots[slot.slot]!==slot)throw new LocalInputError();
  slot.captureLocalInput=null;slot.makePassivePayload=null;slot.freezeSubmit=null;
  slot.retired=true;this.#slots[slot.slot]=null;
 }
 async call(passive:unknown,signal?:AbortSignal):Promise<unknown>{
  signalValid(signal);signal?.throwIfAborted();
  const slot=this.captureLocalInput(passive);passive=null;return this.finish(slot,signal);
 }
 finish(slot:Operation,signal?:AbortSignal):Promise<unknown>{
  if(slot.task!==null||slot.retired||this.#slots[slot.slot]!==slot)throw new LocalInputError();
  signalValid(signal);
  const abort=()=>{slot.cancelled=true;};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const task=this.#run(slot,signal).finally(()=>signal?.removeEventListener('abort',abort));
  slot.task=task;return task;
 }
 async #run(slot:Operation,signal?:AbortSignal):Promise<unknown>{
  try{
   if(slot.cancelled){this.releaseLocal(slot);signal?.throwIfAborted();throw failure(this.#service);}
   if(!this.#admitting||this.#quarantined||this.#closed){this.releaseLocal(slot);throw new LocalClosedError();}
   let payload:ServicePayload|null=slot.captureLocalInput!;
   // freezeSubmit aliases the already frozen validated original graph. There is
   // exactly one outbound graph, retained only through its accepted response.
   slot.freezeSubmit=payload;slot.id=++this.#operation;slot.posted=true;
   const accepted=this.#rpc({kind:'submit',operationId:slot.id,slot:slot.slot,payload},slot);
   slot.makePassivePayload=null;payload=null;
   await accepted;slot.accepted=true;slot.freezeSubmit=null;
   const deadline=performance.now()+SERVICE_LIMITS.phaseMs;
   let posts=0;
   while(true){
    if(this.#quarantined)throw failure(this.#service);
    if(slot.cancelled&&!slot.cancelSent){slot.cancelSent=true;await this.#rpc({kind:'cancel',operationId:slot.id,slot:slot.slot},slot);}
    if(performance.now()>=deadline||posts>=SERVICE_LIMITS.maxStatusPosts){this.#quarantine();throw failure(this.#service);}
    const next=performance.now()+SERVICE_LIMITS.statusPeriodMs;
    do{await new Promise<void>(resolve=>setTimeout(resolve,Math.max(1,Math.ceil(next-performance.now()))));}while(performance.now()<next);
    if(performance.now()>=deadline){this.#quarantine();throw failure(this.#service);}
    posts++;
    let onTerminal:ServiceReplyBody|null=await this.#rpc({kind:'status',operationId:slot.id,slot:slot.slot},slot);
    if(onTerminal.kind==='pending')continue;
    if(onTerminal.kind!=='terminal'){this.#quarantine();throw failure(this.#service);}
    const failed=onTerminal.result.kind==='failed';
    let captureResult:unknown=null;
    if(onTerminal.result.kind==='ok'){
     try{captureResult=captureServiceResult(this.#service,slot.captureLocalInput!,onTerminal.result.value);}catch{this.#quarantine();throw failure(this.#service);}
    }
    onTerminal=null;
    await this.#rpc({kind:'ack-terminal',operationId:slot.id,slot:slot.slot},slot);
    this.#lastRetired[slot.slot]=slot.id;slot.retired=true;
    slot.captureLocalInput=null;slot.freezeSubmit=null;slot.makePassivePayload=null;this.#slots[slot.slot]=null;
    if(failed||slot.cancelled)throw failure(this.#service);
    return captureResult;
   }
  }catch(error){
   if(slot.posted&&!slot.retired)this.#quarantine();
   throw slot.posted?failure(this.#service):error;
  }
 }
 close():Promise<void>{
  if(this.#close!==null)return this.#close;
  this.#admitting=false;
  this.#close=(async()=>{
   if(this.#quarantined)throw failure(this.#service);
   await this.ready();
   await this.#rpc({kind:'stop-new-work'});
   // Capture-only debt must have been released by ResponseAttempt.finally.
   // close never fabricates a not_sent completion for abandoned receipts.
   for(const slot of this.#slots)if(slot!==null&&slot.task===null){this.#quarantine();throw failure(this.#service);}
   const tasks=this.#slots.flatMap(slot=>slot?.task?[slot.task]:[]);
   await Promise.allSettled(tasks);
   if(this.#quarantined||this.#slots.some(slot=>slot!==null))throw failure(this.#service);
   await this.#rpc({kind:'close-idle'});this.#closed=true;
   this.#port.off('message',this.#onMessage);this.#port.off('messageerror',this.#onFault);this.#port.off('close',this.#onFault);this.#port.close();
  })();return this.#close;
 }
}

/** Fixed worker-only wiring. No main native owner, path, SQL, lane, executable,
 * callback, or raw MessagePort is exposed by the returned service interfaces. */
export function createPersistentResidentServicesClient(runtimeId:string,endpoints:readonly ServiceEndpointDescriptor[]){
 if(isMainThread)throw new TypeError('Resident native services require the original worker');
 if(typeof runtimeId!=='string'||runtimeId===''||runtimeId.includes('\0')||Buffer.byteLength(runtimeId)>4096||runtimeId.length>4096||/[\uD800-\uDFFF]/u.test(runtimeId))throw new TypeError('Invalid resident service runtime');
 // Reserve the entire fixed ledger for the endpoint lifetime, including vacant slots.
 const reservation=checkedServiceReservation();void reservation;
 const families:readonly ServiceFamily[]=['dead','idle','verify','gap','response'];
 if(!Array.isArray(endpoints)||types.isProxy(endpoints)||endpoints.length!==families.length||Object.getPrototypeOf(endpoints)!==Array.prototype||Reflect.ownKeys(endpoints).length!==endpoints.length+1)throw new TypeError('Expected five original service endpoints');
 const records=new Map<ServiceFamily,ServiceEndpointDescriptor>();
 const ports=new Set<MessagePort>();
 const brandPort=MessagePort.prototype.hasRef;
 for(let i=0;i<endpoints.length;i++){
  const descriptor=own(endpoints,String(i)) as ServiceEndpointDescriptor;
  const service=own(descriptor,'service') as ServiceFamily,epoch=own(descriptor,'epoch'),port=own(descriptor,'port');
  if((Object.getPrototypeOf(descriptor)!==Object.prototype&&Object.getPrototypeOf(descriptor)!==null)||Reflect.ownKeys(descriptor).length!==3||!families.includes(service)||records.has(service)||typeof epoch!=='string'||! /^[0-9a-f]{32}$/.test(epoch)||!(port instanceof MessagePort)||types.isProxy(port)||ports.has(port))throw new TypeError('Invalid original service endpoint');
  if(typeof brandPort.call(port)!=='boolean')throw new TypeError('Invalid original service endpoint');
  records.set(service,{service,epoch,port});ports.add(port);
 }
 const dead=new Endpoint(runtimeId,records.get('dead')!),idle=new Endpoint(runtimeId,records.get('idle')!),verify=new Endpoint(runtimeId,records.get('verify')!),gap=new Endpoint(runtimeId,records.get('gap')!),response=new Endpoint(runtimeId,records.get('response')!);
 let activation=false;
 const receipts=new WeakMap<object,{slot:Operation;used:boolean;released:boolean}>();
 const responseService=Object.freeze({
  captureResponse(claim:DurableResponseClaim):object{
   // Use the actual branded occurrence, never a structured-cloned occurrence.
   const slot=response.reserveInput({op:'response-finish'});
   try{
    preflightResponse(runtimeId,claim);
    let makePassivePayload:unknown={op:'response-finish',scope:responseCustodyScope(runtimeId,claim),authority:own(claim,'authority'),payload:own(claim,'payload'),outcome:'not_sent'};
    response.captureReserved(slot,makePassivePayload);makePassivePayload=null;
   }catch(error){response.releaseLocal(slot);throw error;}
   // Passive conversion is no longer needed after the original capture; future
   // outbound ownership aliases that immutable original.
   slot.makePassivePayload=null;
   const receipt=Object.freeze({});receipts.set(receipt,{slot,used:false,released:false});return receipt;
  },
  async finishResponse(receipt:object,outcome:DurableResponseCompletion['outcome'],signal?:AbortSignal):Promise<void>{
   const data=receipts.get(receipt);
   try{
    if(!data||data.used||data.released)throw new LocalInputError();data.used=true;
    if(outcome!=='flushed'&&outcome!=='not_sent')throw new LocalInputError();signalValid(signal);
    let original=data.slot.captureLocalInput;
    if(original===null||original.op!=='response-finish')throw new LocalInputError();
    // Replace one shallow root; nested owned graphs remain aliased. No extra
    // retained payload is introduced by selecting the observed wire outcome.
    data.slot.captureLocalInput=Object.freeze({...original,outcome});original=null;
    await response.finish(data.slot,signal);
   }catch{throw failure('response');}
  },
  releaseResponse(receipt:object):void{
   const data=receipts.get(receipt);if(!data)throw new LocalInputError();if(data.released)return;
   data.released=true;response.releaseLocal(data.slot);
  },
  close:()=>response.close(),
 });
 return Object.freeze({
  quarantine:()=>{dead.quarantine();idle.quarantine();verify.quarantine();gap.quarantine();response.quarantine();},
  ready:async()=>{await Promise.all([dead.ready(),idle.ready(),verify.ready(),gap.ready(),response.ready()]);},
  activateCustody:async(signal?:AbortSignal)=>{if(activation)throw new LocalInputError();activation=true;await dead.call({op:'activate-custody'},signal);},
  dead:Object.freeze({capture:async(instanceId:string,work:DeadGenerationWork,signal?:AbortSignal)=>{signalValid(signal);signal?.throwIfAborted();const slot=dead.reserveInput({op:'capture-dead'});try{preflightDead(instanceId,work);let makePassivePayload:unknown={op:'capture-dead',instanceId,work:encodeDeadGenerationTransfer(work)};dead.captureReserved(slot,makePassivePayload);makePassivePayload=null;}catch(error){dead.releaseLocal(slot);throw error;}await dead.finish(slot,signal);},close:()=>dead.close()}),
  idle:Object.freeze({
   validateInstallation:async(signal?:AbortSignal)=>{await idle.call({op:'idle-install'},signal);},
   before:async(ownerId:string,generation:bigint,threadId:string)=>await idle.call({op:'idle-before',ownerId,generation,threadId}) as IdleReleaseToken|null,
   transition:async(token:IdleReleaseToken,state:string,detail:string)=>{const slot=idle.reserveInput({op:'idle-transition',state});try{validateServicePayload('idle',{op:'idle-transition',token,state,detail});let makePassivePayload:unknown={op:'idle-transition',token:cloneIdleReleaseToken(token),state,detail};idle.captureReserved(slot,makePassivePayload);makePassivePayload=null;}catch(error){idle.releaseLocal(slot);throw error;}return await idle.finish(slot) as IdleReleaseToken;},
   settleExitedOwner:async(ownerId:string,generation:bigint)=>{await idle.call({op:'idle-exit',ownerId,generation});},close:()=>idle.close(),
  }),
  response:responseService,
  observation:Object.freeze({
   activate:async(scope:{ownerId:string;generation:bigint},signal?:AbortSignal)=>{await verify.call({op:'observation-activate',scope},signal);},
   verified:async(ownerId:string,generation:bigint,through:bigint)=>await verify.call({op:'observation-verified',scope:{ownerId,generation},through}) as boolean,
   discoverGap:async(ownerId:string,generation:bigint,upper:bigint)=>{await gap.call({op:'gap-discover',scope:{ownerId,generation},upper});},
   recordGap:async(ownerId:string,generation:bigint)=>{await gap.call({op:'gap-unknown',scope:{ownerId,generation}});},close:()=>verify.close(),
  }),
  gaps:Object.freeze({close:()=>gap.close()}),
 });
}
