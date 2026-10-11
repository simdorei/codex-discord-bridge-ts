import {resolve} from 'node:path';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {ReceiptState} from '../../store/delivery-receipts.ts';
type Kind='Begin'|'Confirm'|'Release'|'Block';
interface Request{kind:Kind;key:string;hash:string;message?:string;reason?:string}
function text(v:string,max:number,nonempty=false):void{requireDiscordText(v);if(v.length>max||Buffer.byteLength(v)>max||(nonempty&&v===''))throw new RangeError('Mirror receipt text budget exceeded');}
function message(v:unknown):asserts v is string{if(typeof v!=='string'||v.length>20||!/^[1-9][0-9]*$/.test(v)||BigInt(v)>=(1n<<64n))throw new TypeError('Expected canonical positive u64 receipt');}
export class MirrorReceiptWriteUnconfirmedError extends Error{
 readonly operation:Kind;readonly key:string;
 constructor(request:Request,cause:unknown){super('Mirror receipt write result unconfirmed; reconcile after native exit without automatic send',{cause});this.name='MirrorReceiptWriteUnconfirmedError';this.operation=request.kind;this.key=request.key;}
}
function receipt(value:unknown):ReceiptState{
 const kind=own(value,'kind');
 if(kind==='New'||kind==='Unknown'||kind==='ContentConflict')return Object.freeze({kind});
 if(kind==='Delivered'){const id=own(value,'messageId');message(id);return Object.freeze({kind,messageId:id});}
 if(kind==='Held'||kind==='RejectedBlocked'){const reason=own(value,'reason');if(typeof reason!=='string')throw new TypeError('Invalid receipt reason');text(reason,4000);return Object.freeze({kind,reason});}
 throw new TypeError('Invalid mirror receipt state');
}
/** Bounded mirror-only persistence, not a generic completion guard bypass.
 * Existing DB only; Begin rechecks current mapping. Confirmation of an already
 * attempted send still records the original receipt after a later remap.
 * Release requires caller's authoritative rejection evidence, never timeout.
 * One actual worker at a time; close/cancel/deadline join, no implicit retry. */
export class NativeMirrorReceiptStore{
 readonly #path:string;readonly #thread:string;readonly #channel:bigint;readonly #timeout:number;
 readonly #slot=new OwnedWorkerSlot();#closed=false;#controller:AbortController|null=null;#inflight:Promise<unknown>|null=null;
 constructor(path:string,thread:string,channel:bigint,timeoutMs=5000){
  text(path,32768,true);if(path.includes('\0'))throw new TypeError('NUL store path');text(thread,16384,true);
  if(typeof channel!=='bigint'||channel<=0n||channel>=(1n<<63n))throw new RangeError('Expected mapped positive i64 channel');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid mirror receipt deadline');
  this.#path=resolve(path);text(this.#path,32768,true);this.#thread=thread;this.#channel=channel;this.#timeout=timeoutMs;
 }
 /** Bind cached read evidence to this exact native owner before omitting work. */
 assertOwner(path:string,thread:string,channel:bigint):void{const pinned=this.#path;if(pinned!==resolve(path)||this.#thread!==thread||this.#channel!==channel)throw new TypeError('Mirror receipt snapshot belongs to a different owner');if(this.#closed)throw new Error('Mirror receipt store is closed');}
 get busy():boolean{return this.#inflight!==null;}
 async close(reason:unknown=new Error('Mirror receipt store closed')):Promise<void>{this.#closed=true;this.#controller?.abort(reason);if(this.#inflight!==null)await Promise.allSettled([this.#inflight]);}
 async begin(key:string,hash:string,signal?:AbortSignal):Promise<ReceiptState>{
  const request:Request={kind:'Begin',key,hash},value=await this.#run(request,signal);
  try{return receipt(value)}catch(error){throw new MirrorReceiptWriteUnconfirmedError(request,error)}
 }
 async confirm(key:string,hash:string,id:string,signal?:AbortSignal):Promise<boolean>{message(id);return this.#boolean({kind:'Confirm',key,hash,message:id},signal);}
 async releaseRejected(key:string,hash:string,signal?:AbortSignal):Promise<boolean>{return this.#boolean({kind:'Release',key,hash},signal);}
 async blockRejected(key:string,hash:string,reason:string,signal?:AbortSignal):Promise<boolean>{text(reason,16384);return this.#boolean({kind:'Block',key,hash,reason},signal);}
 async #boolean(request:Request,signal?:AbortSignal):Promise<boolean>{const value=await this.#run(request,signal);if(typeof value!=='boolean')throw new MirrorReceiptWriteUnconfirmedError(request,new TypeError('Invalid native receipt result'));return value;}
 #run(request:Request,signal?:AbortSignal):Promise<unknown>{
  signal?.throwIfAborted();text(request.key,65536,true);
  if(typeof request.hash!=='string'||!/^[0-9a-f]{64}$/.test(request.hash))throw new TypeError('Invalid receipt content hash');
  if(this.#closed)throw new Error('Mirror receipt store is closed');if(this.#inflight!==null)throw new OwnedWorkerBusyError();
  const controller=new AbortController();this.#controller=controller;const abort=()=>controller.abort(signal!.reason);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const operation=(async()=>{
   let submitted=false;
   try{
    const pending=this.#slot.run(new URL('./receipt-store-worker.ts',import.meta.url),{path:this.#path,thread:this.#thread,channel:this.#channel,...request},this.#timeout,controller.signal);
    submitted=this.#slot.busy;const exit=this.#slot.join();let result:unknown;try{result=await pending}finally{await exit}
    controller.signal.throwIfAborted();
    if(own(result,'ok')!==true){const detail=own(result,'detail');throw new Error(typeof detail==='string'?detail:'Invalid native receipt result');}
    return own(result,'value');
   }catch(error){if(submitted)throw new MirrorReceiptWriteUnconfirmedError(request,error);throw error}
   finally{signal?.removeEventListener('abort',abort)}
  })();
  this.#inflight=operation;void operation.then(()=>{this.#inflight=null;this.#controller=null},()=>{this.#inflight=null;this.#controller=null});return operation;
 }
}
