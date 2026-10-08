import {setImmediate as yieldToRuntime} from "node:timers/promises";
import type {PortableResidentLifecycle} from "../../app-server/portable-resident-lifecycle.ts";
import type {ResidentNotificationEvent} from "../../app-server/resident-forwarders.ts";
import {BroadcastClosedError,BroadcastLaggedError} from "../../app-server/broadcast.ts";
import {cloneOwnedSerdeValue} from "../../core/owned-serde-value.ts";
import {invokeSynchronousVoid} from "../../core/synchronous-void.ts";
import {extractThreadId} from "../../app-server/identity.ts";
import {parseTurnCompletion} from "../../app-server/outcomes.ts";
import {StateAccessFacade,type IStateAccessFacade} from "../../store/state-access-facade.ts";
import type {ObservationScope} from "../../store/observation-gap-model.ts";
import {CompletionSourceCertifier} from "./source-certifier.ts";
import {observeCompletionTerminal} from "./observation.ts";
import {TerminalFence} from "./terminal-fence.ts";
import {CompletionEventBudget,type CompletionNotification} from "./scheduler/envelope.ts";
import type {ReadyLive} from "./scheduler/ready.ts";
import {DelayedTicks,type TickSource} from "../delayed-ticks.ts";
type Server=Pick<PortableResidentLifecycle,"instanceId"|"generation"|"observationWindow"|"markIdleObservationGap"|"markSourceObservationGap"|"subscribeNotifications">;
type Store=Pick<IStateAccessFacade,"activateObservation"|"discoverObservation">;
export interface SourceIntakeFailure{readonly stage:"scope"|"activate"|"window"|"discover"|"journal"|"late-journal"|"bytes"|"queue"|"gap";readonly error:unknown}
/** Source ingress FIFO, separate from per-target scheduler lanes. Caller owns envelopes
 * returned by take() and must dispose them after processing; close releases queued ones. */
export class CompletionSourceQueue{
 readonly #items:ReadyLive<CompletionNotification>[]=[];#closed=false;
 get length():number{return this.#items.length;}
 offer(event:ReadyLive<CompletionNotification>):boolean{if(this.#closed||this.#items.length>=128)return false;this.#items.push(event);return true;}
 take():ReadyLive<CompletionNotification>|null{return this.#items.shift()??null;}
 close():void{if(this.#closed)return;this.#closed=true;for(const item of this.#items)item.dispose();this.#items.length=0;}
}
/** Indexed pages are authority; current broadcast events are only wakeups. One owner
 * retains the cursor, bounded byte permits, FIFO and resident subscription. */
export class CompletionSourceIntake{
 readonly queue=new CompletionSourceQueue();readonly #budget:CompletionEventBudget;readonly #path:string;readonly #server:Server;readonly #fence:TerminalFence;readonly #certifier:CompletionSourceCertifier;readonly #report:(failure:SourceIntakeFailure)=>void;readonly #state:Store;
 #current:ObservationScope|null=null;#forwarded=0n;#busy=false;#running=false;#closed=false;
 constructor(path:string,server:Server,fence:TerminalFence,commentaryEnabled:boolean,report:(failure:SourceIntakeFailure)=>void,budget=new CompletionEventBudget(),state:Store=StateAccessFacade){this.#path=path;this.#server=server;this.#fence=fence;this.#report=report;this.#budget=budget;this.#state=state;this.#certifier=new CompletionSourceCertifier(path,server,commentaryEnabled);}
 close():void{if(this.#running||this.#busy)throw new TypeError("Source intake still owned");this.queue.close();this.#closed=true;}
 get forwarded():bigint{return this.#forwarded;}
 get availableBytes():number{return this.#budget.availableBytes;}
 #notify(stage:SourceIntakeFailure['stage'],error:unknown):void{invokeSynchronousVoid(this.#report,{},[{stage,error}]);}
 #gapError=(error:unknown):void=>{this.#notify("gap",error);};
 async scanOnce(signal?:AbortSignal):Promise<void>{if(this.#closed)throw new TypeError("Source intake closed");if(this.#running)throw new TypeError("Source loop owns scan");return this.#exclusive(()=>this.#scan(signal));}
 async acceptWake(input:ResidentNotificationEvent):Promise<void>{if(this.#closed)throw new TypeError("Source intake closed");if(this.#running)throw new TypeError("Source loop owns wakeups");return this.#exclusive(()=>this.#wake(input));}
 async #exclusive(operation:()=>Promise<void>):Promise<void>{if(this.#busy)throw new TypeError("Only one source intake operation");this.#busy=true;try{await operation();}finally{this.#busy=false;}}
 async #wake(input:ResidentNotificationEvent):Promise<void>{
  const event=cloneOwnedSerdeValue(input) as ResidentNotificationEvent;
  if(event.kind==="Gap"){this.#server.markSourceObservationGap(event.generation,this.#gapError);return;}
  if(event.kind!=="Notification")throw new TypeError("Expected resident notification event");
  if(event.generation!==this.#server.generation()){
   try{await observeCompletionTerminal(this.#path,this.#server.instanceId,event);}catch(error){this.#notify("late-journal",error);}
   this.#send(event);
  }
 }
 #send(event:ResidentNotificationEvent):void{
  if(event.kind==="Notification"&&extractThreadId(event.notification.params)===null)return;
  const charged=this.#budget.chargeOwned(event);
  if(charged===null){this.#server.markSourceObservationGap(this.#server.generation(),this.#gapError);this.#notify("bytes",new Error("completion event budget gap"));return;}
  if(!this.queue.offer(charged)){charged.dispose();this.#server.markSourceObservationGap(this.#server.generation(),this.#gapError);this.#notify("queue",new Error("completion processing queue gap; original ranges retained"));}
 }
 async #scan(signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();let scope:ObservationScope;
  try{scope=this.#certifier.currentScope();}catch(error){this.#notify("scope",error);return;}
  if(this.#current?.ownerId!==scope.ownerId||this.#current.generation!==scope.generation){
   try{await this.#state.activateObservation(this.#path,scope);}catch(error){this.#server.markIdleObservationGap(this.#gapError);this.#notify("activate",error);return;}
   this.#current=scope;this.#forwarded=0n;
  }
  signal?.throwIfAborted();let page:ReturnType<Server['observationWindow']>;
  try{page=this.#server.observationWindow(this.#server.generation(),this.#forwarded,null);}catch(error){this.#server.markIdleObservationGap(this.#gapError);this.#notify("window",error);return;}
  try{await this.#state.discoverObservation(this.#path,scope,page.sourceUpper);}catch(error){this.#server.markIdleObservationGap(this.#gapError);this.#notify("discover",error);}
  const next=page.scannedThrough===(1n<<64n)-1n?page.scannedThrough:page.scannedThrough+1n;
  if(page.firstAvailable>(page.events[0]?.sequence??next))this.#server.markSourceObservationGap(page.generation,this.#gapError);
  for(const original of page.events){
   signal?.throwIfAborted();const notification=original.notification;
   if(notification===null){this.#server.markSourceObservationGap(page.generation,this.#gapError);continue;}
   if(notification.method==="turn/completed"){let completed;try{completed=parseTurnCompletion(notification.params,false);}catch{/* Invalid completion remains unconfirmed by the journal below. */}if(completed)this.#fence.stop(page.generation,completed.threadId,completed.turnId);}
   try{await this.#certifier.certifyEvent(scope,original.sequence,notification);}catch(error){this.#server.markSourceObservationGap(page.generation,this.#gapError);this.#notify("journal",error);}
   signal?.throwIfAborted();this.#send({kind:"Notification",generation:page.generation,notification});
  }
  this.#forwarded=page.scannedThrough;
  await yieldToRuntime(); // Explicit page boundary, like source yield_now; microtasks alone do not yield I/O.
 }
 /** Immediate initial scan then delayed 250ms/wakeup scans. Losing receives/ticks stay
  * owned; shutdown cancels and joins them, never leaves a detached receiver task. */
 async run(signal:AbortSignal,ticks:TickSource=new DelayedTicks(250)):Promise<void>{
  if(this.#closed||this.#running||this.#busy){ticks.close();throw new TypeError("Source intake already owned");}this.#running=true;
  const cancel=new AbortController(),reason=Object.freeze({sourceIntakeStopped:true});let receiver:ReturnType<Server['subscribeNotifications']>|undefined;let pendingReceive:Promise<{kind:"event";event:ResidentNotificationEvent}|{kind:"error";error:unknown}>|undefined,pendingTick:Promise<{kind:"tick"}|{kind:"tick-error";error:unknown}>|undefined;let stopped!:()=>void;
  const stop=new Promise<{kind:"stop"}>(resolve=>{stopped=()=>resolve({kind:"stop"});});signal.addEventListener("abort",stopped,{once:true});
  try{
   if(signal.aborted)return;receiver=this.#server.subscribeNotifications();
   const receive=()=>receiver!.receive(cancel.signal).then(event=>({kind:"event" as const,event}),error=>({kind:"error" as const,error}));
   const tick=()=>ticks.wait().then(()=>({kind:"tick" as const}),error=>({kind:"tick-error" as const,error}));pendingReceive=receive();pendingTick=tick();await this.#scan(signal);
   while(!signal.aborted){const result=await Promise.race([pendingReceive,pendingTick,stop]);if(result.kind==="stop")break;if(result.kind==="tick-error")throw result.error;
    if(result.kind==="tick")pendingTick=tick();else{pendingReceive=receive();if(result.kind==="event")await this.#wake(result.event);else if(result.error instanceof BroadcastClosedError)break;else if(result.error instanceof BroadcastLaggedError)this.#server.markSourceObservationGap(this.#server.generation(),this.#gapError);else throw result.error;}
    await this.#scan(signal);
   }
  }catch(error){if(!signal.aborted||error!==signal.reason)throw error;}
  finally{cancel.abort(reason);receiver?.dispose();ticks.close();signal.removeEventListener("abort",stopped);await Promise.allSettled([...(pendingReceive?[pendingReceive]:[]),...(pendingTick?[pendingTick]:[])]);this.queue.close();this.#closed=true;this.#running=false;}
 }
}
