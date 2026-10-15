import {types} from 'node:util';
import {randomUUID} from 'node:crypto';
import {captureNewInput} from '../../store/ingress-new-input.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {StateAccessFacade,type IStateAccessFacade} from '../../store/state-access-facade.ts';
import {captureIngressAdmission} from '../../store/ingress-admission.ts';
import {captureIngressExecution,captureIngressResult} from '../../store/ingress-lifecycle.ts';
import type {NewIngress} from '../../store/ingress-types.ts';
import {newIngressToWire,storedIngressFromWire} from '../prompt-intake/native-journal-wire.ts';
import {intakeNumberWire} from '../prompt-intake/native-wire.ts';
import {OwnedWorkerSlot} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
export type MessageJournalEffects=Pick<IStateAccessFacade,'recordIngressResult'|'holdIngress'>;
export function captureMessageJournalEffects(path:string,input:MessageJournalEffects=StateAccessFacade):MessageJournalEffects{
 requireDiscordText(path);const result={} as MessageJournalEffects;
 for(const key of ['recordIngressResult','holdIngress'] as const){const fn=own(input,key);if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected passive message journal persistence');Object.defineProperty(result,key,{enumerable:true,value:(given:string,...args:unknown[])=>{if(given!==path)throw new TypeError('Message persistence belongs to another database');const pending=Reflect.apply(fn,undefined,[given,...args]);if(!types.isPromise(pending))throw new TypeError('Expected message persistence Promise');return pending;}});}
 return Object.freeze(result);
}
export type MessageJournal=Pick<IStateAccessFacade,'admitIngress'|'recordIngressProcessingMode'|'beginIngressExecution'|'recordNewInput'|'recordIngressResult'|'confirmIngress'|'holdIngress'>;
type Operation='Admit'|'Mode'|'Begin'|'NewInput'|'Result'|'Confirm'|'Hold';
type NativeProfile={path:string;completion:(id:string)=>MessageJournal};
const profiles=new WeakMap<object,NativeProfile>();
const capturedPorts=new WeakMap<object,{path:string;origin:object}>();
const LIMIT=16*1024*1024;
export class NativeMessageJournalUnavailableError extends Error{
 readonly operation:Operation;
 constructor(operation:Operation,cause:unknown){super('Message journal outcome unavailable after native join; no automatic response or replay',{cause});this.name='NativeMessageJournalUnavailableError';this.operation=operation;}
}
/** Own-data functions and original database are captured before any caller await.
 * This port has no ambient fallback after capture and grants no resident response authority. */
export function captureMessageJournal(path:string,input:MessageJournal=StateAccessFacade):MessageJournal{
 requireDiscordText(path);const prior=capturedPorts.get(input);if(prior!==undefined&&prior.path!==path)throw new TypeError('Message journal belongs to another database');const result={} as MessageJournal;
 for(const key of ['admitIngress','recordIngressProcessingMode','beginIngressExecution','recordNewInput','recordIngressResult','confirmIngress','holdIngress'] as const){
  const fn=own(input,key);if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected passive message journal function');
  Object.defineProperty(result,key,{enumerable:true,value:(given:string,...args:unknown[])=>{if(given!==path)throw new TypeError('Message journal belongs to another database');const pending=Reflect.apply(fn,undefined,[given,...args]);if(!types.isPromise(pending))throw new TypeError('Expected message journal Promise');return pending;}});
 }
 const profile=profiles.get(input);if(profile!==undefined){if(profile.path!==path)throw new TypeError('Native journal belongs to another database');profiles.set(result,profile);}
 capturedPorts.set(result,{path,origin:prior?.origin??input});return Object.freeze(result);
}
/** Installed processors require the same captured admission port, never a silent compatibility substitute. */
export function requireMessageJournalBinding(path:string,expected:MessageJournal,actual:MessageJournal):void{
 const a=capturedPorts.get(expected),b=capturedPorts.get(actual);if(a===undefined||b===undefined||a.path!==path||b.path!==path||a.origin!==b.origin)throw new TypeError('Message custody journal differs from processor installation');
}
export function captureMessageJournalContext(path:string,input:unknown):MessageJournal|undefined{
 if(input===null||typeof input!=='object'||types.isProxy(input))throw new TypeError('Expected message journal context');
 const field=Object.getOwnPropertyDescriptor(input,'messageJournal');if(field===undefined)return undefined;
 if(!Object.hasOwn(field,'value'))throw new TypeError('Expected message journal data');
 return field.value===undefined?undefined:captureMessageJournal(path,field.value as MessageJournal);
}
const original=Symbol('OriginalMessageJournal');
/** Minted only after a confirmed created admission. The private captured port
 * binds completion FIFO access to this original path/key, never to ambient work. */
export class OriginalMessageJournal {
 readonly #path:string;readonly #key:string;readonly #port:MessageJournal;readonly #source:MessageJournal;
 constructor(token:symbol,path:string,key:string,port:MessageJournal,source:MessageJournal=port){if(token!==original)throw new TypeError('Expected original message admission');this.#path=path;this.#key=key;this.#port=port;this.#source=source;Object.freeze(this);}
 require(path:string,key:string,port?:MessageJournal):void{if(path!==this.#path||key!==this.#key)throw new TypeError('Journal custody differs from original admission');if(port!==undefined)requireMessageJournalBinding(path,port,this.#source);}
 mode(mode:string):Promise<void>{requireDiscordText(mode);return this.#port.recordIngressProcessingMode(this.#path,this.#key,mode);}
 begin(target:string|null,now:number):Promise<boolean>{return this.#port.beginIngressExecution(this.#path,this.#key,'processing',target,now);}
 newInput(raw:string,prompt:string,now:number):Promise<void>{const q=captureNewInput(this.#key,raw,prompt,now);return this.#port.recordNewInput(this.#path,q.key,q.raw,q.prompt,q.now);}
 result(input:unknown,now:number):Promise<void>{const q=captureIngressResult(this.#key,input,now);return this.#port.recordIngressResult(this.#path,q.key,q.outcome,q.now);}
 confirm(now:number):Promise<void>{return this.#port.confirmIngress(this.#path,this.#key,now);}
 hold(reason:string,notExecuted:boolean,now:number):Promise<void>{return this.#port.holdIngress(this.#path,this.#key,reason,notExecuted,now);}
}
Object.freeze(OriginalMessageJournal.prototype);
export async function admitOriginalMessageJournal(path:string,input:NewIngress,port:MessageJournal){
 const captured=captureMessageJournal(path,port),request=captureIngressAdmission(input);
 if(request.kind!=='message'||request.ingressId!==`message:${request.eventId}`||request.sourceMessageId!==request.eventId)throw new TypeError('Expected original message journal identity');
 const admission=await captured.admitIngress(path,request);
 const completion=admission.created?(profiles.get(captured)?.completion(request.ingressId)??captured):null;
 return {admission,owner:completion===null?null:new OriginalMessageJournal(original,path,request.ingressId,completion,captured)};
}
/** Existing-only native lifecycle. Public calls and fresh Begin/Mode/Admit/NewInput use
 * zero-queue Control admission. Only the private original custody's Result,
 * Confirm and Hold use the finite completion FIFO. No cancellation signal can
 * discard persistence after an accepted response or HTTP receipt. */
export function createNativeMessageJournal(path:string,timeoutMs=5000):MessageJournal{
 requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid message store path');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid message journal deadline');const fixed=pinNativeRuntimePath(path);
 const identity=(value:string)=>{requireDiscordText(value);if(Buffer.byteLength(value)>65536)throw new RangeError('Message journal identity exceeds boundary');};
 async function run<T>(operation:Operation,id:string,fields:object,decode:(value:unknown)=>T,completion:boolean,binding?:{origin:string;owner:string|null}):Promise<T>{
  identity(id);const requestId=binding===undefined?undefined:randomUUID(),data={path:fixed,operation,id,...fields,...(binding===undefined?{}:{...binding,requestId})};if(boundedSerdeByteCount(data,LIMIT)===null)throw new RangeError('Message journal input exceeds boundary');
  const slot=new OwnedWorkerSlot('Control');let admitted=false,raw:unknown;
  try{const url=new URL('./native-journal-worker.ts',import.meta.url),pending=completion?slot.runControlCompletion(url,data,timeoutMs):slot.run(url,data,timeoutMs);admitted=slot.busy;try{raw=await pending;}finally{await slot.join();}}
  catch(error){if(admitted)throw new NativeMessageJournalUnavailableError(operation,error);throw error;}
  try{if(boundedSerdeByteCount(raw,LIMIT)===null||own(raw,'ok')!==true||own(raw,'operation')!==operation||own(raw,'path')!==fixed||own(raw,'id')!==id)throw new TypeError('No exact message journal acknowledgement');if(binding!==undefined&&(own(raw,'origin')!==binding.origin||own(raw,'owner')!==binding.owner||own(raw,'requestId')!==requestId))throw new TypeError('No original message preparation acknowledgement');return decode(own(raw,'value'));}
  catch(error){throw new NativeMessageJournalUnavailableError(operation,error);}
 }
 const done=(value:unknown):void=>{if(value!==true)throw new TypeError('Expected complete journal mutation acknowledgement');};
 function port(owned:string|null):MessageJournal{
  const origin=randomUUID();
  const check=(given:string,key:string)=>{if(given!==path||owned!==null&&key!==owned)throw new TypeError('Journal differs from original installation/custody');identity(key);};
  return Object.freeze({
   async admitIngress(given:string,input:NewIngress){
    const q=captureIngressAdmission(input);check(given,q.ingressId);if(owned!==null||q.kind!=='message')throw new TypeError('Expected fresh message admission');
    return run('Admit',q.ingressId,{envelope:newIngressToWire(q)},raw=>{
     const created=own(raw,'created');if(typeof created!=='boolean'||own(raw,'canonicalRepeatCreated')!==false||own(raw,'busyChoice')!==null)throw new TypeError('Invalid message admission acknowledgement');
     const value=own(raw,'record');if(value===null){if(created)throw new TypeError('Created admission has no record');return {created,canonicalRepeatCreated:false,record:null,busyChoice:null};}
     const record=storedIngressFromWire(value);if(record.kind!==q.kind||record.eventId!==q.eventId||record.applicationId!==q.applicationId||record.channelId!==q.channelId||record.ownerUserId!==q.ownerUserId||record.sourceMessageId!==q.sourceMessageId||created&&record.ingressId!==q.ingressId)throw new TypeError('Message admission identity differs');
     return {created,canonicalRepeatCreated:false,record,busyChoice:null};
    },false);
   },
   async recordIngressProcessingMode(given:string,key:string,mode:string){check(given,key);requireDiscordText(mode);return run('Mode',key,{mode},done,false);},
   async beginIngressExecution(given:string,key:string,phase:string,target:string|null,now:number){check(given,key);const q=captureIngressExecution(key,phase,target,now);return run('Begin',key,{phase:q.phase,target:q.target,now:intakeNumberWire(q.now)},raw=>{if(typeof raw!=='boolean')throw new TypeError('Expected exact begin result');return raw;},false);},
   async recordNewInput(given:string,key:string,raw:string,prompt:string,now:number){check(given,key);const q=captureNewInput(key,raw,prompt,now);return run('NewInput',key,{raw:q.raw,prompt:q.prompt,now:intakeNumberWire(q.now)},done,false,{origin,owner:owned});},
   async recordIngressResult(given:string,key:string,input:unknown,now:number){check(given,key);const q=captureIngressResult(key,input,now);return run('Result',key,{outcome:serializeSerdeValue(q.outcome),now:intakeNumberWire(q.now)},done,owned!==null);},
   async confirmIngress(given:string,key:string,now:number){check(given,key);if(typeof now!=='number')throw new TypeError('Expected journal timestamp');return run('Confirm',key,{now:intakeNumberWire(now)},done,owned!==null);},
   async holdIngress(given:string,key:string,reason:string,notExecuted:boolean,now:number){check(given,key);requireDiscordText(reason);if(typeof now!=='number'||typeof notExecuted!=='boolean')throw new TypeError('Expected hold fields');return run('Hold',key,{reason,notExecuted,now:intakeNumberWire(now)},done,owned!==null);},
  });
 }
 const result=port(null);profiles.set(result,{path,completion:key=>port(key)});return result;
}
