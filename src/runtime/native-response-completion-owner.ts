import {types} from 'node:util';
import {randomUUID} from 'node:crypto';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {MutationOutcomeUnknownError} from '../app-server/maintenance-attempt.ts';
import type {DurableResponseClaim,DurableResponseCompletion} from '../app-server/response-attempt.ts';
import type {ResponseCustodyScope} from '../store/response-custody.ts';
import {responseCustodyScope} from './response-custody-fence.ts';
import {pinNativeRuntimePath} from './runtime-paths/path-text.ts';
import {OwnedWorkerSlot} from './owned-worker-slot.ts';
interface Original {readonly scope:ResponseCustodyScope;readonly authority:unknown;readonly payload:unknown}
interface Receipt {readonly original:Original;used:boolean}
/** Only post-effect persistence. Receipts are private one-use original metadata,
 * never execution authority. Legacy synchronous begin/final wire checks remain.
 * Cancellation, failed submission, or missing ACK cannot authorize any replay. */
export class NativeResponseCompletionOwner {
 readonly #path:string;readonly #runtime:string;readonly #timeout:number;
 readonly #receipts=new WeakMap<object,Receipt>();readonly #tasks=new Set<Promise<void>>();readonly #controllers=new Set<AbortController>();#closed=false;
 constructor(path:string,runtime:string,timeoutMs=5000){
  requireDiscordText(path);requireDiscordText(runtime);
  if(path.includes('\0')||runtime.includes('\0')||runtime===''||Buffer.byteLength(path)>32768||Buffer.byteLength(runtime)>4096)throw new TypeError('Expected response completion path and runtime');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid native response completion deadline');
  this.#path=pinNativeRuntimePath(path);this.#runtime=runtime;this.#timeout=timeoutMs;
 }
 get busy():boolean{return this.#tasks.size>0;}
 captureResponse(claim:DurableResponseClaim):object{
  if(this.#closed)throw new TypeError('Native response completion owner is closed');
  const value={scope:responseCustodyScope(this.#runtime,claim),authority:own(claim,'authority'),payload:own(claim,'payload')};
  // Preserve the legacy response Value limits. This clone is validation and
  // ownership, not a new 1 MiB payload cap or a qualified process heap budget.
  const original=cloneOwnedSerdeValue(value) as Original,receipt=Object.freeze({});this.#receipts.set(receipt,{original,used:false});return receipt;
 }
 finishResponse(receipt:object,outcome:DurableResponseCompletion['outcome'],signal?:AbortSignal):Promise<void>{
  const data=this.#receipts.get(receipt);if(data===undefined||data.used)throw new TypeError('Expected unused receipt from this native response owner');
  if(outcome!=='flushed'&&outcome!=='not_sent')throw new TypeError('Expected explicit observed response outcome');
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected owned AbortSignal');
  data.used=true;
  const controller=new AbortController(),slot=new OwnedWorkerSlot('Control'),requestId=randomUUID();
  const abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  this.#controllers.add(controller);
  const task=(async()=>{
   try{
    if(this.#closed)throw new Error('Native response completion owner is closed');controller.signal.throwIfAborted();
    const pending=slot.runControlCompletion(new URL('./native-response-completion-worker.ts',import.meta.url),{path:this.#path,requestId,...data.original,outcome},this.#timeout,controller.signal);
    let raw:unknown;try{raw=await pending;}finally{await slot.join();}
    controller.signal.throwIfAborted();
    if(boundedSerdeByteCount(raw,16384)===null||own(raw,'ok')!==true||own(raw,'requestId')!==requestId)throw new Error('Original response completion ACK unavailable');
   }catch{
    // Even a joined failed worker may have committed before its ACK was lost.
    throw new MutationOutcomeUnknownError('server/response','native response completion result not confirmed; original response admission retained; no automatic replay');
   }finally{signal?.removeEventListener('abort',abort);}
  })();
  this.#tasks.add(task);const clear=()=>{this.#tasks.delete(task);this.#controllers.delete(controller);};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('Native response completion owner closed')):Promise<void>{this.#closed=true;for(const controller of this.#controllers)controller.abort(reason);await Promise.allSettled([...this.#tasks]);}
}
Object.freeze(NativeResponseCompletionOwner.prototype);
