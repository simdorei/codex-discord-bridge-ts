import {randomUUID,createHash} from 'node:crypto';
import {types} from 'node:util';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {I64_MAX} from '../protocol/ids.ts';
import type {DeadGenerationWork} from '../app-server/dead-generation-work.ts';
import {encodeDeadGenerationTransfer} from '../app-server/dead-generation-transfer.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {pinNativeRuntimePath} from './runtime-paths/path-text.ts';
import {createRuntimeFenceErrors} from './fence-errors.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from './owned-worker-slot.ts';
function text(value:unknown,limit:number):string{if(typeof value!=='string'||/[\uD800-\uDFFF]/u.test(value)||value.includes('\0')||Buffer.byteLength(value)>limit)throw new TypeError('Expected bounded dead-generation identity');return value;}
/** One Control worker, zero waiting queue. Capture is always existing-only.
 * The startup factory alone activates custody, then returns this same owner. Cancellation and
 * timeout retain this original native owner until exit, including possible commits
 * whose ACK was lost. Only a later exact-snapshot reconciliation may settle work. */
export class NativeDeadGenerationOwner {
 readonly #path:string;readonly #runtime:string;readonly #channel:bigint|null;readonly #timeout:number;readonly #errors:ReturnType<typeof createRuntimeFenceErrors>;readonly #slot=new OwnedWorkerSlot('Control');
 #closed=false;#active:Promise<void>|null=null;#controller:AbortController|null=null;
 constructor(path:string,runtime:string,startupChannel:bigint|null,render:(error:unknown)=>string,timeoutMs=5000){
  this.#path=pinNativeRuntimePath(text(path,32768));this.#runtime=text(runtime,4096);if(runtime==='')throw new TypeError('Expected runtime identity');
  if(startupChannel!==null&&(typeof startupChannel!=='bigint'||startupChannel<0n||startupChannel>I64_MAX))throw new TypeError('Expected signed startup channel');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid dead-generation native deadline');
  this.#channel=startupChannel;this.#timeout=timeoutMs;this.#errors=createRuntimeFenceErrors(render);
 }
 /** Call only before resident spawn while the caller holds its singleton guard.
  * Activation may partially commit on failure; never retry or roll it back here. */
 static async startWithCustodyActivation(path:string,runtime:string,startupChannel:bigint|null,render:(error:unknown)=>string,signal?:AbortSignal,timeoutMs=5000):Promise<NativeDeadGenerationOwner>{
  const owner=new NativeDeadGenerationOwner(path,runtime,startupChannel,render,timeoutMs);
  try{await owner.#activateCustody(signal);return owner;}catch(error){await owner.close();throw error;}
 }
 get busy():boolean{return this.#active!==null;}
 async close():Promise<void>{this.#closed=true;this.#controller?.abort(new Error('Dead-generation owner closed'));if(this.#active!==null)await Promise.allSettled([this.#active]);}
 #requireAvailable(signal?:AbortSignal):void{
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected owned AbortSignal');signal?.throwIfAborted();
  if(this.#closed)throw new Error('Dead-generation owner closed');if(this.#active!==null)throw new OwnedWorkerBusyError();
 }
 #activateCustody(signal?:AbortSignal):Promise<void>{
  this.#requireAvailable(signal);
  const operation=randomUUID(),request={kind:'ActivateCustody',path:this.#path,runtime:this.#runtime,startupChannel:this.#channel,operation};
  const binding=createHash('sha256').update(serializeSerdeValue(request)).digest('hex');
  return this.#run(request,raw=>{
   if(own(raw,'kind')!=='ActivateCustody'||own(raw,'operation')!==operation||own(raw,'path')!==this.#path||own(raw,'runtime')!==this.#runtime||own(raw,'binding')!==binding)throw new TypeError('Custody activation acknowledgment identity changed');
   if(own(raw,'ok')===true&&Reflect.ownKeys(raw).length===6)return;
   if(own(raw,'ok')===false&&Reflect.ownKeys(raw).length===7)throw new Error(text(own(raw,'detail'),16384));
   throw new TypeError('Invalid custody activation acknowledgment');
  },signal);
 }
 capture(instanceId:string,work:DeadGenerationWork,signal?:AbortSignal):Promise<void>{
  this.#requireAvailable(signal);
  const {request,operation,generation,binding}=this.#errors.run('DeadGenerationFence',()=>{
   text(instanceId,4096);const transfer=encodeDeadGenerationTransfer(work),generation=own(transfer,'generation');if(typeof generation!=='bigint'||generation<=0n||generation>I64_MAX)throw new RangeError('Dead generation does not fit signed i64');
   const operation=randomUUID(),request={kind:'Capture',path:this.#path,runtime:this.#runtime,instanceId,startupChannel:this.#channel,operation,generation,work:transfer};
   // This bounded digest binds the entire original transfer. Durable source-format
   // serialization and source target derivation remain inside the native worker.
   return {request,operation,generation,binding:createHash('sha256').update(serializeSerdeValue(request)).digest('hex')};
  });
  return this.#run(request,raw=>{
   const ok=own(raw,'ok');if(own(raw,'operation')!==operation||own(raw,'generation')!==generation||own(raw,'binding')!==binding)throw new TypeError('Dead-generation acknowledgment identity changed');
   if(ok===true&&Reflect.ownKeys(raw).length===5&&typeof own(raw,'captured')==='boolean')return;
   if(ok===false&&Reflect.ownKeys(raw).length===5)throw new Error(text(own(raw,'detail'),16384));
   throw new TypeError('Invalid dead-generation acknowledgment');
  },signal);
 }
 #run(request:object,validate:(raw:object)=>void,signal?:AbortSignal):Promise<void>{
  const controller=new AbortController();this.#controller=controller;
  const abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const task=(async()=>{try{
   const pending=this.#slot.run(new URL('./native-dead-generation-worker.ts',import.meta.url),request,this.#timeout,controller.signal),joined=this.#slot.join();let raw:unknown;
   try{raw=await pending;}finally{await joined;}controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,32768)===null||raw===null||typeof raw!=='object')throw new TypeError('Invalid dead-generation acknowledgment');
   validate(raw);
  }catch(error){this.#errors.fail('DeadGenerationFence',error);}finally{signal?.removeEventListener('abort',abort);}})();
  this.#active=task;const clear=()=>{if(this.#active===task){this.#active=null;this.#controller=null;}};void task.then(clear,clear);return task;
 }
}
Object.freeze(NativeDeadGenerationOwner.prototype);
