import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import type {DiscordReceiptTransport} from '../completion/receipt-sender.ts';
import {captureBoundMirrorWorkerConfig,runBoundMirrorWorker,type BoundMirrorWorkerConfig} from '../session-mirror/bound-poll.ts';
import type {MirrorRunnerObservation} from '../session-mirror/runner.ts';
import type {MirrorTargetFinished} from '../session-mirror/execution.ts';
import {RuntimeMonitoredWorker,RuntimeWorkerExitChannel} from './monitored-worker.ts';
export type RuntimeMirrorObservation=MirrorRunnerObservation|{readonly kind:'Shutdown';readonly settled:readonly MirrorTargetFinished[]};
export class MirrorShutdownReportError extends Error{
 readonly settled:readonly MirrorTargetFinished[];
 constructor(cause:unknown,settled:readonly MirrorTargetFinished[]){super('Joined mirror shutdown evidence could not be reported',{cause});this.name='MirrorShutdownReportError';this.settled=settled;}
}
/** Source enabled-only session-mirror worker, registered with the shared runtime
 * exit channel and common-deadline shutdown owner. Captures config before the
 * monitored callback's microtask; joins actual native/HTTP work on both graceful
 * and forced abort. Final unharvested records are reported or retained in error,
 * never discarded just because the outer worker returns void in Rust.
 * Requires explicit bound cursors and trusted transport; no service starts here. */
export function startSessionMirrorRuntimeWorker(enabled:boolean,config:BoundMirrorWorkerConfig,transport:DiscordReceiptTransport,shutdown:AbortSignal,notifier:RuntimeWorkerExitChannel,render:(error:unknown)=>string,report:(event:RuntimeMirrorObservation)=>void):RuntimeMonitoredWorker|null{
 if(typeof enabled!=='boolean')throw new TypeError('Expected mirror enabled flag');if(!enabled)return null;
 if(types.isProxy(shutdown)||!(shutdown instanceof AbortSignal))throw new TypeError('Expected runtime shutdown signal');
 const {config:captured,transport:pinned,render:capturedRender,report:capturedReport}=captureRuntimeMirrorInput(config,transport,render,report);
 return new RuntimeMonitoredWorker('session-mirror',notifier,async force=>{
  try{
   const settled=await runBoundMirrorWorker(captured,pinned,capturedRender,capturedReport,AbortSignal.any([shutdown,force]));
   if(settled.length!==0)try{capturedReport(Object.freeze({kind:'Shutdown',settled}));}catch(error){throw new MirrorShutdownReportError(error,settled);}
   return {ok:true};
  }catch(error){return {ok:false,error};}
 });
}

/** Pure capture for multi-worker startup: validates every mirror input before any task is allocated. */
export function captureRuntimeMirrorInput(config:BoundMirrorWorkerConfig,transport:DiscordReceiptTransport,render:(error:unknown)=>string,report:(event:RuntimeMirrorObservation)=>void){
 const captured=captureBoundMirrorWorkerConfig(config),send=own(transport,'sendValidated');
 for(const fn of [send,render,report])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned mirror callback');
 if(types.isAsyncFunction(render)||types.isAsyncFunction(report))throw new TypeError('Expected synchronous mirror diagnostic');
 const pinned:DiscordReceiptTransport=Object.freeze({sendValidated:(request:Parameters<DiscordReceiptTransport['sendValidated']>[0])=>Reflect.apply(send as Function,transport,[request])});
 const reportContext=Object.freeze({});
 return Object.freeze({config:captured,transport:pinned,render,report:(event:RuntimeMirrorObservation)=>invokeSynchronousVoid(report,reportContext,[event])});
}
