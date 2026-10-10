import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {AdmissionGate} from '../../admission/drain-gate.ts';
import {AppServerTurnBackend} from '../app-server-turn-backend.ts';
import {QueueStartCoordinator} from '../queue-runner/start-coordinator.ts';
import {REVIEWED_INCIDENT_THREAD} from '../../store/async-resolution-policy.ts';
import {stabilizeAfterQueueRecovery,runtimeQueueRecoveryServer} from '../queue-recovery-transport.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {types} from 'node:util';
type BackendOptions=NonNullable<ConstructorParameters<typeof AppServerTurnBackend>[2]>;
/** Native exact-ID queue portion of build_executor. Policy-install failure is
 * reported and the original per-incident fallback remains held; recovery and
 * generation stabilization must succeed before exposing this coordinator.
 * Historical bridge ownership transfers are deliberately not replayed.
 * Caller owns server cleanup on any error. This starts no workers or gateway and
 * does not implement Pro preprocessing or prompt-intake startup recovery. */
export async function buildRecoveredRuntimeQueue(path:string,server:PortableResidentLifecycle,admission:AdmissionGate,render:(error:unknown)=>string,reportPolicyFailure:(thread:string,error:unknown)=>void,notifyDeliveryReady:()=>void,options:BackendOptions={}){
 requireDiscordText(path);
 for(const fn of [reportPolicyFailure,notifyDeliveryReady])if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected synchronous runtime queue callback');
 PortableResidentLifecycle.prototype.lifecycleSnapshot.call(server);AdmissionGate.prototype.isSealed.call(admission);
 const backend=new AppServerTurnBackend(server,render,cloneOwnedSerdeValue(options) as BackendOptions);
 const queue=new QueueStartCoordinator(path,backend,{admission,notifyDeliveryReady:()=>invokeSynchronousVoid(notifyDeliveryReady,queue,[])});
 try{await queue.installReviewedRecoveryPolicy();}catch(error){invokeSynchronousVoid(reportPolicyFailure,queue,[REVIEWED_INCIDENT_THREAD,error]);}
 const recovery=await queue.recover();
 const restarted=await stabilizeAfterQueueRecovery(runtimeQueueRecoveryServer(server));
 return Object.freeze({queue,backend,recovery,restarted});
}
