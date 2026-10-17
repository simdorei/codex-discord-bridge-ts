import {captureInteractionJournal,type InteractionJournal} from '../interaction-worker/journal.ts';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {isInteractionWorkQueue,type InteractionWorkQueue} from '../discord-dispatch/interaction-work.ts';
import {runInteractionWorker,type InteractionProcessor} from '../interaction-worker/worker.ts';
import {RuntimeMonitoredWorker,RuntimeWorkerExitChannel} from './monitored-worker.ts';
const consumed=new WeakSet<object>();
/** Owns the existing durable interaction receive loop. Returns only after its
 * callback enters so forced shutdown always reaches receiver cleanup. Graceful
 * shutdown drops only the original sender; existing dispatcher clones/reservations
 * must also finish. Forced shutdown drops buffered permits, but still joins the
 * actual in-flight business operation/custody/HTTP before publishing worker exit.
 * Noncooperative operations require the outer hard deadline, never fake success.
 * Business processor composition remains explicit and is not supplied here. */
export async function startInteractionRuntimeWorker(queue:InteractionWorkQueue,database:string,http:DiscordChannelClient,processor:InteractionProcessor,notifier:RuntimeWorkerExitChannel,interactionJournal?:InteractionJournal){
 if(!isInteractionWorkQueue(queue))throw new TypeError('Expected exact interaction work queue');requireDiscordText(database);
 Object.getOwnPropertyDescriptor(DiscordChannelClient.prototype,'activeRequests')!.get!.call(http);
 const journal=captureInteractionJournal(database,interactionJournal);
 const process=own(processor,'process'),notify=own(processor,'notifyDeliveryReady'),report=own(processor,'report');
 for(const f of [process,notify,report])if(typeof f!=='function'||types.isProxy(f)||types.isGeneratorFunction(f))throw new TypeError('Expected owned interaction processor');
 if(types.isAsyncFunction(notify)||types.isAsyncFunction(report))throw new TypeError('Expected synchronous interaction notifications');
 if(consumed.has(queue)||queue.snapshot().receiverDisposed)throw new TypeError('Interaction queue already consumed');
 const captured:InteractionProcessor={process:(work,custody)=>Reflect.apply(process as Function,processor,[work,custody]),notifyDeliveryReady:()=>invokeSynchronousVoid(notify as Function,processor,[]),report:(...args)=>invokeSynchronousVoid(report as Function,processor,args)};
 let entered!:()=>void;const started=new Promise<void>(r=>entered=r);consumed.add(queue);let worker:RuntimeMonitoredWorker;
 try{worker=new RuntimeMonitoredWorker('interaction',notifier,async force=>{
  let forceError:unknown,forceFailed=false;
  const cancel=()=>{try{queue.receiver.dispose();}catch(error){forceFailed=true;forceError=error;}};
  force.addEventListener('abort',cancel,{once:true});entered();
  try{await runInteractionWorker(queue,database,http,captured,journal);if(forceFailed)return {ok:false,error:forceError};return {ok:true};}
  catch(error){return {ok:false,error:forceFailed?new AggregateError([error,forceError],'Interaction operation and forced receiver cleanup failed'):error};}
  finally{force.removeEventListener('abort',cancel);}
 });}catch(error){consumed.delete(queue);throw error;}
 await started;
 return Object.freeze({worker,closeInput:()=>queue.sender.dispose()});
}
