import {types} from 'node:util';
import {isMainThread} from 'node:worker_threads';
import {requireDiscordText} from '../discord/text.ts';
import {validateRequestId,type RequestId} from '../protocol/ids.ts';
import type {MaintenanceClaim,MaintenanceCompletion} from '../app-server/maintenance-attempt.ts';
import type {QueueMutationClaim,StopMutationClaim} from '../app-server/dispatch-attempt.ts';
import type {ResidentNativeDispatch} from '../app-server/resident-native-dispatch.ts';
import {createNativeMutationRevalidator} from './mutation-custody-fence.ts';
import {pinNativeRuntimePath} from './runtime-paths/path-text.ts';
import {captureSequentialMutationClaim,type SequentialMutationClaim,type SequentialMutationOperation} from './sequential-mutation-broker-protocol.ts';
import {isSequentialMutationClient,InvalidInputBeforePost,ClosedBeforePost,BrokerOutcomeUnknown,type SequentialMutationClient,type PreparedHandle} from './sequential-mutation-broker-client.ts';

interface ReceiptData {readonly claim:SequentialMutationClaim;readonly operation:SequentialMutationOperation;readonly operationId:number;readonly handle:PreparedHandle;consumed:boolean}
const operationNames={ordinary:'beginMutationWithOrigin',queue:'beginQueueMutation',stop:'beginStopMutation'} as const;
/** Worker-local persistence evidence only. Original resident admission and target
 * checks still follow validate synchronously, immediately before Writable.write.
 * No production startup path installs this preparation component. */
export class ResidentLocalMutationOwner implements ResidentNativeDispatch {
 readonly #client:SequentialMutationClient;
 readonly #revalidate:ReturnType<typeof createNativeMutationRevalidator>;
 readonly #receipts=new WeakMap<object,ReceiptData>();
 readonly #unsubmitted=new WeakMap<object,{attemptId:string;wire:RequestId;method:string}>();
 #active:ReceiptData|null=null;#pending:Promise<unknown>|null=null;#quarantined=false;#closed=false;#closing:Promise<void>|null=null;
 constructor(path:string,runtime:string,render:(error:unknown)=>string,client:SequentialMutationClient){
  if(isMainThread)throw new Error('Resident local mutation owner requires the resident worker');
  if(!isSequentialMutationClient(client))throw new TypeError('Expected original sequential mutation client');
  requireDiscordText(path);requireDiscordText(runtime);
  if(path.includes('\0')||runtime.includes('\0')||runtime===''||Buffer.byteLength(path)>32768||Buffer.byteLength(runtime)>4096)throw new TypeError('Invalid resident store binding');
  if(typeof render!=='function'||types.isProxy(render)||types.isAsyncFunction(render)||types.isGeneratorFunction(render))throw new TypeError('Expected synchronous resident renderer');
  this.#client=client;this.#revalidate=createNativeMutationRevalidator(pinNativeRuntimePath(path),runtime,render);
 }
 readonly beginMutationWithOrigin=(claim:MaintenanceClaim):Promise<object>=>this.#begin('ordinary',claim);
 readonly beginQueueMutation=(claim:QueueMutationClaim):Promise<object>=>this.#begin('queue',claim);
 readonly beginStopMutation=(claim:StopMutationClaim):Promise<object>=>this.#begin('stop',claim);
 readonly wasNotSubmitted=(error:unknown,attemptId:string,wire:RequestId,method:string):boolean=>{
  const proof=error!==null&&typeof error==='object'?this.#unsubmitted.get(error):undefined;
  return proof!==undefined?proof.attemptId===attemptId&&proof.wire===wire&&proof.method===method:this.#client.ownsUnsubmittedFailure(error,attemptId,wire,method);
 };
 readonly validate=(receipt:object):void=>{
  const data=this.#requireReceipt(receipt);this.#revalidate(data.claim,operationNames[data.operation]);
 };
 readonly finishMutation=(receipt:object,outcome:MaintenanceCompletion['outcome']):Promise<void>=>{
  const data=this.#requireReceipt(receipt);
  if(outcome!=='not_sent'&&outcome!=='reply_ok'&&outcome!=='reply_error')throw new TypeError('Expected original observed mutation outcome');
  data.consumed=true;this.#receipts.delete(receipt);
  let pending:Promise<void>;
  try{pending=this.#client.finish(data.handle,outcome);}catch(error){this.markOutcomeUnknown(receipt);throw error;}
  const task=pending.then(()=>{this.#active=null;},error=>{this.markOutcomeUnknown(receipt);throw error;});
  return this.#track(task);
 };
 /** Irreversible local flag precedes any endpoint work, including occupied credit.
  * A null receipt covers a begin that was posted but never acknowledged. */
 readonly markOutcomeUnknown=(receipt:object|null):void=>{
  this.#quarantined=true;this.#closed=true;
  if(this.#active!==null)this.#active.consumed=true;
  const data=receipt===null?undefined:this.#receipts.get(receipt);
  if(data!==undefined)data.consumed=true;
  this.#client.quarantine(data?.handle??this.#active?.handle??null);
 };
 readonly close=():Promise<void>=>{
  if(this.#closing!==null)return this.#closing;
  this.#closed=true;
  this.#closing=this.#close();return this.#closing;
 };
 async #close():Promise<void>{
  if(this.#pending!==null)try{await this.#pending;}catch{/* Client already retains quarantine and durable diagnostic truth. */}
  if(this.#quarantined)throw new BrokerOutcomeUnknown();
  if(this.#active!==null){this.markOutcomeUnknown(null);throw new BrokerOutcomeUnknown();}
  await this.#client.stopNewWork();await this.#client.closeIdle();
 }
 #requireReceipt(receipt:object):ReceiptData{
  if(this.#quarantined)throw new Error('Resident mutation outcome remains unknown');
  const data=this.#receipts.get(receipt);
  if(data===undefined||data.consumed||data!==this.#active)throw new TypeError('Expected unused original resident mutation receipt');
  return data;
 }
 #track<T>(task:Promise<T>):Promise<T>{
  if(this.#pending===null)this.#pending=task;const clear=()=>{if(this.#pending===task)this.#pending=null;};void task.then(clear,clear);return task;
 }
 #begin(operation:SequentialMutationOperation,input:SequentialMutationClaim):Promise<object>{
  let claim:SequentialMutationClaim;
  try{claim=captureSequentialMutationClaim(operation,input,this.#client.limits);}catch{
   const error=new InvalidInputBeforePost();
   // Only passive own identity fields establish local non-submission provenance.
   if(input!==null&&typeof input==='object'&&!types.isProxy(input))try{
    const own=(key:string):unknown=>{const d=Object.getOwnPropertyDescriptor(input,key);return d&&Object.hasOwn(d,'value')?d.value:undefined;};
    const attemptId=own('attemptId'),method=operation==='stop'?'turn/interrupt':own('method'),wire=validateRequestId(own('wire'));
    if(typeof attemptId==='string'&&attemptId!==''&&typeof method==='string'&&method!=='')this.#unsubmitted.set(error,{attemptId,wire,method});
   }catch{/* Malformed identity carries no proof. */}
   throw error;
  }
  if(this.#closed||this.#quarantined){
   const error=new ClosedBeforePost();this.#unsubmitted.set(error,{attemptId:claim.attemptId,wire:claim.wire,method:operation==='stop'?'turn/interrupt':(claim as MaintenanceClaim).method});throw error;
  }
  const pending=operation==='ordinary'?this.#client.beginOrdinary(claim):operation==='queue'?this.#client.beginQueue(claim):this.#client.beginStop(claim);
  const task=pending.then(handle=>{
   if(this.#closed||this.#quarantined){this.markOutcomeUnknown(null);throw new Error('Resident owner closed during mutation begin');}
   const receipt=Object.freeze({});const data:ReceiptData={claim,operation,operationId:handle.operationId,handle,consumed:false};
   this.#receipts.set(receipt,data);this.#active=data;return receipt;
  },error=>{this.markOutcomeUnknown(null);throw error;});
  return this.#track(task);
 }
}
Object.freeze(ResidentLocalMutationOwner.prototype);
