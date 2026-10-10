import {types} from 'node:util';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {snapshotNewPromptIntake,type NewPromptIntake,type PromptIntakeAdmission} from '../../store/prompt-intake-write.ts';
import type {StoredIngress} from '../../store/ingress-read.ts';
import {newCommandPrompt} from '../../store/ingress-new-input.ts';
import {StoreIntegrityError} from '../../store/schema-assembly.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
import {requestEcho} from './submission-result.ts';
import {NewThreadJournal} from './new-journal.ts';
import {InvalidActionRequestError} from './errors.ts';
/** Durable first-prompt/first-reply composition. Transport delivery remains the
 * existing outbox/interaction worker; a stored turn is required before notifying. */
export class NewFirstReply {
 readonly #database:string;readonly #statePath:string;readonly #journal:NewThreadJournal;readonly #mirrored:boolean;readonly #notify:()=>void;
 constructor(database:string,statePath:string,journal:NewThreadJournal,mirrored:boolean,notify:()=>void){requireDiscordText(database);requireDiscordText(statePath);NewThreadJournal.prototype.requireDatabase.call(journal,database);if(typeof mirrored!=='boolean')throw new TypeError('Expected mirror mode');if(typeof notify!=='function'||types.isProxy(notify)||types.isAsyncFunction(notify)||types.isGeneratorFunction(notify))throw new TypeError('Expected synchronous delivery notifier');this.#database=database;this.#statePath=statePath;this.#journal=journal;this.#mirrored=mirrored;this.#notify=notify;Object.freeze(this);}
 admit(input:NewPromptIntake,ingress:StoredIngress,generation:bigint):Promise<PromptIntakeAdmission>{
  NewThreadJournal.prototype.requireOriginalRecord.call(this.#journal,ingress);const request=snapshotNewPromptIntake(input),prompt=newCommandPrompt(ingress);if(prompt===null)throw new StoreIntegrityError('new acknowledgement has no original prompt');
  const acknowledgement=`In progress\nmessage: ${requestEcho(prompt)}\n새 대화: <#${request.channelId}>`;
  // Existing storage adapter takes a native-path DTO. Valid scalar POSIX text
  // has the same persisted text through this UTF-16 representation.
  const seed=this.#mirrored?{stateDb:{platform:'windows-utf16' as const,units:Array.from({length:this.#statePath.length},(_,i)=>this.#statePath.charCodeAt(i))},acknowledgement}:null;
  return state.admitPromptIntakeWithIngress(this.#database,request,ingress.ingressId,generation,seed);
 }
 async finish(ingress:StoredIngress,input:ActionResult):Promise<ActionResult>{
  NewThreadJournal.prototype.requireOriginalRecord.call(this.#journal,ingress);const result=snapshotActionResult(input);if(!this.#mirrored)return result;
  const record=await state.getNewReplyByIngress(this.#database,ingress.ingressId);if(record===null)throw new InvalidActionRequestError('new request has no durable first-reply intent; existing execution is preserved for review');
  await state.validateNewReplyCurrent(this.#database,record.identity.job_id);
  if(record.turnId===null)throw new InvalidActionRequestError(`new first turn acceptance is not confirmed; request remains saved without replay: ${result.text}`);
  invokeSynchronousVoid(this.#notify,{},[]);return snapshotActionResult({text:record.identity.acknowledgement,waitsForFinal:true,ui:null});
 }
}
Object.freeze(NewFirstReply.prototype);
