import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {GatewayRuntime} from '../../discord/gateway/runtime.ts';
import type {DecodedGatewayInteraction} from '../../discord/gateway/decoded-interaction.ts';
import type {MessageGapReceiver} from '../../discord/gateway/message-gaps.ts';
import type {GatewayReceiveError,GatewayIngressReceivers} from '../../discord/gateway/ingress.ts';
import {RuntimeMonitoredWorker,RuntimeWorkerExitChannel,type RuntimeWorkerResult} from './monitored-worker.ts';
import {runReadySetup,type ReadySetupOptions} from './ready-setup.ts';
import {runMessageConsumer,type GatewayMessageHandler} from './message-consumer.ts';
import {runHistoryConsumer,type HistoryConsumerOperations} from './history-consumer.ts';
import {runInteractionLane,type InteractionLaneHandler} from './interaction-lane.ts';
import type {InteractionFailureReport} from './interaction-failure.ts';
import {runReceiveErrorConsumer} from './receive-error-consumer.ts';
export interface TypedIngressStartOptions{
 readonly ready:ReadySetupOptions;readonly message:GatewayMessageHandler;
 readonly history:(gaps:MessageGapReceiver)=>HistoryConsumerOperations;readonly historyPeriodMs:number|null;
 readonly interaction:InteractionLaneHandler;readonly reportInteraction:(value:InteractionFailureReport)=>void;
 readonly reportReceiveError:(value:GatewayReceiveError)=>void;
}
/** Starts seven actual consumers and announces each entered callback before
 * activating paused Gateway shards. Caller receives every actual worker handle
 * and must pass them to common-deadline shutdown. Native service/bootstrap
 * construction remains external; the history factory receives the exact owned gap receiver. */
export async function startTypedIngressWorkers(gateway:GatewayRuntime<DecodedGatewayInteraction>,shutdown:AbortSignal,notifier:RuntimeWorkerExitChannel,options:TypedIngressStartOptions):Promise<RuntimeMonitoredWorker[]>{
 shutdown.throwIfAborted();
 const ready=own(options,'ready') as ReadySetupOptions,message=own(options,'message') as GatewayMessageHandler,historyFactory=own(options,'history') as TypedIngressStartOptions['history'],period=own(options,'historyPeriodMs') as number|null,interaction=own(options,'interaction') as InteractionLaneHandler,reportInteraction=own(options,'reportInteraction') as TypedIngressStartOptions['reportInteraction'],reportReceiveError=own(options,'reportReceiveError') as TypedIngressStartOptions['reportReceiveError'];
 for(const fn of [message,interaction,reportInteraction,reportReceiveError,historyFactory])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned typed consumer callback');
 if(types.isAsyncFunction(reportInteraction)||types.isAsyncFunction(reportReceiveError)||types.isAsyncFunction(historyFactory))throw new TypeError('Expected synchronous diagnostics');
 if(period!==null&&(!Number.isSafeInteger(period)||period<=0||period>2147483647))throw new TypeError('Invalid history period');
 const subscriptions:{dispose():void}[]=[],workers:RuntimeMonitoredWorker[]=[],announced:Promise<void>[]=[];let receivers:GatewayIngressReceivers<DecodedGatewayInteraction>|undefined;
 const pair=()=>{const identity=GatewayRuntime.prototype.subscribeIdentity.call(gateway),conflict=GatewayRuntime.prototype.subscribeIdentityConflict.call(gateway);subscriptions.push(identity,conflict);return {identity,conflict};};
 const spawn=(name:string,run:(force:AbortSignal)=>Promise<void|RuntimeWorkerResult>)=>{let announce!:()=>void;announced.push(new Promise<void>(r=>announce=r));workers.push(new RuntimeMonitoredWorker(name,notifier,async force=>{announce();try{const result=await run(force);return result===undefined?{ok:true}:result;}catch(error){if(force.aborted&&error===force.reason)throw error;return {ok:false,error};}}));};
 try{
  const readyPair=pair(),emergencyPair=pair(),messagePair=pair(),historyPair=pair(),gaps=GatewayRuntime.prototype.subscribeMessageGaps.call(gateway);subscriptions.push(gaps);
  const history=historyFactory(gaps);for(const key of ['recover','poll']){const fn=own(history,key);if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned history operation');}
  receivers=GatewayRuntime.prototype.takeIngressReceivers.call(gateway);const lanes=receivers;
  const borrowed=async(p:ReturnType<typeof pair>,run:()=>Promise<void>)=>{try{await run();}finally{p.identity.dispose();p.conflict.dispose();}};
  spawn('ready',force=>borrowed(readyPair,()=>runReadySetup(readyPair.identity,readyPair.conflict,shutdown,force,ready)));
  spawn('message-emergency',force=>borrowed(emergencyPair,()=>runMessageConsumer(lanes.emergencyMessages,emergencyPair.identity,emergencyPair.conflict,shutdown,force,message)));
  spawn('message',force=>borrowed(messagePair,()=>runMessageConsumer(lanes.messages,messagePair.identity,messagePair.conflict,shutdown,force,message)));
  spawn('history',force=>borrowed(historyPair,async()=>{try{await runHistoryConsumer(gaps,historyPair.identity,historyPair.conflict,shutdown,force,period,history);}finally{gaps.dispose();}}));
  spawn('interaction-normal',force=>runInteractionLane('Normal',lanes.normalInteractions,interaction,shutdown,force,{report:reportInteraction}));
  spawn('interaction-reserved',force=>runInteractionLane('Reserved',lanes.reservedInteractions,interaction,shutdown,force,{report:reportInteraction}));
  spawn('receive-error',force=>runReceiveErrorConsumer(lanes.receiveErrors,shutdown,force,reportReceiveError));
  await Promise.all(announced);shutdown.throwIfAborted();GatewayRuntime.prototype.activateTypedConsumers.call(gateway);return workers;
 }catch(error){
  for(const worker of workers)worker.abort();await Promise.all(workers.map(worker=>worker.join()));
  for(const subscription of subscriptions)subscription.dispose();if(receivers!==undefined)for(const receiver of Object.values(receivers))receiver.dispose();throw error;
 }
}
