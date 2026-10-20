import {newStateFunction,newStatePromise} from './new-state-call.ts';
import {types} from 'node:util';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import type {StoredIngress} from '../../store/ingress-read.ts';
import {NewThreadJournal} from './new-journal.ts';
import {InvalidActionRequestError} from './errors.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
export type NewAttemptState=Pick<typeof state,'getIngress'|'holdIngress'|'beginIngressThreadStart'>;
function captureAttemptState(port:NewAttemptState):NewAttemptState {return Object.freeze({getIngress:newStateFunction(port,'getIngress'),holdIngress:newStateFunction(port,'holdIngress'),beginIngressThreadStart:newStateFunction(port,'beginIngressThreadStart')});}
export interface NewAttemptReport {readonly code:'new_thread_attempt_hold_error';readonly ingressId:string;readonly error:unknown}
const token=Symbol('NewThreadAttempt');
/** Only a successful begin owns this guard. Disposal joins its running operation
 * before inspecting durable prompt ownership; duplicates never hold a winner. */
export class NewThreadAttempt {
 readonly #state:NewAttemptState;
 readonly #database:string;readonly #key:string;readonly #now:()=>number;readonly #report:(value:NewAttemptReport)=>void;
 #pending:Promise<unknown>|null=null;#closing=false;#used=false;#dispose:Promise<void>|null=null;
 constructor(secret:symbol,database:string,key:string,now:()=>number,report:(value:NewAttemptReport)=>void,port:NewAttemptState=state){if(secret!==token)throw new TypeError('Expected won new-thread attempt');this.#state=captureAttemptState(port);this.#database=database;this.#key=key;this.#now=now;this.#report=report;Object.freeze(this);}
 run<T>(work:()=>Promise<T>):Promise<T>{
  if(this.#closing||this.#used)throw new TypeError('New-thread attempt already used or closed');
  if(typeof work!=='function'||types.isProxy(work)||types.isGeneratorFunction(work))throw new TypeError('Expected owned asynchronous work');
  this.#used=true;const pending=Promise.resolve().then(()=>{const result=work();if(!types.isPromise(result))throw new TypeError('Expected native new-thread Promise');return result;});this.#pending=pending;return pending;
 }
 dispose():Promise<void>{
  if(this.#dispose!==null)return this.#dispose;this.#closing=true;const pending=this.#pending;
  this.#dispose=(async()=>{if(pending!==null)try{await pending;}catch{/* owner receives original work failure */}
   try{const saved=await newStatePromise(Reflect.apply(this.#state.getIngress,undefined,[this.#database,this.#key]));if(saved!==null&&saved.state==='executing'&&saved.ownerId===null)await newStatePromise(Reflect.apply(this.#state.holdIngress,undefined,[this.#database,this.#key,'new-thread attempt ended before durable prompt ownership; automatic recreation is disabled',false,readCustodyTimestamp(this.#now)]));}
   catch(error){invokeSynchronousVoid(this.#report,{},[Object.freeze({code:'new_thread_attempt_hold_error',ingressId:this.#key,error})]);}
  })();return this.#dispose;
 }
}
Object.freeze(NewThreadAttempt.prototype);
export async function beginNewThreadAttempt(database:string,journal:NewThreadJournal,record:StoredIngress,generation:bigint,report:(value:NewAttemptReport)=>void,now:()=>number=systemNow,signal?:AbortSignal,port:NewAttemptState=state):Promise<NewThreadAttempt>{
 NewThreadJournal.prototype.requireDatabase.call(journal,database);NewThreadJournal.prototype.requireOriginalRecord.call(journal,record);
 for(const fn of [report,now])if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected synchronous attempt callback');
 signal?.throwIfAborted();const key=record.ingressId,captured=captureAttemptState(port);
 if(!await newStatePromise(Reflect.apply(captured.beginIngressThreadStart,undefined,[database,key,generation,readCustodyTimestamp(now)])))throw new InvalidActionRequestError(`thread/start was already attempted for request ${key}; its existing state is preserved and no duplicate was started`);
 const attempt=new NewThreadAttempt(token,database,key,now,report,captured);
 if(signal?.aborted){await attempt.dispose();throw signal.reason;}return attempt;
}
