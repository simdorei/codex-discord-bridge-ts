import {types} from 'node:util';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {StoreIntegrityError} from '../../store/schema-assembly.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
export interface MessageCustodyOptions {
 readonly now?:()=>number;
 readonly report:(value:{readonly code:'message_custody_hold_error';readonly requestId:string;readonly error:unknown})=>void;
}
/** Owner of an already durably admitted message. Not an admission permit. Await
 * dispose on every path; it joins in-flight transitions before source Drop hold.
 * Actual state reads/writes remain exclusively in StateAccessFacade. */
export class MessageCustody {
 readonly #database:string;readonly #key:string;readonly #now:()=>number;readonly #report:MessageCustodyOptions['report'];
 #started=false;#finished=false;#closing=false;#pending:Promise<unknown>|null=null;#disposal:Promise<void>|null=null;
 constructor(database:string,key:string,options:MessageCustodyOptions){
  requireDiscordText(database);requireDiscordText(key);const report=gatewayOwnField(options,'report');
  if(options===null||typeof options!=='object'||types.isProxy(options))throw new TypeError('Expected message custody options');
  const d=Object.getOwnPropertyDescriptor(options,'now');if(d!==undefined&&!Object.hasOwn(d,'value'))throw new TypeError('Expected own custody clock');const now=d===undefined||d.value===undefined?systemNow:d.value;
  for(const fn of [now,report])if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected synchronous custody clock/reporter');
  this.#database=database;this.#key=key;this.#now=now;this.#report=report as MessageCustodyOptions['report'];Object.freeze(this);
 }
 #operation(run:()=>Promise<void>):Promise<void>{
  if(this.#closing||this.#pending!==null)throw new TypeError('Message custody is closed or already borrowed');
  const pending=Promise.resolve().then(run).finally(()=>{this.#pending=null;});this.#pending=pending;return pending;
 }
 begin(target:string|null):Promise<void>{
  if(target!==null)requireDiscordText(target);return this.#operation(async()=>{
   if(!await state.beginIngressExecution(this.#database,this.#key,'processing',target,readCustodyTimestamp(this.#now)))throw new StoreIntegrityError('message custody is no longer executable');
   this.#started=true;
  });
 }
 finish():Promise<void>{return this.#operation(async()=>{await state.confirmIngress(this.#database,this.#key,readCustodyTimestamp(this.#now));this.#finished=true;});}
 dispose():Promise<void>{
  if(this.#disposal!==null)return this.#disposal;this.#closing=true;const pending=this.#pending;
  this.#disposal=(async()=>{
   if(pending!==null){try{await pending;}catch{/* Original caller retains transition failure. */}}
   if(this.#finished)return;
   try{await state.holdIngress(this.#database,this.#key,'message processing ended before a durable handoff or confirmed response',!this.#started,readCustodyTimestamp(this.#now));}
   catch(error){invokeSynchronousVoid(this.#report,{},[Object.freeze({code:'message_custody_hold_error',requestId:this.#key,error})]);}
  })();return this.#disposal;
 }
}
Object.freeze(MessageCustody.prototype);
