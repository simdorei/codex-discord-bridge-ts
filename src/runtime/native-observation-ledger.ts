import type {NewAsyncQuestion} from "../store/async-question-observation.ts";
import {types} from 'node:util';
import {requireDiscordText} from '../discord/text.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {scope as cloneScope,integer,cloneObservationGap,type ObservationScope,type ObservationGap} from '../store/observation-gap-model.ts';
import type {ObservationEffect} from '../store/observation-proof.ts';
import {IdleObservationError} from '../app-server/notification-state.ts';
import {pinNativeRuntimePath} from './runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from './owned-worker-slot.ts';

const MAX_BYTES=1048576;
const MAX_QUESTION_BYTES=4*MAX_BYTES;
function bounded<T>(value:T,limit=MAX_BYTES):T {
 if(boundedSerdeByteCount(value,limit)===null)throw new TypeError('Observation request exceeds native boundary');
 return cloneOwnedSerdeValue(value) as T;
}
function scope(input:ObservationScope):ObservationScope {
 const s=cloneScope(bounded(input));
 if(s.ownerId.length===0||Buffer.byteLength(s.ownerId)>4096||s.ownerId.includes('\0')||s.generation<0n)throw new TypeError('Invalid native observation scope');
 return s;
}
function same(a:ObservationScope,b:ObservationScope):boolean{return a.ownerId===b.ownerId&&a.generation===b.generation;}
function boolean(value:unknown):boolean{if(typeof value!=='boolean')throw new TypeError('Expected native observation boolean');return value;}
function nothing(value:unknown):void{if(value!==null)throw new TypeError('Expected native observation acknowledgement');}
export interface NativeObservationInspection{readonly gap:ObservationGap|null;readonly verified:boolean}
type Operation='activate'|'discover'|'unknown'|'next'|'inspect'|'certify'|'finish'|'verified'|'terminal'|'final'|'questions'|'prepareQuestions';

/** Closed existing-store ledger operations for the owned event producer.
 * Two concurrent intake/reconciler calls may occupy Observation lanes, never
 * Background or reserved Control. There is no hidden retry or unbounded pending queue.
 * Accepted failures may have committed: keep uncertainty until reconciliation.
 * Question journals, preparation and resident gap writes share bounded native ownership. */
export class NativeObservationLedgerOwner {
 readonly #path:string;readonly #timeout:number;
 readonly #tasks=new Set<Promise<unknown>>();readonly #controllers=new Set<AbortController>();#closed=false;#preparing=false;
 constructor(path:string,timeoutMs=5000){
  requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid observation database path');
  this.#path=pinNativeRuntimePath(path);
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Expected bounded observation deadline');
  this.#timeout=timeoutMs;
 }
 get busy():boolean{return this.#tasks.size!==0;}
 activate(input:ObservationScope,signal?:AbortSignal):Promise<void>{return this.#run('activate',{scope:scope(input)},nothing,signal);}
 discover(input:ObservationScope,upper:bigint,signal?:AbortSignal):Promise<void>{integer(upper);return this.#run('discover',{scope:scope(input),upper},nothing,signal);}
 markUnknown(input:ObservationScope,detail:string,signal?:AbortSignal):Promise<void>{
  requireDiscordText(detail);if(Buffer.byteLength(detail)>32768)throw new RangeError('Observation detail exceeds native boundary');
  return this.#run('unknown',{scope:scope(input),detail},nothing,signal);
 }
 /** Original gap persistence has finite admission priority over speculative reads. */
 discoverGap(input:ObservationScope,upper:bigint,signal?:AbortSignal):Promise<void>{integer(upper);return this.#run('discover',{scope:scope(input),upper},nothing,signal,true);}
 markUnknownGap(input:ObservationScope,detail:string,signal?:AbortSignal):Promise<void>{requireDiscordText(detail);if(Buffer.byteLength(detail)>32768)throw new RangeError('Observation detail exceeds native boundary');return this.#run('unknown',{scope:scope(input),detail},nothing,signal,true);}
 next(input:ObservationScope,signal?:AbortSignal):Promise<ObservationGap|null>{
  const expected=scope(input);return this.#run('next',{scope:expected},value=>{
   if(value===null)return null;const gap=cloneObservationGap(value as ObservationGap);
   if(!same(gap.scope,expected)||gap.verified.length>4096)throw new TypeError('Native observation gap changed original scope');
   return gap;
  },signal);
 }
 /** One bounded worker for the ordered discovery/read/proof pass. Transactions
  * stay separate; any gap still requires original event certification. */
 inspect(input:ObservationScope,upper:bigint,signal?:AbortSignal):Promise<NativeObservationInspection>{
  const expected=scope(input);integer(upper);return this.#run('inspect',{scope:expected,upper},value=>{
   if(!same(scope(own(value,'scope') as ObservationScope),expected)||own(value,'upper')!==upper)throw new TypeError('Native observation inspection changed original scope');
   const raw=own(value,'gap'),gap=raw===null?null:cloneObservationGap(raw as ObservationGap),verified=boolean(own(value,'verified'));
   if(gap!==null&&(!same(gap.scope,expected)||gap.verified.length>4096||verified))throw new TypeError('Native observation inspection returned unconfirmed proof');
   return {gap,verified};
  },signal);
 }
 /** Effects are produced by the internal event classifier; not external permission claims. */
 certify(input:ObservationScope,sequence:bigint,effects:readonly ObservationEffect[],signal?:AbortSignal):Promise<boolean>{
  const s=scope(input);integer(sequence);const snapshot=bounded(effects,MAX_QUESTION_BYTES);
  if(!Array.isArray(snapshot)||snapshot.length>32)throw new RangeError('Observation effect count exceeds native boundary');
  const limit=snapshot.every(e=>own(e,'kind')==='Question')?MAX_QUESTION_BYTES:MAX_BYTES;
  return this.#run('certify',{scope:s,sequence,effects:snapshot},boolean,signal,false,limit);
 }
 finish(input:ObservationGap,through:bigint,signal?:AbortSignal):Promise<boolean>{
  const gap=cloneObservationGap(bounded(input));scope(gap.scope);integer(through);
  if(gap.verified.length>4096)throw new RangeError('Observation span count exceeds native boundary');
  return this.#run('finish',{gap,through},boolean,signal);
 }
 verified(input:ObservationScope,through:bigint,signal?:AbortSignal):Promise<boolean>{integer(through);return this.#run('verified',{scope:scope(input),through},boolean,signal);}
 /** Original live producer only; terminal proof and raw journal retain separate commits. */
 recordTerminal(thread:string,turn:string,generation:bigint,payload:string,resident:string,signal?:AbortSignal):Promise<boolean>{
  integer(generation);for(const value of [thread,turn,payload,resident])requireDiscordText(value);
  return this.#run('terminal',{thread,turn,generation,payload,resident},boolean,signal);
 }
 recordFinal(thread:string,turn:string,generation:bigint,content:string,signal?:AbortSignal):Promise<boolean>{
  integer(generation);for(const value of [thread,turn,content])requireDiscordText(value);
  return this.#run('final',{thread,turn,generation,content},boolean,signal);
 }
 /** One original live notification; each record retains its own transaction. */
 recordQuestions(runtime:string,generation:bigint,input:readonly NewAsyncQuestion[],signal?:AbortSignal):Promise<void>{
  requireDiscordText(runtime);integer(generation);const records=bounded(input,MAX_QUESTION_BYTES);
  if(!Array.isArray(records)||records.length===0)throw new TypeError('Expected original question records');const first=records[0]!;
  for(let i=0;i<records.length;i++){const q=records[i]!;if(q.runtime_id!==runtime||q.generation!==generation||q.thread_id!==first.thread_id||q.turn_id!==first.turn_id||q.item_id!==first.item_id||q.body.index!==BigInt(i)||q.now!==first.now)throw new TypeError('Question batch changed original identity or order');}
  return this.#run('questions',{runtime,generation,records},nothing,signal,false,MAX_QUESTION_BYTES);
 }
 /** Captured generation maintenance; caller retains original resident admission. */
 prepareQuestions(runtime:string,generation:bigint,signal?:AbortSignal):Promise<void>{
  requireDiscordText(runtime);integer(generation);return this.#run('prepareQuestions',{runtime,generation},nothing,signal);
 }
 #run<T>(operation:Operation,input:object,decode:(value:unknown)=>T,signal?:AbortSignal,completion=false,limit=MAX_BYTES):Promise<T>{
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');
  signal?.throwIfAborted();if(this.#closed)throw new Error('Native observation owner is closed');
  const maintenance=operation==='prepareQuestions';if(maintenance?this.#preparing:this.#tasks.size-(this.#preparing?1:0)>=2)throw new OwnedWorkerBusyError();
  const snapshot=bounded(input,limit),controller=new AbortController(),slot=new OwnedWorkerSlot(maintenance?'Background':'Observation');
  const abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  this.#controllers.add(controller);if(maintenance)this.#preparing=true;
  const task=(async()=>{let admitted=false;try{
   const run=completion?slot.runObservationCompletion.bind(slot):slot.run.bind(slot);
   const pending=run(new URL('./native-observation-ledger-worker.ts',import.meta.url),{path:this.#path,operation,...snapshot},this.#timeout,controller.signal);admitted=slot.busy;
   let raw:unknown;try{raw=await pending;}finally{await slot.join();}
   controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,MAX_BYTES)===null||own(raw,'ok')!==true)throw new Error('Observation result unavailable');
   return decode(own(raw,'value'));
  }catch(error){
   if(!admitted)throw error;
   throw new IdleObservationError('Native observation result unconfirmed; retain original scope uncertainty; no automatic retry');
  }finally{signal?.removeEventListener('abort',abort);}})();
  this.#tasks.add(task);const clear=()=>{this.#tasks.delete(task);this.#controllers.delete(controller);if(maintenance)this.#preparing=false;};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('Native observation owner closed')):Promise<void>{this.#closed=true;for(const c of this.#controllers)c.abort(reason);await Promise.allSettled([...this.#tasks]);}
}
Object.freeze(NativeObservationLedgerOwner.prototype);
