import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {newCommandPrompt} from '../../store/ingress-new-input.ts';
import type {StoredIngress} from '../../store/ingress-read.ts';
import {snapshotStoredIngress, storedIngressEqual} from '../../store/ingress-snapshot.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {rustTrim} from '../../app-server/value.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {ActionIntegerRangeError, InvalidActionRequestError} from './errors.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
export interface NewActionContext {readonly channelId:bigint;readonly userId:bigint;readonly discordMessageId:bigint|null;readonly autoQueueWhenBusy:boolean}
function id(value:unknown):bigint {if(typeof value!=='bigint'||value<0n||value>=(1n<<63n))throw new ActionIntegerRangeError();return value;}
function context(input:NewActionContext):NewActionContext {
 const channelId=id(gatewayOwnField(input,'channelId')),userId=id(gatewayOwnField(input,'userId')),event=gatewayOwnField(input,'discordMessageId'),autoQueueWhenBusy=gatewayOwnField(input,'autoQueueWhenBusy');
 if(typeof autoQueueWhenBusy!=='boolean')throw new TypeError('Expected queue policy');
 return Object.freeze({channelId,userId,discordMessageId:event===null?null:id(event),autoQueueWhenBusy});
}
function validate(record:StoredIngress,scope:NewActionContext,prompt:string):void {
 if(record.channelId!==scope.channelId||record.ownerUserId!==scope.userId||record.eventId!==scope.discordMessageId||newCommandPrompt(record)!==prompt)throw new InvalidActionRequestError('this Discord request has a different original channel, user, command, or prompt');
}
/** Admission journal only: returned records never authorize thread/start. The
 * caller must separately win beginIngressThreadStart and freeze creation context. */
export class NewThreadJournal {
 readonly #database:string;readonly #now:()=>number;readonly #records=new WeakMap<object,StoredIngress>();
 #capture(record:StoredIngress):StoredIngress {const snapshot=snapshotStoredIngress(record);this.#records.set(snapshot,snapshotStoredIngress(record));return snapshot;}
 constructor(database:string,now:()=>number=systemNow){requireDiscordText(database);if(typeof now!=='function'||types.isProxy(now)||types.isAsyncFunction(now)||types.isGeneratorFunction(now))throw new TypeError('Expected synchronous journal clock');this.#database=database;this.#now=now;Object.freeze(this);}
 async admit(input:NewActionContext,prompt:string,signal?:AbortSignal):Promise<StoredIngress>{
  requireDiscordText(prompt);if(rustTrim(prompt)==='')throw new InvalidActionRequestError('new request prompt must not be blank');
  const scope=context(input);signal?.throwIfAborted();
  if(scope.discordMessageId!==null){const existing=await state.ingressByOrigin(this.#database,scope.discordMessageId);signal?.throwIfAborted();if(existing!==null){validate(existing,scope,prompt);return this.#capture(existing);}}
  const admission=await state.admitIngress(this.#database,{ingressId:'action:'+randomUUID(),kind:'action',eventId:scope.discordMessageId,applicationId:null,channelId:scope.channelId,ownerUserId:scope.userId,sourceMessageId:scope.discordMessageId,payload:{command:'new',prompt,context:{channel_id:scope.channelId,user_id:scope.userId,discord_message_id:scope.discordMessageId,auto_queue_when_busy:scope.autoQueueWhenBusy}},targetThreadId:null,canonicalOwner:null,now:readCustodyTimestamp(this.#now)});
  signal?.throwIfAborted();const record=admission.record;if(record===null)throw new InvalidActionRequestError('this Discord request was already processed; no new thread was created');
  validate(record,scope,prompt);return this.#capture(record);
 }
 async hold(ingress:StoredIngress,error:unknown,notExecuted:boolean):Promise<InvalidActionRequestError>{
  const record=this.#records.get(ingress);if(record===undefined||!storedIngressEqual(snapshotStoredIngress(ingress),record))throw new TypeError('Expected original journal admission record');
  if(typeof notExecuted!=='boolean')throw new TypeError('Expected execution status');
  let message=`request ${record.ingressId} is preserved for manual review; no automatic thread/start retry: ${passiveErrorText(error,'new-thread operation failed')}`;
  try{await state.holdIngress(this.#database,record.ingressId,'new-thread creation needs manual review; automatic recreation is disabled',notExecuted,readCustodyTimestamp(this.#now));}
  catch(recording){message+='; recording its manual hold also failed: '+passiveErrorText(recording,'hold recording failed');}
  return new InvalidActionRequestError(message);
 }
}
Object.freeze(NewThreadJournal.prototype);
