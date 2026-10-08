import {types} from 'node:util';
import {GatewayTypedActivation} from './activation.ts';
import {GatewayIngress,type GatewayIngressConfig,type GatewayIngressReceivers} from './ingress.ts';
import {GatewayIngressLane} from './lane.ts';
import {GatewayPublication,type GatewayReceiveErrorDrop} from './publication.ts';
import {runGatewayShard,type GatewayShardPort} from './shard-task.ts';
import {GatewayTask,joinGatewayTasksForCause,nativeGatewayShutdownClock,GATEWAY_SHUTDOWN_TIMEOUT_MS,type GatewayShutdownOptions,type GatewayShutdownReport} from './shutdown.ts';
import {gatewayOwnField} from './values.ts';
function method(value:object,key:string,synchronous=false):Function{
 let cursor:object|null=value;
 while(cursor!==null){if(types.isProxy(cursor))throw new TypeError('Proxy gateway adapter');const descriptor=Object.getOwnPropertyDescriptor(cursor,key);if(descriptor!==undefined){if(!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='function'||types.isProxy(descriptor.value)||types.isGeneratorFunction(descriptor.value)||synchronous&&types.isAsyncFunction(descriptor.value))throw new TypeError('Invalid gateway adapter method');return descriptor.value.bind(value);}cursor=Object.getPrototypeOf(cursor);}
 throw new TypeError('Missing gateway adapter method');
}
export interface GatewayRuntimeOptions extends GatewayShutdownOptions{readonly ingressConfig?:GatewayIngressConfig;readonly reportReceiveErrorDrop:(drop:GatewayReceiveErrorDrop)=>void}
/** Composition over mandatory owned shard adapters, not WebSocket discovery/start.
 * Validation finishes before ownership transfers. On validation failure the caller
 * retains every port. On success this owner disposes/joins them, even while paused.
 * Explicit shutdown replaces Rust Drop; garbage collection is not cleanup.
 * HTTP ownership stays with the caller. All timing uses one captured trusted clock. */
export class GatewayRuntime<I extends object>{
 readonly #ingress:GatewayIngress<I>;readonly #activation:GatewayTypedActivation<GatewayIngressReceivers<I>>;readonly #publication:GatewayPublication<I>;
 readonly #stop=new AbortController();readonly #exits=new GatewayIngressLane<number>(1);readonly #exitReceiver=this.#exits.receiver();readonly #tasks:GatewayTask[]=[];readonly #all:GatewayTask[]=[];readonly #options:GatewayShutdownOptions;
 #shutdown:Promise<GatewayShutdownReport>|undefined;#taken=false;#closed=false;
 private constructor(ports:readonly GatewayShardPort<I>[],ingress:GatewayIngress<I>,options:GatewayShutdownOptions,report:(drop:GatewayReceiveErrorDrop)=>void){
  this.#ingress=ingress;this.#activation=new GatewayTypedActivation(ingress.receivers);this.#publication=new GatewayPublication(ingress,report);this.#options=options;
  for(const port of ports){const task=new GatewayTask(port.shardId,force=>runGatewayShard({port,activation:this.#activation,publication:this.#publication,shutdown:this.#stop.signal,force,exits:this.#exits,now:options.clock!.now}));this.#tasks.push(task);this.#all.push(task);}
  // Retain every actual task, independently of the joiner's consumed vector.
  void Promise.all(this.#all.map(task=>task.join())).then(()=>{this.#exits.close();});
 }
 static fromOwnedPorts<I extends object>(ports:readonly GatewayShardPort<I>[],options:GatewayRuntimeOptions):GatewayRuntime<I>{
  if(!Array.isArray(ports)||types.isProxy(ports))throw new TypeError('Expected gateway adapter array');const seen=new Set<object>(),ids=new Set<number>(),captured:GatewayShardPort<I>[]=[];
  for(let index=0;index<ports.length;index++){const port=gatewayOwnField(ports,String(index)) as GatewayShardPort<I>;if(port===null||typeof port!=='object'||types.isProxy(port)||seen.has(port))throw new TypeError('Expected unique gateway adapters');seen.add(port);const shardId=gatewayOwnField(port,'shardId');if(typeof shardId!=='number'||!Number.isInteger(shardId)||shardId<0||shardId>4294967295||ids.has(shardId))throw new TypeError('Expected unique u32 shard identifiers');ids.add(shardId);
   captured.push(Object.freeze({shardId,nextEvent:method(port,'nextEvent') as GatewayShardPort<I>['nextEvent'],requestNormalClose:method(port,'requestNormalClose',true) as ()=>void,dispose:method(port,'dispose') as ()=>Promise<void>}));
  }
  const reportDrop=method(options,'reportReceiveErrorDrop',true) as (drop:GatewayReceiveErrorDrop)=>void,reportTriggerFailure=method(options,'reportTriggerFailure',true) as GatewayShutdownOptions['reportTriggerFailure'];
  const sourceClock=options.clock??nativeGatewayShutdownClock,clock=Object.freeze({now:method(sourceClock,'now',true) as ()=>number,sleepUntil:method(sourceClock,'sleepUntil') as typeof sourceClock.sleepUntil});const time=clock.now();if(!Number.isFinite(time)||time<0)throw new TypeError('Expected monotonic gateway clock');
  const fatal=options.fatal===undefined?undefined:method(options,'fatal',true) as ()=>never;
  const ingress=new GatewayIngress<I>(options.ingressConfig);
  return new GatewayRuntime(captured,ingress,Object.freeze({clock,reportTriggerFailure,...(fatal===undefined?{}:{fatal})}),reportDrop);
 }
 takeIngressReceivers():GatewayIngressReceivers<I>{if(this.#closed)throw new TypeError('Gateway runtime closed');const receivers=this.#activation.takeReceivers();this.#taken=true;return receivers;}
 activateTypedConsumers():void{this.#activation.activate();}
 beginStopping():void{this.#ingress.stopAccepting();}
 waitForShardExit(signal?:AbortSignal):Promise<number|null>{return this.#exitReceiver.receive(signal);}
 subscribeIdentity(){return this.#ingress.subscribeIdentity();}
 subscribeIdentityConflict(){return this.#ingress.subscribeIdentityConflict();}
 subscribeMessageGaps(){return this.#ingress.subscribeMessageGaps();}
 subscribeIngressDiagnostics(){return this.#ingress.subscribeDiagnostics();}
 publicationSnapshot(){return this.#publication.snapshot();}
 get pendingTasks():number{return this.#all.filter(task=>task.peek()===undefined).length;}
 get resourcesClosed():boolean{return this.#closed;}
 shutdown(deadlineMs?:number):Promise<GatewayShutdownReport>{return this.shutdownForCause(deadlineMs,null);}
 shutdownForCause(deadlineMs:number|undefined,trigger:number|null):Promise<GatewayShutdownReport>{
  if(this.#shutdown!==undefined)return this.#shutdown;
  const deadline=deadlineMs??this.#options.clock!.now()+GATEWAY_SHUTDOWN_TIMEOUT_MS;
  if(!Number.isFinite(deadline)||deadline<0||trigger!==null&&(!Number.isInteger(trigger)||trigger<0||trigger>4294967295))throw new TypeError('Invalid gateway shutdown scope');
  this.beginStopping();this.#activation.stop();this.#stop.abort(new Error('Gateway stopping'));
  this.#shutdown=joinGatewayTasksForCause(this.#tasks,deadline,trigger,this.#options).finally(()=>{
   // An injected fatal sentinel may throw while work is still live. Never label
   // that as cleanup completion or revoke lanes from tasks still owning them.
   if(this.pendingTasks!==0)return;this.#ingress.close();this.#exits.close();if(!this.#taken)for(const receiver of Object.values(this.#ingress.receivers))receiver.dispose();this.#closed=true;
  });return this.#shutdown;
 }
}
