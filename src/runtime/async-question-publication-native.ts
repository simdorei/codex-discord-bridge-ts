import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import type {StoredAsyncQuestion} from '../store/async-question-read.ts';
import {takeUnicodeScalarChars} from '../store/queue-preflight-failure.ts';
import {requireDiscordText} from '../discord/text.ts';
import {pinNativeRuntimePath} from './runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from './owned-worker-slot.ts';
import {snapshotPublicationQuestion,questionPublicationBinding,QUESTION_PUBLICATION_BYTES,type QuestionPublicationOperation} from './async-question-publication-protocol.ts';
export class NativeQuestionPublicationUnconfirmedError extends Error{
 readonly operation:QuestionPublicationOperation;
 constructor(operation:QuestionPublicationOperation,cause:unknown){super('Question publication result unconfirmed after native exit; no automatic retry or fresh occurrence binding',{cause});this.name='NativeQuestionPublicationUnconfirmedError';this.operation=operation;}
}
/** One immutable publication occurrence, not answer-click authority. Preparation
 * may latch ownership, so an unconfirmed result never permits a send. Ordinary
 * Prepare has zero queue; original Bind/Error use the finite Control FIFO.
 * The owner and HTTP lane remain occupied until actual native exit. */
export class NativeQuestionPublicationOwner{
 readonly question:StoredAsyncQuestion;readonly #path:string;readonly #json:string;readonly #timeout:number;readonly #slot=new OwnedWorkerSlot('Control');
 #closed=false;#prepared=false;#uncertain=false;#bound=false;#task:Promise<boolean>|null=null;#controller:AbortController|null=null;#operation:QuestionPublicationOperation|null=null;
 constructor(path:string,input:StoredAsyncQuestion,timeoutMs=5000){
  requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid question publication path');this.#path=pinNativeRuntimePath(path);
  this.question=snapshotPublicationQuestion(input);this.#json=serializeSerdeValue(this.question);
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid question publication deadline');this.#timeout=timeoutMs;
  questionPublicationBinding(randomUUID(),this.#path,'Prepare',this.#json,null);Object.freeze(this);
 }
 get busy():boolean{return this.#task!==null;}
 async prepare(signal?:AbortSignal):Promise<boolean>{if(this.#prepared||this.#uncertain||this.#bound)throw new TypeError('Original question publication already prepared or unconfirmed');const confirmed=await this.#run('Prepare',null,signal);this.#prepared=confirmed;return confirmed;}
 async bind(interactive:boolean):Promise<void>{if(!this.#prepared||this.#uncertain||this.#bound)throw new TypeError('Expected confirmed original question publication');if(await this.#run('Bind',interactive)!==true)throw new NativeQuestionPublicationUnconfirmedError('Bind',new TypeError('Invalid bind acknowledgement'));this.#bound=true;}
 async recordError(display:string):Promise<void>{requireDiscordText(display);if(await this.#run('Error',takeUnicodeScalarChars(display,1000))!==true)throw new NativeQuestionPublicationUnconfirmedError('Error',new TypeError('Invalid error acknowledgement'));}
 #run(operation:QuestionPublicationOperation,detail:string|boolean|null,signal?:AbortSignal):Promise<boolean>{
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');signal?.throwIfAborted();
  if(this.#closed)throw new Error('Question publication owner is closed');if(this.#task!==null)throw new OwnedWorkerBusyError();
  const binding=questionPublicationBinding(randomUUID(),this.#path,operation,this.#json,detail);if(boundedSerdeByteCount(binding,QUESTION_PUBLICATION_BYTES)===null)throw new RangeError('Question publication request exceeds native budget');
  const controller=new AbortController(),abort=()=>controller.abort(signal!.reason);this.#controller=controller;this.#operation=operation;signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const task=(async()=>{let admitted=false;try{
   const url=new URL('./async-question-publication-native-worker.ts',import.meta.url),pending=operation==='Prepare'?this.#slot.run(url,binding,this.#timeout,controller.signal):this.#slot.runControlCompletion(url,binding,this.#timeout,controller.signal);admitted=this.#slot.busy;
   let raw:unknown;try{raw=await pending;}finally{await this.#slot.join();}controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,QUESTION_PUBLICATION_BYTES)===null||raw===null||typeof raw!=='object'||Object.keys(raw).length!==Object.keys(binding).length+2)throw new TypeError('Invalid question publication acknowledgement');
   for(const [key,value]of Object.entries(binding))if(!Object.is(own(raw,key),value))throw new TypeError('Crossed question publication acknowledgement');
   if(own(raw,'ok')!==true||typeof own(raw,'value')!=='boolean'||(operation!=='Prepare'&&own(raw,'value')!==true))throw new TypeError('Question publication acknowledgement unavailable');return own(raw,'value') as boolean;
  }catch(error){if(admitted){this.#uncertain=true;throw new NativeQuestionPublicationUnconfirmedError(operation,error);}throw error;}finally{signal?.removeEventListener('abort',abort);}})();
  this.#task=task;const clear=()=>{this.#task=null;this.#controller=null;this.#operation=null;};void task.then(clear,clear);return task;
 }
 /** Stop new work and cancel preparation, but retain an already accepted outcome
  * through its uncancelled bind/error completion and actual worker exit. */
 async close(reason:unknown=new Error('Question publication owner closed')):Promise<void>{this.#closed=true;if(this.#operation==='Prepare')this.#controller?.abort(reason);if(this.#task!==null)await Promise.allSettled([this.#task]);}
}
Object.freeze(NativeQuestionPublicationOwner.prototype);
