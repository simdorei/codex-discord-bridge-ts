import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';import {gatewayOwnField as own} from '../../discord/gateway/values.ts';import {requireDiscordText} from '../../discord/text.ts';import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';import {CompletionHeldError,CompletionDeliveryError} from './receipt-sender.ts';
export type NativeProgressBinding={readonly kind:'Goal';readonly job:string;readonly thread:string;readonly turn:string}|{readonly kind:'Commentary';readonly job:string;readonly sequence:bigint}|{readonly kind:'StartFailure';readonly job:string};
type Operation='Preflight'|'Failure'|'Complete';
function text(v:unknown):string{requireDiscordText(v);if(Buffer.byteLength(v)>65536)throw new RangeError('Progress identity exceeds boundary');return v;}
function binding(input:NativeProgressBinding):NativeProgressBinding{const kind=own(input,'kind'),job=text(own(input,'job'));if(kind==='Goal')return Object.freeze({kind,job,thread:text(own(input,'thread')),turn:text(own(input,'turn'))});if(kind==='Commentary'){const sequence=own(input,'sequence');if(typeof sequence!=='bigint'||sequence<-(1n<<63n)||sequence>=(1n<<63n))throw new TypeError('Expected signed commentary sequence');return Object.freeze({kind,job,sequence});}if(kind==='StartFailure')return Object.freeze({kind,job});throw new TypeError('Invalid progress binding');}
export class NativeProgressStateUnconfirmedError extends Error{readonly operation:Operation;constructor(operation:Operation,cause:unknown){super('Progress state result unconfirmed after native join; no automatic retry',{cause});this.name='NativeProgressStateUnconfirmedError';this.operation=operation;}}
/** Original source-specific state phase only. Distinct reads use distinct owned
 * connections and retain short-circuit ordering. No send permission or new pool. */
export class NativeProgressStateOwner{
 readonly #path:string;readonly #binding:NativeProgressBinding;readonly #timeout:number;readonly #slot=new OwnedWorkerSlot('Control');#closed=false;#task:Promise<unknown>|null=null;#controller:AbortController|null=null;
 constructor(path:string,input:NativeProgressBinding,timeoutMs=5000){requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid progress path');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid progress deadline');this.#path=pinNativeRuntimePath(path);this.#binding=binding(input);this.#timeout=timeoutMs;}
 get busy():boolean{return this.#task!==null;}
 async ensure():Promise<void>{
  if(this.#binding.kind==='StartFailure')throw new TypeError('Start failure has no first-reply preflight');
  const raw=await this.#run('Preflight',{});let value:{kind:'Ready'|'Held'|'FirstReply'|'Commentary';detail?:string};try{
   const kind=own(raw,'kind');if(kind==='Ready'||kind==='Commentary')value={kind};else if(kind==='Held'||kind==='FirstReply')value={kind,detail:text(own(raw,'detail'))};else throw new TypeError('Invalid progress readiness');
  }catch(error){throw new NativeProgressStateUnconfirmedError('Preflight',error);}
  if(value.kind==='Held')throw new CompletionHeldError(value.detail!);
  if(value.kind==='FirstReply')throw new CompletionDeliveryError(`output saved; first reply is not confirmed for ${value.detail!}. No output POST attempted; inspect the saved request if its reply failed`);
  if(value.kind==='Commentary')throw new CompletionDeliveryError('output saved behind earlier undelivered progress; no output POST attempted');
 }
 async recordFailure(display:string):Promise<void>{if(this.#binding.kind!=='Goal')throw new TypeError('Only original Goal send phase records failure');requireDiscordText(display);await this.#ack('Failure',{display});}
 complete():Promise<void>{return this.#ack('Complete',{});}
 async #ack(operation:Operation,fields:object):Promise<void>{if(await this.#run(operation,fields)!==true)throw new NativeProgressStateUnconfirmedError(operation,new TypeError('Invalid mutation acknowledgement'));}
 #run(operation:Operation,fields:object):Promise<unknown>{
  if(this.#closed)throw new Error('Progress state owner is closed');if(this.#task!==null)throw new OwnedWorkerBusyError();const data={path:this.#path,binding:this.#binding,operation,...fields};if(boundedSerdeByteCount(data,16*1024*1024)===null)throw new RangeError('Progress state exceeds native wire budget');const controller=new AbortController();this.#controller=controller;
  const task=(async()=>{let admitted=false;try{const url=new URL('./native-progress-state-worker.ts',import.meta.url),pending=operation==='Preflight'?this.#slot.run(url,data,this.#timeout,controller.signal):this.#slot.runControlCompletion(url,data,this.#timeout,controller.signal);admitted=this.#slot.busy;let raw:unknown;try{raw=await pending;}finally{await this.#slot.join();}controller.signal.throwIfAborted();if(boundedSerdeByteCount(raw,16*1024*1024)===null||own(raw,'ok')!==true)throw new Error('No confirmed native progress result');return own(raw,'value');}catch(error){if(admitted)throw new NativeProgressStateUnconfirmedError(operation,error);throw error;}})();this.#task=task;const clear=()=>{this.#task=null;this.#controller=null;};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('Progress state owner closed')):Promise<void>{this.#closed=true;this.#controller?.abort(reason);if(this.#task!==null)await Promise.allSettled([this.#task]);}
}
Object.freeze(NativeProgressStateOwner.prototype);
