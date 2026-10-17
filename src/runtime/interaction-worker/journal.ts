import {realpath} from 'node:fs/promises';
import {StoreIntegrityError} from '../../store/schema-assembly.ts';
import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {captureIngressAdmission,captureMappedSlashIngress,type IngressAdmission} from '../../store/ingress-admission.ts';
import {captureBusyInteraction} from '../../store/ingress-busy.ts';
import {captureIngressExecution,captureIngressResult} from '../../store/ingress-lifecycle.ts';
import type {AbandonmentDecisionRouteInput} from '../../store/abandonment-routing.ts';
import type {NewIngress} from '../../store/ingress-types.ts';
import type {StoredIngress} from '../../store/ingress-read.ts';
import {snapshotBusyChoice,BusyChoiceUnavailableError,type BusyChoice} from '../../store/busy-choice.ts';
import {newIngressToWire,storedIngressFromWire} from '../prompt-intake/native-journal-wire.ts';
import {intakeNumberWire,intakeNumberFromWire} from '../prompt-intake/native-wire.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
export interface InteractionJournalIdentity {readonly ingressId:string;readonly eventId:bigint;readonly applicationId:bigint;readonly channelId:bigint;readonly ownerUserId:bigint;readonly sourceMessageId:bigint|null}
export function captureInteractionJournalIdentity(input:unknown):InteractionJournalIdentity{
 const ingressId=own(input,'ingressId');requireDiscordText(ingressId);
 const integer=(value:unknown,zero=false):bigint=>{if(typeof value!=='bigint'||value<(zero?0n:1n)||value>=1n<<63n)throw new TypeError('Expected original interaction journal identity');return value;};
 const eventId=integer(own(input,'eventId')),applicationId=integer(own(input,'applicationId'),true),channelId=integer(own(input,'channelId')),ownerUserId=integer(own(input,'ownerUserId')),message=own(input,'sourceMessageId');
 if(ingressId!==`interaction:${eventId}`)throw new TypeError('Interaction ingress differs from original event');
 return Object.freeze({ingressId,eventId,applicationId,channelId,ownerUserId,sourceMessageId:message===null?null:integer(message,true)});
}
export type InteractionAdmissionRoute={readonly kind:'Ordinary'}|{readonly kind:'Mapped'}|{readonly kind:'Busy';readonly choiceId:string;readonly action:string};
function captureRoute(input:InteractionAdmissionRoute):InteractionAdmissionRoute{
 const kind=own(input,'kind');if(kind==='Ordinary'||kind==='Mapped')return Object.freeze({kind});
 if(kind!=='Busy')throw new TypeError('Expected interaction admission route');const choiceId=own(input,'choiceId'),action=own(input,'action');requireDiscordText(choiceId);requireDiscordText(action);return Object.freeze({kind,choiceId,action});
}
function captureRouting<T>(input:unknown,fields:readonly string[]):T{
 const result:Record<string,unknown>={};for(const field of fields)result[field]=own(input,field);return Object.freeze(result) as T;
}
export interface PublicationRoutingInput {readonly interaction_id:bigint;readonly proposal_id:string;readonly revision:bigint;readonly application_id:bigint;readonly channel_id:bigint;readonly owner_user_id:bigint;readonly source_message_id:bigint}
export interface InteractionJournal {
 admit(path:string,input:NewIngress,route:InteractionAdmissionRoute):Promise<IngressAdmission>;
 abandonment(path:string,input:AbandonmentDecisionRouteInput):Promise<string>;
 publication(path:string,input:PublicationRoutingInput):Promise<string>;
 read(path:string,key:string,identity:InteractionJournalIdentity|null):Promise<StoredIngress|null>;
 acknowledge(path:string,key:string,identity:InteractionJournalIdentity|null,now:number):Promise<boolean>;
 begin(path:string,key:string,identity:InteractionJournalIdentity|null,mode:'Execute'|'ConfirmationOnly',now:number):Promise<boolean>;
 result(path:string,key:string,identity:InteractionJournalIdentity|null,outcome:unknown,now:number):Promise<void>;
 confirm(path:string,key:string,identity:InteractionJournalIdentity|null,now:number):Promise<void>;
 hold(path:string,key:string,identity:InteractionJournalIdentity|null,reason:string,notExecuted:boolean,now:number):Promise<void>;
}
// Compatibility port captures original methods once; installed owners supply the
// native port explicitly and never fall back to these synchronous SQLite paths.
const admit=state.admitIngress,mapped=state.admitMappedSlashIngress,busy=state.admitBusyInteraction,abandonment=state.authorizeAbandonmentDecision,publication=state.deliveredPublicationProposal;
const read=state.getIngress,ack=state.acknowledgeIngress,begin=state.beginIngressExecution,confirmation=state.beginIngressConfirmation,result=state.recordIngressResult,confirm=state.confirmIngress,hold=state.holdIngress;
const compatibility:InteractionJournal=Object.freeze<InteractionJournal>({
 admit:async(path,input,route)=>route.kind==='Busy'?busy(path,input,route.choiceId,route.action):route.kind==='Mapped'?mapped(path,input):admit(path,input),
 abandonment:async(path,input)=>abandonment(path,input).proposal.thread_id,
 publication:async(path,input)=>{const bound=publication(path,input.proposal_id,input.revision);bound.requireActor(input.application_id,input.channel_id,input.owner_user_id,input.source_message_id);return bound.proposal.thread_id;},
 read:async(path,key)=>read(path,key),acknowledge:async(path,key,_id,now)=>ack(path,key,now),
 begin:async(path,key,_id,mode,now)=>mode==='Execute'?begin(path,key,'processing',null,now):confirmation(path,key,now),
 result:async(path,key,_id,outcome,now)=>result(path,key,outcome,now),confirm:async(path,key,_id,now)=>confirm(path,key,now),hold:async(path,key,_id,reason,notExecuted,now)=>hold(path,key,reason,notExecuted,now),
});
const methods=['admit','abandonment','publication','read','acknowledge','begin','result','confirm','hold'] as const;
type Profile={path:string;owned:(identity:InteractionJournalIdentity,kind:'staged'|'execution')=>InteractionJournal;atCanonical:(canonical:string)=>InteractionJournal};
const profiles=new WeakMap<object,Profile>(),captured=new WeakMap<object,{path:string;origin:object}>();
export function captureInteractionJournal(path:string,input:InteractionJournal=compatibility):InteractionJournal{
 requireDiscordText(path);const prior=captured.get(input);if(prior!==undefined&&prior.path!==path)throw new TypeError('Interaction journal belongs to another database');
 const port={} as InteractionJournal;
 for(const key of methods){const fn=own(input,key);if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected passive interaction journal function');Object.defineProperty(port,key,{enumerable:true,value:(given:string,...args:unknown[])=>{if(given!==path)throw new TypeError('Interaction journal belongs to another database');const pending=Reflect.apply(fn,undefined,[given,...args]);if(!types.isPromise(pending))throw new TypeError('Expected interaction journal Promise');return pending;}});}
 const profile=profiles.get(input);if(profile!==undefined){if(profile.path!==path)throw new TypeError('Interaction journal belongs to another database');profiles.set(port,profile);}
 captured.set(port,{path,origin:prior?.origin??input});return Object.freeze(port);
}
export function captureInteractionJournalContext(path:string,input:unknown):InteractionJournal{
 if(input===null||typeof input!=='object'||types.isProxy(input))throw new TypeError('Expected interaction journal context');const field=Object.getOwnPropertyDescriptor(input,'interactionJournal');if(field!==undefined&&!Object.hasOwn(field,'value'))throw new TypeError('Expected interaction journal data');return captureInteractionJournal(path,field?.value as InteractionJournal|undefined);
}
/** Called only after execution's two original realpath checks. Preserve the
 * captured installation origin, but native IO uses the validated canonical file. */
function canonicalInteractionExecutionJournal(path:string,canonical:string,source:InteractionJournal):InteractionJournal{
 requireDiscordText(canonical);const input=captureInteractionJournal(path,source),binding=captured.get(input)!,profile=profiles.get(input);let port:InteractionJournal;
 if(profile!==undefined)port=profile.atCanonical(canonical);
 else if(binding.origin===compatibility){
  port={} as InteractionJournal;for(const key of methods)Object.defineProperty(port,key,{enumerable:true,value:(_given:string,...args:unknown[])=>Reflect.apply(compatibility[key],undefined,[canonical,...args])});Object.freeze(port);
 }else return input;
 const result=captureInteractionJournal(path,port);captured.set(result,{path,origin:binding.origin});return result;
}
const original=Symbol('OriginalInteractionJournal');
/** Interaction-only completion privilege, minted after a confirmed original
 * admission or begin. Never accepted from message custody or a cloned receipt. */
export class OriginalInteractionJournal {
 readonly #path:string;readonly #id:InteractionJournalIdentity|null;readonly #key:string;readonly #port:InteractionJournal;readonly #source:InteractionJournal;
 constructor(token:symbol,path:string,key:string,id:InteractionJournalIdentity|null,source:InteractionJournal,kind:'staged'|'execution'){
  if(token!==original)throw new TypeError('Expected original interaction journal');this.#path=path;this.#key=key;this.#id=id;this.#source=source;
  this.#port=id===null?source:profiles.get(source)?.owned(id,kind)??source;Object.freeze(this);
 }
 require(path:string,key:string,source:InteractionJournal):void{const a=captured.get(this.#source),b=captured.get(source);if(path!==this.#path||key!==this.#key||a===undefined||b===undefined||a.origin!==b.origin||a.path!==b.path)throw new TypeError('Journal differs from original interaction custody');}
 acknowledge(now:number):Promise<boolean>{return this.#port.acknowledge(this.#path,this.#key,this.#id,now);}
 read():Promise<StoredIngress|null>{return this.#source.read(this.#path,this.#key,this.#id);}
 result(outcome:unknown,now:number):Promise<void>{const q=captureIngressResult(this.#key,outcome,now);return this.#port.result(this.#path,q.key,this.#id,q.outcome,q.now);}
 confirm(now:number):Promise<void>{return this.#port.confirm(this.#path,this.#key,this.#id,now);}
 hold(reason:string,notExecuted:boolean,now:number):Promise<void>{return this.#port.hold(this.#path,this.#key,this.#id,reason,notExecuted,now);}
}
Object.freeze(OriginalInteractionJournal.prototype);
export async function admitOriginalInteractionJournal(path:string,input:NewIngress,route:InteractionAdmissionRoute,journal:InteractionJournal){
 const port=captureInteractionJournal(path,journal),q=captureIngressAdmission(input),id=captureInteractionJournalIdentity(q);if(q.kind!=='interaction')throw new TypeError('Expected interaction admission');
 const admission=await port.admit(path,q,captureRoute(route));return {admission,owner:admission.created?new OriginalInteractionJournal(original,path,q.ingressId,id,port,'staged'):null};
}
export async function beginOriginalInteractionJournal(path:string,custodyPath:string,key:string,identity:InteractionJournalIdentity|null,mode:'Execute'|'ConfirmationOnly',timestamp:()=>number,journal:InteractionJournal){
 const source=captureInteractionJournal(path,journal),id=identity===null?null:captureInteractionJournalIdentity(identity);if(id!==null&&id.ingressId!==key)throw new TypeError('Interaction begin identity differs');
 if(typeof timestamp!=='function'||types.isProxy(timestamp)||types.isAsyncFunction(timestamp)||types.isGeneratorFunction(timestamp))throw new TypeError('Expected synchronous execution timestamp');
 // Both original paths are canonicalized in order. Only this local result may
 // rebind the captured native profile; callers cannot supply a replacement file.
 const database=await realpath(path),other=await realpath(custodyPath);if(database!==other)throw new StoreIntegrityError('interaction custody belongs to a different worker database');
 const now=timestamp();if(types.isPromise(now))void Promise.prototype.then.call(now,undefined,()=>undefined);if(typeof now!=='number'||!Number.isFinite(now)||now<0)throw new TypeError('Expected nonnegative finite custody timestamp');
 const port=canonicalInteractionExecutionJournal(path,database,source),began=await port.begin(path,key,id,mode,now);
 return {database,owner:began?new OriginalInteractionJournal(original,path,key,id,port,'execution'):null};
}

type Operation='Admit'|'Mapped'|'Busy'|'Abandonment'|'Publication'|'Read'|'Acknowledge'|'Begin'|'BeginConfirmation'|'Result'|'Confirm'|'Hold';
const LIMIT=16*1024*1024;
const capacityRefusals=new WeakSet<object>();
/** Only this native owner can identify a refusal before worker submission. */
class NativeInteractionJournalCapacityError extends OwnedWorkerBudgetError{
 constructor(){super();this.name='NativeInteractionJournalCapacityError';capacityRefusals.add(this);}
}
export function isInteractionJournalCapacityRefusal(error:unknown):boolean{return error!==null&&typeof error==='object'&&capacityRefusals.has(error);}
export class NativeInteractionJournalUnavailableError extends Error{
 readonly operation:Operation;constructor(operation:Operation,cause:unknown){super('Interaction journal outcome unavailable after native join; no automatic response or replay',{cause});this.name='NativeInteractionJournalUnavailableError';this.operation=operation;}
}
/** Fresh admission/read/begin never queue. Only private staged/execution owners
 * use the bounded Control completion FIFO for required ACK/result/confirm/hold. */
export function createNativeInteractionJournal(path:string,timeoutMs=5000):InteractionJournal{
 requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid interaction store path');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid interaction journal deadline');
 const fixed=pinNativeRuntimePath(path);
 function port(owned:InteractionJournalIdentity|null,kind:'fresh'|'staged'|'execution',nativePath=fixed):InteractionJournal{
  const origin=randomUUID();
  const check=(given:string,key:string,id:InteractionJournalIdentity|null)=>{if(given!==path)throw new TypeError('Interaction journal belongs to another database');const identity=captureInteractionJournalIdentity(id);if(identity.ingressId!==key||owned!==null&&!sameIdentity(owned,identity))throw new TypeError('Journal differs from original interaction custody');return identity;};
  async function run<T>(operation:Operation,id:InteractionJournalIdentity,fields:object,decode:(raw:unknown)=>T,complete=false):Promise<T>{
   const requestId=randomUUID(),data={path:nativePath,operation,identity:id,origin,ownerKind:kind,requestId,...fields};if(boundedSerdeByteCount(data,LIMIT)===null)throw new RangeError('Interaction journal input exceeds boundary');
   const slot=new OwnedWorkerSlot('Control');let admitted=false,raw:unknown;
   try{const url=new URL('./native-journal-worker.ts',import.meta.url),pending=complete?slot.runControlCompletion(url,data,timeoutMs):slot.run(url,data,timeoutMs);admitted=slot.busy;try{raw=await pending;}finally{await slot.join();}}
   catch(error){if(admitted)throw new NativeInteractionJournalUnavailableError(operation,error);if(error instanceof OwnedWorkerBudgetError)throw new NativeInteractionJournalCapacityError();throw error;}
   try{
    if(boundedSerdeByteCount(raw,LIMIT)===null||own(raw,'path')!==nativePath||own(raw,'operation')!==operation||own(raw,'origin')!==origin||own(raw,'ownerKind')!==kind||own(raw,'requestId')!==requestId||!sameIdentity(id,captureInteractionJournalIdentity(own(raw,'identity'))))throw new TypeError('No exact interaction journal acknowledgement');
    if(own(raw,'ok')!==true){if(operation==='Busy'&&own(raw,'unavailableChoice')===own(fields,'choiceId'))throw new BusyChoiceUnavailableError(own(fields,'choiceId') as string);throw new TypeError('Unconfirmed interaction journal result');}
    return decode(own(raw,'value'));
   }catch(error){if(error instanceof BusyChoiceUnavailableError)throw error;throw new NativeInteractionJournalUnavailableError(operation,error);}
  }
  const done=(raw:unknown):void=>{if(raw!==true)throw new TypeError('Expected complete interaction mutation');},boolean=(raw:unknown):boolean=>{if(typeof raw!=='boolean')throw new TypeError('Expected exact interaction transition');return raw;};
  return Object.freeze<InteractionJournal>({
   async admit(given,input,routing){
    const route=captureRoute(routing),q=route.kind==='Mapped'?captureMappedSlashIngress(input):route.kind==='Busy'?captureBusyInteraction(input,route.choiceId,route.action).request:captureIngressAdmission(input),id=check(given,q.ingressId,captureInteractionJournalIdentity(q));if(kind!=='fresh'||q.kind!=='interaction')throw new TypeError('Expected fresh interaction admission');
    const operation=route.kind==='Ordinary'?'Admit':route.kind;
    return run(operation,id,{envelope:newIngressToWire(q),...(route.kind==='Busy'?{choiceId:route.choiceId,action:route.action}:{})},raw=>{
     const created=own(raw,'created'),repeated=own(raw,'canonicalRepeatCreated'),saved=own(raw,'record'),choice=own(raw,'busyChoice');if(typeof created!=='boolean'||typeof repeated!=='boolean'||created&&repeated||route.kind!=='Busy'&&(repeated||choice!==null))throw new TypeError('Invalid interaction admission acknowledgement');
     const record=saved===null?null:storedIngressFromWire(saved);if(record===null||record.kind!=='interaction'||!sameIdentity(id,captureInteractionJournalIdentity(record)))throw new TypeError('Interaction admission identity differs');
     const busyChoice=choice===null?null:snapshotBusyChoice({...choice as BusyChoice,createdAt:intakeNumberFromWire(own(choice,'createdAt')),expiresAt:intakeNumberFromWire(own(choice,'expiresAt'))});
     if(route.kind==='Busy'&&(busyChoice===null||busyChoice.choiceId!==route.choiceId||busyChoice.ownerUserId!==id.ownerUserId||busyChoice.channelId!==id.channelId))throw new TypeError('Busy admission identity differs');
     return {created,canonicalRepeatCreated:repeated,record,busyChoice};
    });
   },
   async abandonment(given,input){const q=captureRouting<AbandonmentDecisionRouteInput>(input,['proposal_id','revision','interaction_id','application_id','channel_id','owner_user_id','source_message_id','decision','now']),id=check(given,`interaction:${q.interaction_id}`,{ingressId:`interaction:${q.interaction_id}`,eventId:q.interaction_id,applicationId:q.application_id,channelId:q.channel_id,ownerUserId:q.owner_user_id,sourceMessageId:q.source_message_id});return run('Abandonment',id,{input:{...q,now:intakeNumberWire(q.now)}},raw=>{requireDiscordText(raw);return raw;});},
   async publication(given,input){const q=captureRouting<PublicationRoutingInput>(input,['proposal_id','revision','interaction_id','application_id','channel_id','owner_user_id','source_message_id']),event=q.interaction_id;const id=check(given,`interaction:${event}`,{ingressId:`interaction:${event}`,eventId:event,applicationId:q.application_id,channelId:q.channel_id,ownerUserId:q.owner_user_id,sourceMessageId:q.source_message_id});return run('Publication',id,{input:q},raw=>{requireDiscordText(raw);return raw;});},
   async read(given,key,id){const identity=check(given,key,id);return run('Read',identity,{},raw=>{if(raw===null)return null;const row=storedIngressFromWire(raw);if(row.kind!=='interaction'||!sameIdentity(identity,captureInteractionJournalIdentity(row)))throw new TypeError('Interaction read identity differs');return row;});},
   async acknowledge(given,key,id,now){const identity=check(given,key,id);return run('Acknowledge',identity,{now:intakeNumberWire(now)},boolean,kind!=='fresh');},
   async begin(given,key,id,mode,now){if(mode!=='Execute'&&mode!=='ConfirmationOnly')throw new TypeError('Expected interaction processing mode');const identity=check(given,key,id);captureIngressExecution(key,'processing',null,now);if(kind!=='fresh')throw new TypeError('Expected fresh interaction begin');return run(mode==='Execute'?'Begin':'BeginConfirmation',identity,{now:intakeNumberWire(now)},boolean);},
   async result(given,key,id,outcome,now){const identity=check(given,key,id),q=captureIngressResult(key,outcome,now);return run('Result',identity,{outcome:serializeSerdeValue(q.outcome),now:intakeNumberWire(q.now)},done,kind==='execution');},
   async confirm(given,key,id,now){const identity=check(given,key,id);return run('Confirm',identity,{now:intakeNumberWire(now)},done,kind==='execution');},
   async hold(given,key,id,reason,notExecuted,now){const identity=check(given,key,id);requireDiscordText(reason);if(typeof notExecuted!=='boolean')throw new TypeError('Expected interaction hold flag');return run('Hold',identity,{reason,notExecuted,now:intakeNumberWire(now)},done,kind!=='fresh');},
  });
 }
 function fresh(nativePath:string):InteractionJournal{const output=port(null,'fresh',nativePath);profiles.set(output,{path,owned:(id,kind)=>port(id,kind,nativePath),atCanonical:canonical=>fresh(pinNativeRuntimePath(canonical))});return output;}
 return fresh(fixed);
}
function sameIdentity(a:InteractionJournalIdentity,b:InteractionJournalIdentity):boolean{return a.ingressId===b.ingressId&&a.eventId===b.eventId&&a.applicationId===b.applicationId&&a.channelId===b.channelId&&a.ownerUserId===b.ownerUserId&&a.sourceMessageId===b.sourceMessageId;}
