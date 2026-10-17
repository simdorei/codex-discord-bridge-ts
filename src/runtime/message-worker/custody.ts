import {NativeAbandonmentProposalOwner} from './abandonment-proposal-native.ts';
import type {DecodedGatewayMessage} from '../../discord/gateway/decoded-message.ts';
import {AdmissionPermit} from '../../admission/drain-gate.ts';
import type {DiscordChannelClient} from '../../discord/channel-client.ts';
import type {ControlTurnVerifier} from '../action-executor/control-turn.ts';
import {types} from 'node:util';
import {captureNewInput} from '../../store/ingress-new-input.ts';
import {captureIngressResult} from '../../store/ingress-lifecycle.ts';
import {captureMessageJournal,captureMessageJournalContext,requireMessageJournalBinding,OriginalMessageJournal,type MessageJournal,type MessageJournalEffects} from './journal.ts';
import {StoreIntegrityError} from '../../store/schema-assembly.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
export interface MessageCustodyOptions {
 readonly now?:()=>number;readonly messageJournal?:MessageJournal|undefined;
 readonly report:(value:{readonly code:'message_custody_hold_error';readonly requestId:string;readonly error:unknown})=>void;
}
export function captureMessageCustodyOptions(database:string,options:MessageCustodyOptions):MessageCustodyOptions{
 requireDiscordText(database);const report=gatewayOwnField(options,'report');
 if(options===null||typeof options!=='object'||types.isProxy(options))throw new TypeError('Expected message custody options');
 const d=Object.getOwnPropertyDescriptor(options,'now');if(d!==undefined&&!Object.hasOwn(d,'value'))throw new TypeError('Expected own custody clock');const now=d===undefined||d.value===undefined?systemNow:d.value;
 for(const fn of [now,report])if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected synchronous custody clock/reporter');
 return Object.freeze({now,report:report as MessageCustodyOptions['report'],messageJournal:captureMessageJournal(database,captureMessageJournalContext(database,options))});
}
/** Original admitted message owner. Disposal joins every native transition and
 * required hold before its outer admission permit can be released. */
export class MessageCustody {
 readonly #database:string;readonly #key:string;readonly #now:()=>number;readonly #report:MessageCustodyOptions['report'];readonly #journal:MessageJournal;readonly #owner:OriginalMessageJournal|undefined;
 #abandonment:NativeAbandonmentProposalOwner|null=null;#started=false;#finished=false;#closing=false;#pending:Promise<unknown>|null=null;#disposal:Promise<void>|null=null;
 constructor(database:string,key:string,options:MessageCustodyOptions,owner?:OriginalMessageJournal){
  requireDiscordText(key);const captured=captureMessageCustodyOptions(database,options);if(owner!==undefined)OriginalMessageJournal.prototype.require.call(owner,database,key,captured.messageJournal!);
  this.#database=database;this.#key=key;this.#now=captured.now!;this.#report=captured.report;this.#journal=captured.messageJournal!;this.#owner=owner;Object.freeze(this);
 }
 /** A native proposal is minted only by this created-admission custody. The
  * journal profile is private provenance, never a caller-supplied native flag. */
 nativeAbandonment(message:DecodedGatewayMessage,job:string,application:bigint,permit:AdmissionPermit|null,http:DiscordChannelClient,verifier:ControlTurnVerifier,signal?:AbortSignal):Promise<void>|null{
  if(this.#owner===undefined||OriginalMessageJournal.prototype.nativePath.call(this.#owner,this.#database,this.#key)===null)return null;
  if(!this.#started||this.#closing||this.#pending!==null||this.#finished||this.#abandonment!==null)throw new TypeError('Original proposal custody is unavailable or already consumed');
  const owner=new NativeAbandonmentProposalOwner(this.#owner,this.#database,message,job,application);
  if(permit===null)throw new TypeError('Proposal requires live normal admission');const retained=AdmissionPermit.prototype.clone.call(permit);this.#abandonment=owner;
  return this.#operation(async()=>{try{await owner.run(retained,http,verifier,this.#now,signal);this.#finished=true;}finally{AdmissionPermit.prototype.release.call(retained);}});
 }
 persistence():MessageJournalEffects{
  const check=(path:string,key:string)=>{if(path!==this.#database||key!==this.#key)throw new TypeError('Persistence differs from original message custody');};
  return Object.freeze({recordIngressResult:(path,key,input,now)=>{check(path,key);return MessageCustody.prototype.record.call(this,input,now);},holdIngress:(path,key,reason,notExecuted,now)=>{check(path,key);return MessageCustody.prototype.hold.call(this,reason,notExecuted,now);}});
 }
 hold(reason:string,notExecuted:boolean,now:number):Promise<void>{
  requireDiscordText(reason);if(typeof notExecuted!=='boolean'||typeof now!=='number')throw new TypeError('Expected hold fields');return this.#operation(()=>this.#persistHold(reason,notExecuted,now));
 }
 #persistHold(reason:string,notExecuted:boolean,now:number):Promise<void>{return this.#owner===undefined?this.#journal.holdIngress(this.#database,this.#key,reason,notExecuted,now):OriginalMessageJournal.prototype.hold.call(this.#owner,reason,notExecuted,now);}
 requireJournal(port:MessageJournal):void{requireMessageJournalBinding(this.#database,port,this.#journal);}
 #operation(run:()=>Promise<void>):Promise<void>{
  if(this.#closing||this.#pending!==null)throw new TypeError('Message custody is closed or already borrowed');
  const pending=Promise.resolve().then(run).finally(()=>{this.#pending=null;});this.#pending=pending;return pending;
 }
 mode(mode:string):Promise<void>{
  requireDiscordText(mode);return this.#operation(()=>this.#owner===undefined?this.#journal.recordIngressProcessingMode(this.#database,this.#key,mode):OriginalMessageJournal.prototype.mode.call(this.#owner,mode));
 }
 begin(target:string|null):Promise<void>{
  if(target!==null)requireDiscordText(target);const now=readCustodyTimestamp(this.#now);return this.#operation(async()=>{
   const won=await (this.#owner===undefined?this.#journal.beginIngressExecution(this.#database,this.#key,'processing',target,now):OriginalMessageJournal.prototype.begin.call(this.#owner,target,now));
   if(!won)throw new StoreIntegrityError('message custody is no longer executable');this.#started=true;
  });
 }
 newInput(raw:string,prompt:string,now:number):Promise<void>{
  const q=captureNewInput(this.#key,raw,prompt,now);return this.#operation(()=>this.#owner===undefined?this.#journal.recordNewInput(this.#database,this.#key,q.raw,q.prompt,q.now):OriginalMessageJournal.prototype.newInput.call(this.#owner,q.raw,q.prompt,q.now));
 }
 record(input:unknown,now:number):Promise<void>{
  const q=captureIngressResult(this.#key,input,now);return this.#operation(()=>this.#owner===undefined?this.#journal.recordIngressResult(this.#database,this.#key,q.outcome,q.now):OriginalMessageJournal.prototype.result.call(this.#owner,q.outcome,q.now));
 }
 finish():Promise<void>{const now=readCustodyTimestamp(this.#now);return this.#operation(async()=>{await (this.#owner===undefined?this.#journal.confirmIngress(this.#database,this.#key,now):OriginalMessageJournal.prototype.confirm.call(this.#owner,now));this.#finished=true;});}
 dispose():Promise<void>{
  if(this.#disposal!==null)return this.#disposal;this.#closing=true;const pending=this.#pending;
  this.#disposal=(async()=>{
   if(pending!==null){try{await pending;}catch{/* Original caller retains transition failure. */}}
   if(this.#finished)return;
   try{const reason='message processing ended before a durable handoff or confirmed response',now=readCustodyTimestamp(this.#now);await this.#persistHold(reason,!this.#started,now);}
   catch(error){invokeSynchronousVoid(this.#report,{},[Object.freeze({code:'message_custody_hold_error',requestId:this.#key,error})]);}
  })();return this.#disposal;
 }
}
Object.freeze(MessageCustody.prototype);
