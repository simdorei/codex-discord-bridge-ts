import {types} from 'node:util';
import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {QueueStartCoordinator} from '../queue-runner/start-coordinator.ts';
import {NewReplyReconciler} from '../new-reply/reconciler.ts';
import {recoverNewReply} from '../new-reply/recovery.ts';
import {DelayedTicks,type TickSource} from '../delayed-ticks.ts';
import {RuntimeMonitoredWorker,RuntimeWorkerExitChannel} from './monitored-worker.ts';
export class NewReplyWorkerError extends Error{
 readonly phase:'verification'|'recovery';readonly jobId:string|null;
 constructor(phase:'verification'|'recovery',jobId:string|null,cause:unknown){super('New reply worker retained original work for reconciliation',{cause});this.name='NewReplyWorkerError';this.phase=phase;this.jobId=jobId;}
}
/** Immediate first bounded batch, then source one-second delayed ticks. The queue
 * supplies the same database and delivery notifier as accepted commands. Each
 * reply gets a five-second cancellation request, never a detached Promise race.
 * Shutdown waits for native exit and receipt/HTTP settlement before worker join.
 * Caller owns shared HTTP and starts one worker; this is not a service entrypoint. */
export function startNewReplyRuntimeWorker(queue:QueueStartCoordinator,http:DiscordChannelClient,shutdown:AbortSignal,notifier:RuntimeWorkerExitChannel,report:(error:unknown)=>void,ticks?:()=>TickSource):RuntimeMonitoredWorker{
 if(types.isProxy(shutdown)||!(shutdown instanceof AbortSignal))throw new TypeError('Expected new reply shutdown signal');
 for(const fn of [report,...(ticks===undefined?[]:[ticks])])if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected synchronous new reply worker configuration');
 const database=Object.getOwnPropertyDescriptor(QueueStartCoordinator.prototype,'dbPath')!.get!.call(queue) as string;
 Object.getOwnPropertyDescriptor(DiscordChannelClient.prototype,'activeRequests')!.get!.call(http);
 const emit=(error:unknown)=>invokeSynchronousVoid(report,{},[error]);
 return new RuntimeMonitoredWorker('new-first-reply-verification',notifier,async force=>{
  const signal=AbortSignal.any([shutdown,force]);if(signal.aborted)return {ok:true};
  const reconcile=new NewReplyReconciler(database,emit);let timer:TickSource|undefined;
  const stop=()=>timer?.close();
  try{
   timer=ticks===undefined?new DelayedTicks(1000):ticks();signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
   while(!signal.aborted){
    let records;
    try{records=await reconcile.runOnce(signal);}catch(cause){if(signal.aborted)break;emit(new NewReplyWorkerError('verification',null,cause));await timer.wait();continue;}
    if(records.length>0)QueueStartCoordinator.prototype.notifyDeliveryReady.call(queue);
    for(const record of records){
     if(signal.aborted)break;
     const deadline=new AbortController(),expired=new Error('New reply recovery deadline exceeded; send outcome may be unknown'),timeout=setTimeout(()=>deadline.abort(expired),5000);
     try{await recoverNewReply(database,http,record,emit,AbortSignal.any([signal,deadline.signal]));}
     catch(cause){if(!signal.aborted)emit(new NewReplyWorkerError('recovery',record.identity.job_id,cause));}
     finally{clearTimeout(timeout);}
    }
    if(records.length>0)QueueStartCoordinator.prototype.notifyDeliveryReady.call(queue);
    if(!signal.aborted)await timer.wait();
   }
   return {ok:true};
  }catch(error){return {ok:false,error};}
  finally{signal.removeEventListener('abort',stop);try{timer?.close();}finally{await reconcile.close(signal.reason);}}
 });
}
