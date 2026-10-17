import {types} from 'node:util';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {NewReply} from '../../store/new-reply-read.ts';
import {NativeNewReplyStore} from './native-store.ts';
import {inspectNewReply} from './inspection.ts';
export class NewReplyReconcilerBusyError extends Error{constructor(){super('New reply reconciliation already owns a batch');this.name='NewReplyReconcilerBusyError';}}
export class NewReplyVerificationError extends Error{
 readonly jobId:string;
 constructor(jobId:string,cause:unknown){super('New first-input verification held',{cause});this.name='NewReplyVerificationError';this.jobId=jobId;}
}
/** Owns one zero-queue reconciliation batch of at most eight original intents.
 * Native SQLite, exact source lookup and bounded file parsing are awaited.
 * Errors preserve the previous scan; checkpoint CAS and identity/mapping checks
 * remain the sole store update. No notification or Discord reply is sent here.
 * A write uncertainty aborts the batch; next cycle reads fresh durable revisions. */
export class NewReplyReconciler{
 readonly #store:NativeNewReplyStore;readonly #report:(error:NewReplyVerificationError)=>void;
 #closed=false;#running:Promise<readonly NewReply[]>|null=null;#controller:AbortController|null=null;
 constructor(path:string,report:(error:NewReplyVerificationError)=>void){
  requireDiscordText(path);if(typeof report!=='function'||types.isProxy(report)||types.isAsyncFunction(report)||types.isGeneratorFunction(report))throw new TypeError('Expected synchronous verification reporter');
  this.#store=new NativeNewReplyStore(path);this.#report=report;
 }
 get busy():boolean{return this.#running!==null;}
 async close(reason:unknown=new Error('New reply reconciler closed')):Promise<void>{
  this.#closed=true;this.#controller?.abort(reason);await Promise.allSettled([this.#store.close(reason),...(this.#running===null?[]:[this.#running])]);
 }
 runOnce(signal?:AbortSignal):Promise<readonly NewReply[]>{
  signal?.throwIfAborted();if(this.#closed)throw new Error('New reply reconciler is closed');if(this.#running!==null)throw new NewReplyReconcilerBusyError();
  const controller=new AbortController();this.#controller=controller;const abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const operation=(async()=>{
   try{
    const ready:NewReply[]=[];
    for(const record of await this.#store.pending(8,controller.signal)){
     controller.signal.throwIfAborted();let scan=record.scan,verified=false,error='';
     try{const inspection=await inspectNewReply(record,controller.signal);await inspection.verifyCurrent(controller.signal);const observed=inspection.captured();scan=observed.scan;verified=observed.verified;}
     catch(cause){controller.signal.throwIfAborted();error=passiveErrorText(cause,'New reply inspection failed');if(Buffer.byteLength(error)>65536)error='New reply inspection failed with oversized diagnostic';if(error!==record.lastError)invokeSynchronousVoid(this.#report,{},[new NewReplyVerificationError(record.identity.job_id,cause)]);}
     controller.signal.throwIfAborted();
     if(await this.#store.checkpoint(record,{scan,verified,error,now:Date.now()/1000},controller.signal)){
      const current=await this.#store.read(record.identity.job_id,controller.signal);if(current!==null)ready.push(current);
     }
    }
    return Object.freeze(ready);
   }finally{signal?.removeEventListener('abort',abort);}
  })();this.#running=operation;void operation.then(()=>{this.#running=null;this.#controller=null;},()=>{this.#running=null;this.#controller=null;});return operation;
 }
}
Object.freeze(NewReplyReconciler.prototype);
