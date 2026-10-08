import {types} from "node:util";
import {invokeSynchronousVoid} from "../core/synchronous-void.ts";
import {BoundedBroadcast,BroadcastClosedError,BroadcastLaggedError,type BroadcastReceiver,type BroadcastPoll} from "./broadcast.ts";
import {GenerationWatchClosedError,type GenerationWatchReceiver} from "./generation-watch.ts";
import type {AppNotification} from "./notification-state.ts";
import type {PendingServerRequest} from "./server-request-state.ts";
export type ResidentNotificationEvent={readonly kind:"Notification";readonly generation:bigint;readonly notification:AppNotification}|{readonly kind:"Gap";readonly generation:bigint;readonly skipped:bigint};
export type ResidentServerRequestEvent={readonly kind:"Request";readonly generation:bigint;readonly request:PendingServerRequest}|{readonly kind:"Gap";readonly generation:bigint;readonly skipped:bigint};
export interface ResidentEventSources{subscribeNotifications():BroadcastReceiver<AppNotification>;subscribeServerRequests():BroadcastReceiver<PendingServerRequest>}
export interface ResidentDeathMonitor{waitClosed(signal:AbortSignal):Promise<string>;onClosed():void}
function pinDeathMonitor(monitor:ResidentDeathMonitor):ResidentDeathMonitor{
  if(monitor===null||typeof monitor!=="object"||types.isProxy(monitor))throw new TypeError("Expected owned death monitor");
  const field=(key:string):Function=>{const d=Object.getOwnPropertyDescriptor(monitor,key);if(!d||!Object.hasOwn(d,"value")||typeof d.value!=="function"||types.isProxy(d.value)||types.isGeneratorFunction(d.value))throw new TypeError("Expected own death-monitor function");return d.value;};
  const wait=field("waitClosed"),closed=field("onClosed");if(types.isAsyncFunction(closed))throw new TypeError("Death publication must be synchronous");
  return Object.freeze({waitClosed:(signal:AbortSignal)=>Reflect.apply(wait,monitor,[signal]) as Promise<string>,onClosed:()=>invokeSynchronousVoid(closed,monitor)});
}
type Attempt<T>={readonly ok:true;readonly value:T}|{readonly ok:false;readonly error:unknown};
async function attempt<T>(operation:()=>Promise<T>):Promise<Attempt<T>>{try{return {ok:true,value:await operation()};}catch(error){return {ok:false,error};}}
/** Own both pending operations until cancellation is joined. A losing receive may have
 * already consumed an item in JS; its result must be forwarded, never silently dropped.
 * This is deterministic race handling, not Tokio's randomized select fairness. */
async function selectOwned<T>(receive:(signal:AbortSignal)=>Promise<T>,generation:GenerationWatchReceiver){
  const controller=new AbortController(),cancel=Object.freeze({canceledSelection:true});
  const item=attempt(()=>receive(controller.signal)),changed=attempt(()=>generation.changed(controller.signal));
  await Promise.race([item,changed]);controller.abort(cancel);const [received,change]=await Promise.all([item,changed]);return {received,change,cancel};
}
function send<T>(target:BoundedBroadcast<T>,event:T):void{try{target.send(event);}catch(error){if(!(error instanceof BroadcastClosedError))throw error;}}
function changedClosed(change:Attempt<void>,cancel:object):boolean{if(change.ok||change.error===cancel)return false;if(change.error instanceof GenerationWatchClosedError)return true;throw change.error;}
/** Bounded source manager/events.rs and death.rs ownership. Subscriptions are prepared
 * before activation; unactivated join releases them without propagating close/events.
 * After activation, caller MUST change/close generation (normally to 0) before join,
 * or let the sources close (including the optional death wait). join never kills the
 * client process. Constructor consumes generationReceiver and owns its private clones.
 * Monitor callbacks are pinned once; their implementation remains a trusted adapter. */
export class ResidentForwarders{
  readonly #activation:Promise<boolean>;#resolve!:(active:boolean)=>void;#activated=false;#joining=false;
  readonly #tasks:Promise<void>[]=[];
  constructor(source:ResidentEventSources,generation:bigint,targetNotifications:BoundedBroadcast<ResidentNotificationEvent>,targetRequests:BoundedBroadcast<ResidentServerRequestEvent>,generationReceiver:GenerationWatchReceiver,death?:ResidentDeathMonitor){
    if(typeof generation!=="bigint"||generation<0n||generation>=(1n<<64n))throw new TypeError("Expected u64 forwarding generation");
    this.#activation=new Promise(resolve=>{this.#resolve=resolve;});
    // Acquire all ownership before launching any task, so partial acquisition can unwind.
    let notifications:BroadcastReceiver<AppNotification>|undefined,requests:BroadcastReceiver<PendingServerRequest>|undefined,notificationGeneration:GenerationWatchReceiver|undefined,requestGeneration:GenerationWatchReceiver|undefined,deathGeneration:GenerationWatchReceiver|undefined;
    try{
      const monitor=death===undefined?undefined:pinDeathMonitor(death);
      notifications=source.subscribeNotifications();requests=source.subscribeServerRequests();notificationGeneration=generationReceiver.clone();requestGeneration=generationReceiver.clone();if(monitor)deathGeneration=generationReceiver.clone();
      this.#own(this.#forward(notifications,notificationGeneration,generation,targetNotifications,(notification)=>Object.freeze({kind:"Notification",generation,notification})));
      this.#own(this.#forward(requests,requestGeneration,generation,targetRequests,(request)=>Object.freeze({kind:"Request",generation,request})));
      if(monitor)this.#own(this.#death(monitor,deathGeneration!,generation));
    }catch(error){notifications?.dispose();requests?.dispose();notificationGeneration?.dispose();requestGeneration?.dispose();deathGeneration?.dispose();this.#resolve(false);throw error;}
    finally{generationReceiver.dispose();}
  }
  #own(task:Promise<void>):void{void task.catch(()=>undefined);this.#tasks.push(task);}
  activate():void{if(this.#joining)return;this.#activated=true;this.#resolve(true);}
  async join():Promise<void>{this.#joining=true;if(!this.#activated)this.#resolve(false);const results=await Promise.allSettled(this.#tasks),errors=results.flatMap(r=>r.status==="rejected"?[r.reason]:[]);if(errors.length)throw new AggregateError(errors,"Resident forwarder tasks failed");}
  async #forward<T,E extends {readonly kind:string;readonly generation:bigint}>(source:BroadcastReceiver<T>,watch:GenerationWatchReceiver,generation:bigint,target:BoundedBroadcast<E|{readonly kind:"Gap";readonly generation:bigint;readonly skipped:bigint}>,value:(item:T)=>E):Promise<void>{
    const forward=(item:BroadcastPoll<T>):boolean=>{if(item.kind==="Value"){send(target,value(item.value));return true;}if(item.kind==="Lagged"){send(target,Object.freeze({kind:"Gap",generation,skipped:item.missed}));return true;}return false;};
    const drain=()=>{while(forward(source.tryReceive())){/* drain only already available */}};
    try{
      if(!await this.#activation)return;
      while(true){
        if(watch.borrow()!==generation){drain();return;}
        const selected=await selectOwned(signal=>source.receive(signal),watch);let sourceClosed=false;
        if(selected.received.ok)send(target,value(selected.received.value));
        else if(selected.received.error instanceof BroadcastLaggedError)send(target,Object.freeze({kind:"Gap",generation,skipped:selected.received.error.missed}));
        else if(selected.received.error instanceof BroadcastClosedError)sourceClosed=true;
        else if(selected.received.error!==selected.cancel)throw selected.received.error;
        if(changedClosed(selected.change,selected.cancel)||watch.borrow()!==generation){drain();return;}
        if(sourceClosed)return;
      }
    }finally{source.dispose();watch.dispose();}
  }
  async #death(monitor:ResidentDeathMonitor,watch:GenerationWatchReceiver,generation:bigint):Promise<void>{
    try{
      if(!await this.#activation)return;
      while(watch.borrow()===generation){
        const selected=await selectOwned(signal=>monitor.waitClosed(signal),watch);
        if(selected.received.ok){invokeSynchronousVoid(monitor.onClosed,monitor);return;}
        if(selected.received.error!==selected.cancel)throw selected.received.error;
        if(changedClosed(selected.change,selected.cancel)||watch.borrow()!==generation)return;
      }
    }finally{watch.dispose();}
  }
}
