import {observeAsyncQuestionNotification} from "../async-question-observation.ts";
import type {PortableResidentLifecycle} from "../../app-server/portable-resident-lifecycle.ts";
import type {ObservationWindow} from "../../app-server/notification-state.ts";
import {StateAccessFacade,type IStateAccessFacade} from "../../store/state-access-facade.ts";
import {gapContains,type ObservationScope} from "../../store/observation-gap-model.ts";
import {CompletionSourceCertifier} from "./source-certifier.ts";
import {CompletionHeldError} from "./receipt-sender.ts";
import {QueueIntegerRangeError} from "../queue-runner/errors.ts";
import {DelayedTicks,type TickSource} from "../delayed-ticks.ts";
import {invokeSynchronousVoid} from "../../core/synchronous-void.ts";
import type {NativeObservationInspection} from '../native-observation-ledger.ts';
type Server=Pick<PortableResidentLifecycle,"instanceId"|"generation"|"observationWindow"|"reconcileIdleObservationPrefix"|"markIdleObservationGap"|"observationTrackingEnabled">&Partial<Pick<PortableResidentLifecycle,"reconcileIdleObservationPrefixAsync">>;
type Store=Pick<IStateAccessFacade,"activateObservation"|"discoverObservation"|"nextObservationGap"|"finishObservationPage"|"observationScopeVerified">&{inspectObservation?:(path:string,scope:ObservationScope,upper:bigint,signal?:AbortSignal)=>Promise<NativeObservationInspection>};
export interface SourceReconcileFailure{readonly stage:"event"|"pass"|"gap";readonly error:unknown}
function sequence(v:unknown):bigint{if(typeof v!=="bigint"||v<0n||v>=(1n<<63n))throw new QueueIntegerRangeError();return v;}
/** Local retained source journals only: no history inference, generic handler replay,
 * RPC or HTTP. Native prefix clearance also rechecks its current window/ledger. */
export class CompletionSourceReconciler{
 readonly #path:string;readonly #server:Server;readonly #certifier:CompletionSourceCertifier;readonly #state:Store;readonly #report:(failure:SourceReconcileFailure)=>void;
 #current:ObservationScope|null=null;#idleUpper:bigint|null=null;#idleUntil=0;#busy=false;#running=false;#closed=false;
 constructor(path:string,server:Server,commentaryEnabled:boolean,report:(failure:SourceReconcileFailure)=>void,state:Store=StateAccessFacade,certificationState:Pick<IStateAccessFacade,"certifyObservation"|"recordObservedCompletionForResident"|"recordObservedFinalAnswer">=StateAccessFacade,observeQuestions:typeof observeAsyncQuestionNotification=observeAsyncQuestionNotification){this.#path=path;this.#server=server;this.#certifier=new CompletionSourceCertifier(path,server,commentaryEnabled,undefined,certificationState,observeQuestions);this.#report=report;this.#state=state;}
 #notify(stage:SourceReconcileFailure['stage'],error:unknown):void{invokeSynchronousVoid(this.#report,{},[{stage,error}]);}
 #gapError=(error:unknown):void=>{this.#notify("gap",error);};
 async scanOnce(signal?:AbortSignal):Promise<void>{if(this.#closed||this.#running||this.#busy)throw new TypeError("Source reconciler already owned or closed");this.#busy=true;try{await this.#pass(signal);}finally{this.#busy=false;}}
 #sourceUpper(scope:ObservationScope,page:ObservationWindow):bigint{
  if(page.ownerId!==scope.ownerId||sequence(page.generation)!==scope.generation)throw new CompletionHeldError("different original observation stream");return sequence(page.sourceUpper);
 }
 async #pass(signal?:AbortSignal,periodic=false):Promise<void>{
  signal?.throwIfAborted();const scope=this.#certifier.currentScope();
  if(this.#current?.ownerId!==scope.ownerId||this.#current.generation!==scope.generation){this.#idleUpper=null;await this.#state.activateObservation(this.#path,scope);}
  await this.#reconcile(scope,signal,periodic);this.#current=scope;
 }
 async #reconcile(scope:ObservationScope,signal?:AbortSignal,periodic=false):Promise<void>{
  signal?.throwIfAborted();const gen=scope.generation,head=this.#server.observationWindow(gen,0n,0n),upper=this.#sourceUpper(scope,head);
  // Empty unchanged native pages need at most one poll per second. A new source
  // sequence still runs on the existing 250ms tick; explicit scans always run.
  // Skipping does not clear any gap or reuse a proof to authorize new work.
  if(periodic&&upper===this.#idleUpper&&performance.now()<this.#idleUntil)return;
  this.#idleUpper=null;
  const inspection=await this.#state.inspectObservation?.(this.#path,scope,upper,signal);
  if(inspection===undefined)await this.#state.discoverObservation(this.#path,scope,upper);signal?.throwIfAborted();
  const gap=inspection===undefined?await this.#state.nextObservationGap(this.#path,scope):inspection.gap;if(gap!==null){
   signal?.throwIfAborted();const page=this.#server.observationWindow(gen,sequence(gap.cursor),sequence(gap.last));
   for(const original of page.events){
    signal?.throwIfAborted();if(gapContains(gap,sequence(original.sequence)))continue;
    if(original.notification!==null)try{await this.#certifier.certifyEvent(scope,original.sequence,original.notification);}catch(error){this.#notify("event",error);}
   }
   signal?.throwIfAborted();if(this.#server.generation()===gen&&page.scannedThrough>gap.cursor)await this.#state.finishObservationPage(this.#path,gap,sequence(page.scannedThrough));
  }
  signal?.throwIfAborted();const latest=this.#server.observationWindow(gen,0n,0n),latestUpper=this.#sourceUpper(scope,latest);
  const verified=inspection!==undefined&&gap===null&&latestUpper===upper?inspection.verified:await this.#state.observationScopeVerified(this.#path,scope,latestUpper);
  if(verified){signal?.throwIfAborted();if(this.#server.generation()!==gen)throw new CompletionHeldError("native generation changed during verification");if(this.#server.reconcileIdleObservationPrefixAsync!==undefined)await this.#server.reconcileIdleObservationPrefixAsync(gen,latest.sourceUpper);else this.#server.reconcileIdleObservationPrefix(gen,latest.sourceUpper);}
  if(inspection!==undefined&&gap===null&&latestUpper===upper){this.#idleUpper=upper;this.#idleUntil=performance.now()+1000;}
 }
 /** One cooperative pass at a time. Shutdown checks precede page work and final
  * acknowledgement; a synchronous DB operation already running must finish. */
 async run(signal:AbortSignal,ticks:TickSource=new DelayedTicks(250)):Promise<void>{
  if(this.#closed||this.#running||this.#busy){ticks.close();throw new TypeError("Source reconciler already owned or closed");}if(!this.#server.observationTrackingEnabled()){ticks.close();return;}this.#running=true;let stop!:()=>void,pending:Promise<{kind:"tick"}|{kind:"error";error:unknown}>|undefined;
  const stopped=new Promise<{kind:"stop"}>(resolve=>{stop=()=>resolve({kind:"stop"});});signal.addEventListener("abort",stop,{once:true});
  try{
   while(!signal.aborted){
    try{await this.#pass(signal,true);}catch(error){if(signal.aborted&&error===signal.reason)break;this.#server.markIdleObservationGap(this.#gapError);this.#notify("pass",error);}
    if(signal.aborted)break;pending=ticks.wait().then(()=>({kind:"tick" as const}),error=>({kind:"error" as const,error}));const next=await Promise.race([pending,stopped]);if(next.kind==="stop")break;if(next.kind==="error")throw next.error;
   }
  }finally{ticks.close();signal.removeEventListener("abort",stop);if(pending)await pending;this.#closed=true;this.#running=false;}
 }
}
