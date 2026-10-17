import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {parseComponentId,type ComponentId} from '../../discord/components.ts';
import {routedComponentCustomId} from '../../discord/interaction-routing.ts';
import {serdeValueEqual} from '../../core/serde-value-equal.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {asyncQuestionOccurrence,type StoredAsyncQuestion} from '../../store/async-question-read.ts';
import type {AsyncQuestionDispatchClaim} from '../../store/async-question-dispatch.ts';
import {takeUnicodeScalarChars} from '../../store/queue-preflight-failure.ts';
import {snapshotInboundInteractionWork,type InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
import {snapshotComponentId} from '../discord-dispatch/delivery-identity.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {captureAsyncChoiceClick,asyncChoiceBinding,parseAsyncChoiceQuestion,ASYNC_CHOICE_REQUEST_BYTES,ASYNC_CHOICE_REPLY_BYTES,type AsyncChoiceClick,type AsyncChoiceOperation} from './async-choice-native-snapshot.ts';
export interface NativeAsyncChoiceHandle{readonly questionId:string}
type Held={readonly click:AsyncChoiceClick;question:StoredAsyncQuestion|null;phase:'Reading'|'Beginning'|'Claimed'|'Finishing'|'Finished'|'Unknown'};
export class NativeAsyncChoiceUnknownError extends Error{
 readonly operation:AsyncChoiceOperation;readonly click:AsyncChoiceClick;readonly question:StoredAsyncQuestion|null;
 constructor(operation:AsyncChoiceOperation,held:Held,cause:unknown){super('AsyncChoice mutation result unconfirmed after native exit; no answer or automatic replay',{cause});this.name='NativeAsyncChoiceUnknownError';this.operation=operation;this.click=held.click;this.question=held.question;Object.freeze(this);}
}
export class NativeAsyncChoiceReadError extends Error{constructor(cause:unknown){super('AsyncChoice native read unavailable after join',{cause});this.name='NativeAsyncChoiceReadError';}}
function signalCheck(signal:AbortSignal|undefined):void{if(signal!==undefined){if(types.isProxy(signal)||Object.getPrototypeOf(signal)!==AbortSignal.prototype||['throwIfAborted','aborted','reason','addEventListener','removeEventListener'].some(key=>Object.hasOwn(signal,key)))throw new TypeError('Expected unmodified native AbortSignal');AbortSignal.prototype.throwIfAborted.call(signal);}}
function sameClick(a:AsyncChoiceClick,b:AsyncChoiceClick):boolean{return a.applicationId===b.applicationId&&a.actorId===b.actorId&&a.channelId===b.channelId&&a.sourceMessageId===b.sourceMessageId&&a.customId===b.customId;}
/** One executor owns all AsyncChoice work. Private handles bind the immutable
 * original click and occurrence, never an ACK-created action capability. Reads
 * and Begin have zero queue; owned completions use the finite Control FIFO. A
 * mutation with no exact joined ACK blocks fresh mutations across this owner.
 * Already-owned completions still settle their exact original outcome without
 * clearing another question's barrier. Explicit same-question/same-option
 * recovery only reads submitted state. This
 * runtime-local barrier is deliberately not crash/restart reconciliation. */
export class NativeAsyncChoiceOwner{
 readonly #path:string;readonly #timeout:number;readonly #handles=new WeakMap<object,Held>();readonly #tasks=new Set<Promise<unknown>>();readonly #controllers=new Set<AbortController>();#closed=false;#unresolved:NativeAsyncChoiceUnknownError|undefined;
 constructor(path:string,timeoutMs=5000){requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid AsyncChoice path');this.#path=pinNativeRuntimePath(path);if(Buffer.byteLength(this.#path)>32768)throw new RangeError('AsyncChoice path exceeds native budget');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid AsyncChoice deadline');this.#timeout=timeoutMs;Object.freeze(this);}
 get busy():boolean{return this.#tasks.size>0;}
 requireDatabase(path:string):void{requireDiscordText(path);if(pinNativeRuntimePath(path)!==this.#path)throw new TypeError('AsyncChoice owner belongs to another database');}
 capture(input:InboundInteractionWork,inputComponent:ComponentId):NativeAsyncChoiceHandle{
  if(this.#closed)throw new Error('AsyncChoice owner closed');const work=snapshotInboundInteractionWork(input),component=snapshotComponentId(inputComponent),customId=routedComponentCustomId(work.work);
  if(pinNativeRuntimePath(work.custodyDatabase)!==this.#path||!('Component'in work.work)||!serdeValueEqual(component,work.work.Component)||!serdeValueEqual(component,parseComponentId(customId)))throw new TypeError('Crossed original AsyncChoice work');
  const click=captureAsyncChoiceClick({interactionIngressId:work.custodyIngressId,interactionId:work.interactionId,applicationId:work.applicationId,actorId:work.userId,channelId:work.channelId,sourceMessageId:work.sourceMessageId,customId,processingMode:work.processingMode});
  if(this.#unresolved!==undefined&&!sameClick(this.#unresolved.click,click))throw this.#unresolved;
  const handle=Object.freeze({questionId:click.questionId});this.#handles.set(handle,{click,question:this.#unresolved?.question??null,phase:'Reading'});return handle;
 }
 #held(handle:NativeAsyncChoiceHandle):Held{const held=this.#handles.get(handle);if(held===undefined)throw new TypeError('Expected original private AsyncChoice handle');return held;}
 async get(handle:NativeAsyncChoiceHandle,signal?:AbortSignal):Promise<StoredAsyncQuestion>{const held=this.#held(handle);if(held.phase!=='Reading')throw new TypeError('Question is already claimed');const value=await this.#run('Get',held,null,null,signal);try{const q=parseAsyncChoiceQuestion(value as string);if(q.id!==held.click.questionId||(held.question!==null&&asyncQuestionOccurrence(q)!==asyncQuestionOccurrence(held.question)))throw new TypeError('Crossed original question read');held.question??=q;return q;}catch(error){throw new NativeAsyncChoiceReadError(error);}}
 mapping(handle:NativeAsyncChoiceHandle,signal?:AbortSignal):Promise<void>{const held=this.#held(handle);if(held.phase!=='Reading'&&held.phase!=='Claimed')throw new TypeError('Question mapping is not available');return this.#boolean('Mapping',held,null,signal);}
 /** A same-original retry after uncertainty can only obtain confirmation. */
 requireExecutable(handle:NativeAsyncChoiceHandle):void{const held=this.#held(handle);if(this.#unresolved!==undefined)throw this.#unresolved;if(held.phase!=='Reading'||held.click.processingMode!=='Execute')throw new TypeError('Question is not executable');}
 async begin(handle:NativeAsyncChoiceHandle,claim:AsyncQuestionDispatchClaim,signal?:AbortSignal):Promise<void>{
  const held=this.#held(handle);NativeAsyncChoiceOwner.prototype.requireExecutable.call(this,handle);held.phase='Beginning';
  try{const raw=await this.#run('Begin',held,serializeSerdeValue(claim),null,signal);try{const q=parseAsyncChoiceQuestion(raw as string);if(held.question===null||asyncQuestionOccurrence(q)!==asyncQuestionOccurrence(held.question)||q.state!=='dispatching'||q.chosen!==held.click.option)throw new TypeError('Invalid dispatch claim result');}catch(error){throw this.#unknown('Begin',held,error);}held.phase='Claimed';}
  catch(error){held.phase=error instanceof NativeAsyncChoiceUnknownError?'Unknown':'Reading';throw error;}
 }
 guard(handle:NativeAsyncChoiceHandle,signal?:AbortSignal):Promise<void>{const held=this.#held(handle);if(held.phase!=='Claimed')throw new TypeError('Expected claimed question');if(this.#unresolved!==undefined)throw this.#unresolved;return this.#boolean('Guard',held,null,signal);}
 confirm(handle:NativeAsyncChoiceHandle,turn:string):Promise<void>{requireDiscordText(turn);return this.#finish('Confirm',handle,turn);}
 reject(handle:NativeAsyncChoiceHandle,error:string):Promise<void>{requireDiscordText(error);return this.#finish('Reject',handle,takeUnicodeScalarChars(error,1000));}
 error(handle:NativeAsyncChoiceHandle,error:string):Promise<void>{requireDiscordText(error);return this.#finish('Error',handle,takeUnicodeScalarChars(error,1000));}
 #finish(operation:'Confirm'|'Reject'|'Error',handle:NativeAsyncChoiceHandle,detail:string):Promise<void>{
  const held=this.#held(handle);if(held.phase!=='Claimed')throw new TypeError('Expected unfinished original AsyncChoice claim');held.phase='Finishing';
  let task:Promise<void>;try{task=this.#boolean(operation,held,detail);}catch(error){held.phase='Claimed';throw error;}
  return task.then(()=>{held.phase='Finished';},error=>{held.phase=error instanceof NativeAsyncChoiceUnknownError?'Unknown':'Claimed';throw error;});
 }
 async #boolean(operation:AsyncChoiceOperation,held:Held,detail:string|null,signal?:AbortSignal):Promise<void>{const value=await this.#run(operation,held,null,detail,signal);if(value!==true){const error=new TypeError('Invalid AsyncChoice operation result');if(operation==='Confirm'||operation==='Reject'||operation==='Error')throw this.#unknown(operation,held,error);throw new NativeAsyncChoiceReadError(error);}}
 #unknown(operation:AsyncChoiceOperation,held:Held,cause:unknown):NativeAsyncChoiceUnknownError{const error=new NativeAsyncChoiceUnknownError(operation,held,cause);this.#unresolved??=error;return error;}
 #run(operation:AsyncChoiceOperation,held:Held,claimJson:string|null,detail:string|null,signal?:AbortSignal):Promise<unknown>{
  signalCheck(signal);if(this.#closed)throw new Error('AsyncChoice owner closed');const completion=operation==='Confirm'||operation==='Reject'||operation==='Error';if(!completion&&this.#tasks.size>0)throw new OwnedWorkerBusyError();if(process.platform==='win32')throw new Error('Windows AsyncChoice owner unqualified');
  const binding=asyncChoiceBinding(randomUUID(),this.#path,operation,held.click,held.question===null?null:serializeSerdeValue(held.question),claimJson,detail);if(boundedSerdeByteCount(binding,ASYNC_CHOICE_REQUEST_BYTES)===null)throw new RangeError('AsyncChoice exceeds native budget');
  const slot=new OwnedWorkerSlot('Control'),controller=new AbortController(),abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();this.#controllers.add(controller);
  const task=(async()=>{let admitted=false;try{
   const url=new URL('./async-choice-native-worker.ts',import.meta.url),pending=completion?slot.runControlCompletion(url,binding,this.#timeout,controller.signal):slot.run(url,binding,this.#timeout,controller.signal);admitted=slot.busy;
   let raw:unknown;try{raw=await pending;}finally{await slot.join();}controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,ASYNC_CHOICE_REPLY_BYTES)===null||raw===null||typeof raw!=='object'||Object.keys(raw).length!==Object.keys(binding).length+2)throw new TypeError('Invalid AsyncChoice acknowledgement');
   for(const [key,value]of Object.entries(binding))if(!Object.is(own(raw,key),value))throw new TypeError('Crossed AsyncChoice acknowledgement');
   if(own(raw,'ok')!==true)throw new TypeError('AsyncChoice acknowledgement unavailable');return own(raw,'value');
  }catch(error){if(admitted&&(operation==='Begin'||completion))throw this.#unknown(operation,held,error);if(admitted)throw new NativeAsyncChoiceReadError(error);throw error;}finally{signal?.removeEventListener('abort',abort);}})();
  this.#tasks.add(task);const clear=()=>{this.#tasks.delete(task);this.#controllers.delete(controller);};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('AsyncChoice owner closed')):Promise<void>{this.#closed=true;for(const controller of this.#controllers)controller.abort(reason);await Promise.allSettled([...this.#tasks]);}
}
Object.freeze(NativeAsyncChoiceOwner.prototype);
