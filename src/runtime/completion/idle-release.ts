import {types} from "node:util";
import type {PortableResidentLifecycle} from "../../app-server/portable-resident-lifecycle.ts";
import {cloneIdleReleaseToken} from "../../app-server/idle-release-journal.ts";
import {StateAccessFacade as state} from "../../store/state-access-facade.ts";
import type {IdleIntent} from "../../store/idle-release-row.ts";
import {QueueStartCoordinator} from "../queue-runner/start-coordinator.ts";
import {DelayedTicks,type TickSource} from "../delayed-ticks.ts";
import {invokeSynchronousVoid} from "../../core/synchronous-void.ts";
import {requireDiscordText} from "../../discord/text.ts";
type Server=Pick<PortableResidentLifecycle,'instanceId'|'generation'|'releaseIdleSubscription'>;
export interface IdleReleaseFailure{readonly stage:'scan'|'release'|'deferral';readonly error:unknown;readonly thread:string|null}
const equal=(a:IdleIntent,b:IdleIntent)=>a.intentId===b.intentId&&a.ownerId===b.ownerId&&a.generation===b.generation&&a.threadId===b.threadId&&a.turnId===b.turnId&&a.jobId===b.jobId&&a.revision===b.revision&&a.state===b.state&&a.detail===b.detail;
/** Five-second delayed maintenance, borrowing the same queue target registry. Busy
 * targets are skipped rather than waited behind. Native release retains its own durable
 * effect custody; cancellation never abandons an already-started managed operation. */
export class CompletionIdleRelease{
 readonly #server:Server;readonly #queue:QueueStartCoordinator;readonly #render:(error:unknown)=>string;readonly #report:(failure:IdleReleaseFailure)=>void;#busy=false;#running=false;#closed=false;
 constructor(server:Server,queue:QueueStartCoordinator,render:(error:unknown)=>string,report:(failure:IdleReleaseFailure)=>void){if(typeof render!=="function"||types.isProxy(render)||types.isAsyncFunction(render)||types.isGeneratorFunction(render))throw new TypeError("Expected public-safe synchronous idle diagnostic renderer");this.#server=server;this.#queue=queue;this.#render=render;this.#report=report;}
 #notify(stage:IdleReleaseFailure['stage'],error:unknown,thread:string|null=null):void{invokeSynchronousVoid(this.#report,{},[{stage,error,thread}]);}
 async #deferral(expected:IdleIntent,error:unknown):Promise<void>{
  if(expected.state!=='Candidate')return;const current=await state.getIdleIntent(this.#queue.dbPath,expected.threadId);if(current===null||!equal(expected,current))return;
  const detail=this.#render(error);if(types.isPromise(detail))void Promise.prototype.then.call(detail,undefined,()=>undefined);requireDiscordText(detail);await state.transitionIdleIntent(this.#queue.dbPath,expected,'Candidate',detail);
 }
 async #pass(signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();const intents=await state.pendingIdleIntents(this.#queue.dbPath);
  for(const intent of intents){
   signal?.throwIfAborted();if(intent.ownerId!==this.#server.instanceId||intent.generation<0n||intent.generation!==this.#server.generation()||(intent.state!=='Candidate'&&intent.state!=='AwaitUnload'))continue;
   const lease=this.#queue.locks.tryAcquire(intent.threadId);if(lease===undefined)continue;
   try{const token=cloneIdleReleaseToken(intent);try{await this.#server.releaseIdleSubscription(token);}catch(error){try{await this.#deferral(intent,error);}catch(recording){this.#notify('deferral',recording,intent.threadId);}this.#notify('release',error,intent.threadId);}}
   finally{lease.release();}
  }
 }
 async scanOnce(signal?:AbortSignal):Promise<void>{if(this.#closed||this.#running||this.#busy)throw new TypeError('Idle release worker already owned or closed');this.#busy=true;try{await this.#pass(signal);}finally{this.#busy=false;}}
 async run(signal:AbortSignal,ticks:TickSource=new DelayedTicks(5000)):Promise<void>{
  if(this.#closed||this.#running||this.#busy){ticks.close();throw new TypeError('Idle release worker already owned or closed');}this.#running=true;
  let stop!:()=>void,pending:Promise<{kind:'tick'}|{kind:'error';error:unknown}>|undefined;const stopped=new Promise<{kind:'stop'}>(resolve=>{stop=()=>resolve({kind:'stop'});});signal.addEventListener('abort',stop,{once:true});
  try{while(!signal.aborted){try{await this.#pass(signal);}catch(error){if(signal.aborted&&error===signal.reason)break;this.#notify('scan',error);}if(signal.aborted)break;pending=ticks.wait().then(()=>({kind:'tick' as const}),error=>({kind:'error' as const,error}));const next=await Promise.race([pending,stopped]);if(next.kind==='stop')break;if(next.kind==='error')throw next.error;}}
  finally{ticks.close();signal.removeEventListener('abort',stop);if(pending)await pending;this.#closed=true;this.#running=false;}
 }
}
