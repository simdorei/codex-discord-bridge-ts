import type {PortableResidentLifecycle} from "../../app-server/portable-resident-lifecycle.ts";
import type {ObservationWindow} from "../../app-server/notification-state.ts";
import {StateAccessFacade,type IStateAccessFacade} from "../../store/state-access-facade.ts";
import {gapContains,type ObservationScope} from "../../store/observation-gap-model.ts";
import {CompletionSourceCertifier} from "./source-certifier.ts";
import {CompletionHeldError} from "./receipt-sender.ts";
import {QueueIntegerRangeError} from "../queue-runner/errors.ts";
import {DelayedTicks,type TickSource} from "../delayed-ticks.ts";
import {invokeSynchronousVoid} from "../../core/synchronous-void.ts";
type Server=Pick<PortableResidentLifecycle,"instanceId"|"generation"|"observationWindow"|"reconcileIdleObservationPrefix"|"markIdleObservationGap"|"observationTrackingEnabled">;
type Store=Pick<IStateAccessFacade,"activateObservation"|"discoverObservation"|"nextObservationGap"|"finishObservationPage"|"observationScopeVerified">;
export interface SourceReconcileFailure{readonly stage:"event"|"pass"|"gap";readonly error:unknown}
function sequence(v:unknown):bigint{if(typeof v!=="bigint"||v<0n||v>=(1n<<63n))throw new QueueIntegerRangeError();return v;}
/** Local retained source journals only: no history inference, generic handler replay,
 * RPC or HTTP. Native prefix clearance also rechecks its current window/ledger. */
export class CompletionSourceReconciler{
 readonly #path:string;readonly #server:Server;readonly #certifier:CompletionSourceCertifier;readonly #state:Store;readonly #report:(failure:SourceReconcileFailure)=>void;
 #current:ObservationScope|null=null;#busy=false;#running=false;#closed=false;
 constructor(path:string,server:Server,commentaryEnabled:boolean,report:(failure:SourceReconcileFailure)=>void,state:Store=StateAccessFacade){this.#path=path;this.#server=server;this.#certifier=new CompletionSourceCertifier(path,server,commentaryEnabled);this.#report=report;this.#state=state;}
 #notify(stage:SourceReconcileFailure['stage'],error:unknown):void{invokeSynchronousVoid(this.#report,{},[{stage,error}]);}
 #gapError=(error:unknown):void=>{this.#notify("gap",error);};
 async scanOnce(signal?:AbortSignal):Promise<void>{if(this.#closed||this.#running||this.#busy)throw new TypeError("Source reconciler already owned or closed");this.#busy=true;try{await this.#pass(signal);}finally{this.#busy=false;}}
 async #discover(scope:ObservationScope,page:ObservationWindow):Promise<void>{
  if(page.ownerId!==scope.ownerId||sequence(page.generation)!==scope.generation)throw new CompletionHeldError("different original observation stream");await this.#state.discoverObservation(this.#path,scope,sequence(page.sourceUpper));
 }
 async #pass(signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();const scope=this.#certifier.currentScope();
  if(this.#current?.ownerId!==scope.ownerId||this.#current.generation!==scope.generation)await this.#state.activateObservation(this.#path,scope);
  await this.#reconcile(scope,signal);this.#current=scope;
 }
 async #reconcile(scope:ObservationScope,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();const gen=scope.generation,head=this.#server.observationWindow(gen,0n,0n);await this.#discover(scope,head);signal?.throwIfAborted();
  const gap=await this.#state.nextObservationGap(this.#path,scope);if(gap!==null){
   signal?.throwIfAborted();const page=this.#server.observationWindow(gen,sequence(gap.cursor),sequence(gap.last));
   for(const original of page.events){
    signal?.throwIfAborted();if(gapContains(gap,sequence(original.sequence)))continue;
    if(original.notification!==null)try{await this.#certifier.certifyEvent(scope,original.sequence,original.notification);}catch(error){this.#notify("event",error);}
   }
   signal?.throwIfAborted();if(this.#server.generation()===gen&&page.scannedThrough>gap.cursor)await this.#state.finishObservationPage(this.#path,gap,sequence(page.scannedThrough));
  }
  signal?.throwIfAborted();const latest=this.#server.observationWindow(gen,0n,0n);
  if(await this.#state.observationScopeVerified(this.#path,scope,sequence(latest.sourceUpper))){signal?.throwIfAborted();this.#server.reconcileIdleObservationPrefix(gen,latest.sourceUpper);}
 }
 /** One cooperative pass at a time. Shutdown checks precede page work and final
  * acknowledgement; a synchronous DB operation already running must finish. */
 async run(signal:AbortSignal,ticks:TickSource=new DelayedTicks(250)):Promise<void>{
  if(this.#closed||this.#running||this.#busy){ticks.close();throw new TypeError("Source reconciler already owned or closed");}if(!this.#server.observationTrackingEnabled()){ticks.close();return;}this.#running=true;let stop!:()=>void,pending:Promise<{kind:"tick"}|{kind:"error";error:unknown}>|undefined;
  const stopped=new Promise<{kind:"stop"}>(resolve=>{stop=()=>resolve({kind:"stop"});});signal.addEventListener("abort",stop,{once:true});
  try{
   while(!signal.aborted){
    try{await this.#pass(signal);}catch(error){if(signal.aborted&&error===signal.reason)break;this.#server.markIdleObservationGap(this.#gapError);this.#notify("pass",error);}
    if(signal.aborted)break;pending=ticks.wait().then(()=>({kind:"tick" as const}),error=>({kind:"error" as const,error}));const next=await Promise.race([pending,stopped]);if(next.kind==="stop")break;if(next.kind==="error")throw next.error;
   }
  }finally{ticks.close();signal.removeEventListener("abort",stop);if(pending)await pending;this.#closed=true;this.#running=false;}
 }
}
