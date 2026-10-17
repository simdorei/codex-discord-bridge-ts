import {types} from 'node:util';
import {CompletionReady,COMPLETION_STATE_SLOTS,COMPLETION_HTTP_SLOTS,type ReadyStateWork,type AdmittedWork,type ReadyAdmission} from './ready.ts';
import type {CompletionEntry} from '../../../store/completion-metadata.ts';
import type {CompletionNotification} from './envelope.ts';
export type CompletionWorkOutcome={readonly ok:true}|{readonly ok:false;readonly error:unknown};
export type CompletionExecutionResult=
 |{readonly kind:'State';readonly target:string;readonly native:boolean;readonly wake:boolean;readonly outcome:CompletionWorkOutcome}
 |{readonly kind:'Http';readonly entry:CompletionEntry;readonly outcome:CompletionWorkOutcome};
export interface CompletionPreparation<P>{
 complete(signal:AbortSignal):Promise<{readonly permit:P;readonly needsNative:boolean}>;
 release():void;
}
export interface CompletionExecutionPorts<P>{
 prepare(work:ReadyStateWork<CompletionNotification>):ReadyAdmission<P>|null;
 /** Synchronous lease reservation followed by a joined existing-store native read. */
 prepareOwned?(work:ReadyStateWork<CompletionNotification>):CompletionPreparation<P>|null;
 state(work:ReadyStateWork<CompletionNotification>,permit:P,signal:AbortSignal):Promise<void>;
 http(entry:CompletionEntry,signal:AbortSignal):Promise<void>;
 prepareFailed(error:unknown):void;
}
interface Task{promise:Promise<void>;result:CompletionExecutionResult|null}
const target=(w:ReadyStateWork<CompletionNotification>)=>w.kind==='Live'?w.live.target:w.entry.target;
const wake=(w:ReadyStateWork<CompletionNotification>)=>w.kind==='Durable'||['turn/started','turn/completed','item/completed','thread/goal/updated'].includes(w.live.payload.notification.method);
/** Four state/three native/four HTTP lanes. An asynchronous selection reserves one
 * state place and the original target lease, but never strands a native-capacity
 * waiter in the fourth state lane. The actor retains the original ready envelope
 * until its exact classification is known; blocked native work stays in order. */
export class CompletionExecution<P>{
 readonly #notify:()=>void;readonly #ready:CompletionReady<CompletionNotification>;readonly #ports:CompletionExecutionPorts<P>;readonly #abort=new AbortController();
 readonly #targets=new Set<string>();readonly #channels=new Map<bigint,CompletionEntry>();readonly #states=new Set<Task>();readonly #http=new Set<Task>();
 #native=0;#closed=false;#closing:Promise<void>|null=null;#pumping=false;#launchTask:Promise<void>|null=null;#preparingTarget:string|null=null;#preparingRelease:(()=>void)|null=null;
 constructor(ready:CompletionReady<CompletionNotification>,ports:CompletionExecutionPorts<P>,notify:()=>void=()=>{}){this.#notify=notify;this.#ready=ready;this.#ports={...(ports.prepareOwned===undefined?{}:{prepareOwned:ports.prepareOwned.bind(ports)}),prepare:ports.prepare.bind(ports),state:ports.state.bind(ports),http:ports.http.bind(ports),prepareFailed:ports.prepareFailed.bind(ports)};}
 get stateCount():number{return this.#states.size+(this.#preparingTarget===null?0:1);}
 get httpCount():number{return this.#http.size;}
 get nativeCount():number{return this.#native;}
 activeTargets():ReadonlySet<string>{const result=new Set(this.#targets);if(this.#preparingTarget!==null)result.add(this.#preparingTarget);return result;}
 activeChannels():ReadonlyMap<bigint,CompletionEntry>{return new Map(this.#channels);}
 #begin():void{if(this.#closed)throw new TypeError('Completion execution closed');if(this.#pumping)throw new TypeError('Completion execution launch is not reentrant');this.#pumping=true;}
 #startState(chosen:AdmittedWork<CompletionNotification,P>,releaseSelected:()=>void,signal:AbortSignal=this.#abort.signal):void{
  const key=target(chosen.work);this.#targets.add(key);if(chosen.needsNative)this.#native++;
  const task:Task={promise:Promise.resolve(),result:null};
  task.promise=Promise.resolve().then(async()=>{
   let outcome:CompletionWorkOutcome={ok:true};try{signal.throwIfAborted();await this.#ports.state(chosen.work,chosen.permit,signal);}catch(error){outcome={ok:false,error};}
   const errors:unknown[]=[];try{releaseSelected();}catch(error){errors.push(error);}try{if(chosen.work.kind==='Live')chosen.work.live.dispose();}catch(error){errors.push(error);}
   if(errors.length)outcome={ok:false,error:new AggregateError(outcome.ok?errors:[outcome.error,...errors],'Completion state cleanup failed')};
   task.result={kind:'State',target:key,native:chosen.needsNative,wake:wake(chosen.work),outcome};this.#notify();
  });this.#states.add(task);
 }
 #launchHttp(signal:AbortSignal=this.#abort.signal):void{
  while(this.#http.size<COMPLETION_HTTP_SLOTS){const entry=this.#ready.takeHttp(this.#channels);if(entry===null)break;this.#channels.set(entry.channel,entry);const task:Task={promise:Promise.resolve(),result:null};
   task.promise=Promise.resolve().then(async()=>{let outcome:CompletionWorkOutcome={ok:true};try{signal.throwIfAborted();await this.#ports.http(entry,signal);}catch(error){outcome={ok:false,error};}task.result={kind:'Http',entry,outcome};this.#notify();});this.#http.add(task);
  }
 }
 /** Compatibility profile remains wholly synchronous through admission. */
 launch():void{
  if(this.#ports.prepareOwned!==undefined)throw new TypeError('Owned preparation requires launchOwned');this.#begin();
  try{while(this.#states.size<COMPLETION_STATE_SLOTS){let release:(()=>void)|null=null;
   const chosen=this.#ready.takeStateAdmitted(this.#targets,this.#native,w=>{try{const a=this.#ports.prepare(w);if(a!==null)release=()=>a.release();return a;}catch(error){this.#ports.prepareFailed(error);return null;}});
   if(chosen===null)break;this.#startState(chosen,release!);
  }this.#launchHttp();}finally{this.#pumping=false;}
 }
 /** Only the scheduler actor calls this method. Incoming events remain in its
  * separate charged input queue during selection; already running IO proceeds. */
 launchOwned(signal?:AbortSignal):Promise<void>{
  const prepare=this.#ports.prepareOwned;if(prepare===undefined)throw new TypeError('Owned preparation unavailable');signal?.throwIfAborted();this.#begin();
  const cancel=signal===undefined?this.#abort.signal:AbortSignal.any([this.#abort.signal,signal]);
  const task=(async()=>{try{
   while(this.#states.size<COMPLETION_STATE_SLOTS){cancel.throwIfAborted();let releaseSelected:(()=>void)|null=null;
    const chosen=await this.#ready.takeStateAdmittedAsync(this.#targets,this.#native,async work=>{
     cancel.throwIfAborted();let transferred=false;
     try{
      const pending=prepare(work);if(types.isPromise(pending)){void Promise.prototype.then.call(pending,undefined,()=>undefined);throw new TypeError('Owned preparation must reserve synchronously');}if(pending===null)return null;
      const clear=()=>{try{pending.release();}finally{this.#preparingTarget=null;this.#preparingRelease=null;}};
      this.#preparingTarget=target(work);this.#preparingRelease=clear;
      const result=await pending.complete(cancel);cancel.throwIfAborted();if(typeof result.needsNative!=='boolean')throw new TypeError('Expected native classification');
      releaseSelected=()=>pending.release();transferred=true;return {permit:result.permit,needsNative:result.needsNative,release:clear};
     }catch(error){if(cancel.aborted)throw cancel.reason;this.#ports.prepareFailed(error);return null;}
     finally{if(!transferred)this.#preparingRelease?.();}
    });
    if(chosen===null)break;
    if(cancel.aborted){if(chosen.work.kind==='Live')chosen.work.live.dispose();throw cancel.reason;}
    // Transfer the SAME lease and ready envelope to the selected state task.
    this.#startState(chosen,releaseSelected!,cancel);this.#preparingTarget=null;this.#preparingRelease=null;
   }
   cancel.throwIfAborted();this.#launchHttp(cancel);
  }finally{try{this.#preparingRelease?.();}finally{this.#pumping=false;}}})();
  this.#launchTask=task;const clear=()=>{if(this.#launchTask===task)this.#launchTask=null;};void task.then(clear,clear);return task;
 }
 takeSettled():readonly CompletionExecutionResult[]{
  const results:CompletionExecutionResult[]=[];for(const task of this.#states){if(task.result===null)continue;const result=task.result;if(result.kind!=='State')throw new TypeError('Invalid state task result');this.#states.delete(task);this.#targets.delete(result.target);if(result.native)this.#native--;results.push(result);}
  for(const task of this.#http){if(task.result===null)continue;const result=task.result;if(result.kind!=='Http')throw new TypeError('Invalid HTTP task result');this.#http.delete(task);this.#channels.delete(result.entry.channel);results.push(result);}return Object.freeze(results);
 }
 close(reason:unknown=new Error('Completion execution stopped')):Promise<void>{
  if(this.#closing!==null)return this.#closing;this.#closed=true;this.#abort.abort(reason);
  this.#closing=(async()=>{if(this.#launchTask!==null)await Promise.allSettled([this.#launchTask]);await Promise.allSettled([...this.#states,...this.#http].map(t=>t.promise));this.takeSettled();this.#ready.dispose();})();return this.#closing;
 }
}
