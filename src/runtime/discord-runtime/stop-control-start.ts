import {types} from 'node:util';
import {RuntimeCommandExecutor} from '../action-executor/command-executor.ts';
import {StopControlWorker,type StopWorkerFailure} from '../action-executor/stop-worker.ts';
import type {TickSource} from '../delayed-ticks.ts';
import {RuntimeMonitoredWorker,RuntimeWorkerExitChannel} from './monitored-worker.ts';
/** One serial Stop worker built from the same executor as accepted commands.
 * Original queue locks, bridge selection and native custody owner are retained.
 * Default skipped-tick interval is 250ms and cooperative cycle budget 2s.
 * Actual common-deadline shutdown joins this task; no detached task per Stop. */
export function startStopControlRuntimeWorker(executor:RuntimeCommandExecutor,shutdown:AbortSignal,notifier:RuntimeWorkerExitChannel,report:(event:StopWorkerFailure)=>void,ticks?:()=>TickSource):RuntimeMonitoredWorker{
 if(types.isProxy(shutdown)||!(shutdown instanceof AbortSignal))throw new TypeError('Expected stop worker shutdown signal');
 if(ticks!==undefined&&(typeof ticks!=='function'||types.isProxy(ticks)||types.isAsyncFunction(ticks)||types.isGeneratorFunction(ticks)))throw new TypeError('Expected synchronous stop tick factory');
 const control=RuntimeCommandExecutor.prototype.createStopControlWorker.call(executor,report);
 return new RuntimeMonitoredWorker('stop-control',notifier,async force=>{
  try{await StopControlWorker.prototype.run.call(control,AbortSignal.any([shutdown,force]),ticks);return {ok:true};}catch(error){if(force.aborted&&error===force.reason)throw error;return {ok:false,error};}
 });
}
