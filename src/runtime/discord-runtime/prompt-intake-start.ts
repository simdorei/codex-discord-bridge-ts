import {types} from 'node:util';
import {AdmissionGate} from '../../admission/drain-gate.ts';
import {RuntimeCommandExecutor} from '../action-executor/command-executor.ts';
import {runPromptIntakeRecoveryWorker,type IntakeWorkerError} from '../prompt-intake/recovery-worker.ts';
import type {TickSource} from '../delayed-ticks.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {RuntimeMonitoredWorker,RuntimeWorkerExitChannel} from './monitored-worker.ts';
/** Binds periodic recovery to the same executor/intake and shared drain gate.
 * Default delay is the source 30 seconds. Optional tick factory is an explicit
 * scheduler test seam, allocated only inside the owned callback. Startup claim
 * release remains separate; graceful/forced cancellation joins the whole current
 * recovery cycle before releasing its admission. Caller starts one such worker. */
export function startPromptIntakeRuntimeWorker(executor:RuntimeCommandExecutor,admission:AdmissionGate,shutdown:AbortSignal,notifier:RuntimeWorkerExitChannel,report:(event:IntakeWorkerError)=>void,ticks?:()=>TickSource):RuntimeMonitoredWorker{
 if(types.isProxy(shutdown)||!(shutdown instanceof AbortSignal))throw new TypeError('Expected intake shutdown signal');
 for(const fn of [report,...(ticks===undefined?[]:[ticks])])if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected synchronous intake worker configuration');
 const processor=RuntimeCommandExecutor.prototype.promptIntakeRecoveryServices.call(executor);AdmissionGate.prototype.isSealed.call(admission);
 const gate=Object.freeze({tryEnter:()=>AdmissionGate.prototype.tryEnter.call(admission)}),context=Object.freeze({});
 return new RuntimeMonitoredWorker('prompt-intake-recovery',notifier,async force=>{
  try{await runPromptIntakeRecoveryWorker(processor,gate,AbortSignal.any([shutdown,force]),{...(ticks===undefined?{}:{ticks}),onError:event=>invokeSynchronousVoid(report,context,[event])});return {ok:true};}catch(error){if(force.aborted&&error===force.reason)throw error;return {ok:false,error};}
 });
}
