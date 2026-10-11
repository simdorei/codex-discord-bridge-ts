import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {validateRequestId,type RequestId} from '../protocol/ids.ts';
import {MutationOutcomeUnknownError,type MaintenanceClaim,type MaintenanceCompletion} from './maintenance-attempt.ts';
import {captureDispatchAttemptInput,type DispatchAttemptInput,type DispatchResult,type QueueMutationClaim,type StopMutationClaim} from './dispatch-attempt.ts';
import {ownedRequestFailure} from './request-client.ts';
import {isObservationalRequest} from './requests.ts';
import {serdeField} from './value.ts';

/** Explicit asynchronous boundary; never pass this into legacy sync fences.
 * Receipt belongs to the supplied native persistence owner, not to a wire or a
 * new resident generation. Caller must retain original admission/target authority. */
export interface OwnedDispatchMutationFence {
 beginMutationWithOrigin(claim:MaintenanceClaim):Promise<object>;
 beginQueueMutation(claim:QueueMutationClaim):Promise<object>;
 beginStopMutation(claim:StopMutationClaim):Promise<object>;
 finishMutation(receipt:object,outcome:MaintenanceCompletion['outcome']):Promise<void>;
 wasNotSubmitted?(error:unknown,attemptId:string,wire:RequestId,method:string):boolean;
}
export function pinOwnedDispatchMutationFence(input:OwnedDispatchMutationFence):OwnedDispatchMutationFence{
 if(input===null||typeof input!=='object'||types.isProxy(input))throw new TypeError('Expected owned native dispatch fence');
 const get=(key:string)=>{const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='function'||types.isProxy(d.value)||types.isGeneratorFunction(d.value))throw new TypeError('Expected own native dispatch callback');return d.value as Function;};
 const begin=get('beginMutationWithOrigin'),queue=get('beginQueueMutation'),stop=get('beginStopMutation'),finish=get('finishMutation');
 const descriptor=Object.getOwnPropertyDescriptor(input,'wasNotSubmitted');let proof:Function|null=null;
 if(descriptor!==undefined){if(!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='function'||types.isProxy(descriptor.value)||types.isAsyncFunction(descriptor.value)||types.isGeneratorFunction(descriptor.value))throw new TypeError('Expected synchronous own native admission proof');proof=descriptor.value;}
 const wasNotSubmitted=(error:unknown,attemptId:string,wire:RequestId,method:string):boolean=>{
  if(proof===null)return false;const result=Reflect.apply(proof,input,[error,attemptId,wire,method]);
  if(types.isPromise(result))void Promise.prototype.then.call(result,undefined,()=>undefined);
  if(typeof result!=='boolean')throw new TypeError('Expected exact native admission proof boolean');return result;
 };

 const invoke=async(fn:Function,args:unknown[]):Promise<unknown>=>{const p=Reflect.apply(fn,input,args);if(!types.isPromise(p))throw new TypeError('Native dispatch callback must return a Promise');return await p;};
 const receipt=async(fn:Function,c:unknown):Promise<object>=>{const r=await invoke(fn,[c]);if(r===null||typeof r!=='object'||types.isProxy(r)||!Object.isFrozen(r))throw new TypeError('Expected immutable native dispatch receipt');return r;};
 return Object.freeze({wasNotSubmitted,beginMutationWithOrigin:(c:MaintenanceClaim)=>receipt(begin,c),beginQueueMutation:(c:QueueMutationClaim)=>receipt(queue,c),beginStopMutation:(c:StopMutationClaim)=>receipt(stop,c),finishMutation:async(r:object,o:MaintenanceCompletion['outcome'])=>{if(await invoke(finish,[r,o])!==undefined)throw new TypeError('Native completion must resolve void');}});
}
/** Phase-aware native intent owner. A successful begin does not authorize send.
 * The writer may dispose an unsent receipt after original-authority revalidation
 * fails. Once writing starts, disposal leaves it held. Only an observed result
 * can finish it, and caller cancellation after writing has no synthetic result. */
export class OwnedDispatchAttempt {
 readonly #input:DispatchAttemptInput;readonly #scoped:boolean;readonly #fence:OwnedDispatchMutationFence;readonly #render:(error:unknown)=>string;readonly #id=randomUUID();
 #refusal:unknown;#beginRefused=false;#begun=false;#beginInFlight=false;#started=false;#resultHandled=false;#receipt:object|null=null;#settlement:Promise<void>|null=null;#failure:MutationOutcomeUnknownError|null=null;
 constructor(input:DispatchAttemptInput,fence:OwnedDispatchMutationFence,render:(error:unknown)=>string){
  const captured=captureDispatchAttemptInput(input);this.#input=captured.input;this.#scoped=captured.scoped;this.#fence=pinOwnedDispatchMutationFence(fence);
  if(typeof render!=='function'||types.isProxy(render)||types.isAsyncFunction(render)||types.isGeneratorFunction(render))throw new TypeError('Expected synchronous safe renderer');this.#render=render;
 }
 async begin(wire:RequestId):Promise<object|null>{
  if(this.#begun||this.#resultHandled)throw new TypeError('Owned dispatch already begun or finished');wire=validateRequestId(wire);this.#begun=true;
  const i=this.#input;if(isObservationalRequest(i.method)||(i.method==='turn/interrupt'&&i.stopClaim===null))return null;
  this.#beginInFlight=true;
  const identity={ownerId:i.ownerId,generation:i.generation,attemptId:this.#id,wire};
  try{
   const r=i.stopClaim!==null?await this.#fence.beginStopMutation({...identity,params:i.params,claim:i.stopClaim}):i.queueClaim!==null?await this.#fence.beginQueueMutation({...identity,method:i.method,params:i.params,claim:i.queueClaim}):await this.#fence.beginMutationWithOrigin({...identity,method:i.method,params:i.params,scoped:this.#scoped,origin:i.origin});
   this.#receipt=r;return r;
  }catch(error){
   let refused=false;try{refused=this.#fence.wasNotSubmitted?.(error,this.#id,wire,i.method)===true;}catch{/* Invalid proof cannot downgrade uncertainty. */}
   if(refused){this.#beginRefused=true;this.#refusal=error;throw error;}
   this.#failure=this.#unknown('native begin result unavailable',error);throw this.#failure;
  }finally{this.#beginInFlight=false;}
 }
 writeStarted():void{if(!this.#begun||this.#beginRefused||this.#beginInFlight||this.#failure!==null||this.#resultHandled||this.#settlement!==null)throw new TypeError('Owned dispatch is not ready to write');this.#started=true;}
 wasStarted():boolean{return this.#started;}
 isolatesTarget():boolean{return this.#scoped&&this.#receipt!==null;}
 async dispose(receipt:object|null):Promise<void>{
  if(this.#beginInFlight)throw new TypeError('Native begin is still owned and running');
  if(receipt!==this.#receipt)throw new TypeError('Foreign native dispatch receipt');
  if(receipt===null||this.#started)return;
  await this.#settle('not_sent');
 }
 async finish(input:DispatchResult):Promise<DispatchResult>{
  if(this.#beginInFlight)throw new TypeError('Native begin is still owned and running');
  if(this.#resultHandled)throw new TypeError('Owned dispatch result already handled');
  const ok=serdeField(input,'ok');if(ok!==true&&ok!==false)throw new TypeError('Expected exact dispatch result');
  const result:DispatchResult=ok?{ok:true,value:cloneOwnedSerdeValue(serdeField(input,'value'))}:{ok:false,error:serdeField(input,'error')};this.#resultHandled=true;
  if(this.#settlement!==null)try{await this.#settlement;}catch{/* Return the exact owned unknown result below. */}
  if(this.#beginRefused)return {ok:false,error:this.#refusal};
  if(this.#failure!==null)return {ok:false,error:this.#failure};
  if(this.#receipt===null||this.#settlement!==null)return result;
  const outcome=!this.#started?'not_sent':result.ok?'reply_ok':ownedRequestFailure(result.error)?.kind==='Remote'?'reply_error':null;
  if(outcome===null)return {ok:false,error:this.#unknown('wire outcome remains unknown',result.ok?undefined:result.error)};
  try{await this.#settle(outcome);return result;}catch{return {ok:false,error:this.#failure!};}
 }
 #settle(outcome:MaintenanceCompletion['outcome']):Promise<void>{
  if(this.#settlement!==null)return this.#settlement;
  if(this.#receipt===null)throw new TypeError('No committed receipt to complete');
  const r=this.#receipt;this.#settlement=Promise.resolve().then(async()=>{try{await this.#fence.finishMutation(r,outcome);}catch(error){this.#failure=this.#unknown('native completion result unavailable',error);throw this.#failure;}});return this.#settlement;
 }
 #unknown(reason:string,error:unknown):MutationOutcomeUnknownError{
  let safe='diagnostic unavailable';try{const v=this.#render(error);if(types.isPromise(v))void Promise.prototype.then.call(v,undefined,()=>undefined);if(typeof v==='string'&&!/[\uD800-\uDFFF]/u.test(v))safe=Array.from(v).slice(0,2048).join('');}catch{/* No raw fallback. */}
  return new MutationOutcomeUnknownError(this.#input.method,`${reason}: ${safe}; original attempt ${this.#id} retained for reconciliation; no automatic replay`);
 }
}
Object.freeze(OwnedDispatchAttempt.prototype);
