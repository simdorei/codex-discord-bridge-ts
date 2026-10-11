import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {PortableAppServerSession,type PortableSessionConfig} from '../../app-server/portable-session.ts';
import {readThreadWithTimeout} from '../../app-server/requests.ts';
import {StateAccessFacade} from '../../store/state-access-facade.ts';
import {joinRestartSnapshotReader} from '../../store/restart-readiness.ts';
import {completeBeforeRuntimeShutdownDeadline} from '../discord-runtime/shutdown-deadline.ts';
import {inspectRestartReadiness} from './inspect.ts';
import {waitForRestartReadiness} from './wait.ts';
export interface OwnedRestartReadinessOptions {
 readonly quietSeconds:bigint;readonly waitSeconds:bigint;readonly requestTimeoutMs:number;
 readonly startupTimeoutMs:number;readonly closeTimeoutMs:number;
}
export class RestartReadinessStartupTimeoutError extends Error {
 readonly timeoutMs:number;
 constructor(timeoutMs:number){super(`restart readiness app-server startup timed out after ${timeoutMs} ms`);this.name='RestartReadinessStartupTimeoutError';this.timeoutMs=timeoutMs;}
}
export class RestartReadinessCleanupError extends AggregateError {
 readonly session:PortableAppServerSession;
 constructor(session:PortableAppServerSession,cleanup:unknown,failed:boolean,outcome:unknown){super(failed?[cleanup,outcome]:[cleanup],'Restart readiness native cleanup failed',{cause:cleanup});this.name='RestartReadinessCleanupError';this.session=session;}
}
function seconds(v:unknown):asserts v is bigint{if(typeof v!=='bigint'||v<0n||v>18446744073709551615n)throw new RangeError('Expected u64 restart seconds');}
function milliseconds(v:unknown):asserts v is number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0||v>2147483647)throw new RangeError('Invalid native readiness timeout');}
/** Owns one temporary non-Windows native client through read-only readiness and
 * actual disposal. No singleton/gateway/queue or real credentials are created.
 * Deadline expiry never means task/process completion: final unjoined ownership
 * uses the existing nonreturning runtime fail-stop. Descendant containment still
 * needs the platform owner. Startup cancellation has a separate cleanup reserve. */
export async function runOwnedRestartReadiness(path:string,config:PortableSessionConfig,input:OwnedRestartReadinessOptions,signal?:AbortSignal):Promise<void>{
 signal?.throwIfAborted();requireDiscordText(path);
 const quiet=own(input,'quietSeconds'),wait=own(input,'waitSeconds'),request=own(input,'requestTimeoutMs'),startup=own(input,'startupTimeoutMs'),close=own(input,'closeTimeoutMs');seconds(quiet);seconds(wait);milliseconds(request);milliseconds(startup);milliseconds(close);
 const captured=cloneOwnedSerdeValue(config) as PortableSessionConfig,abort=new AbortController(),combined=signal===undefined?abort.signal:AbortSignal.any([signal,abort.signal]);
 const startupError=new RestartReadinessStartupTimeoutError(startup),started=performance.now();
 const timer=setTimeout(()=>abort.abort(startupError),startup);
 let session:PortableAppServerSession;
 try{
  const pending=PortableAppServerSession.startObserved(captured,()=>({value:null,dispose(){}}),()=> 'restart readiness transport diagnostic',combined).then(r=>r.session);
  session=await completeBeforeRuntimeShutdownDeadline(started+startup+close,'restart-readiness-startup',pending);
 }finally{clearTimeout(timer);}
 let failed=false,outcome:unknown;
 try{
  signal?.throwIfAborted();
  await waitForRestartReadiness(()=>inspectRestartReadiness({snapshot:async()=>{try{return await StateAccessFacade.restartReadinessSnapshot(path,signal);}finally{await joinRestartSnapshotReader();}},readThread:(thread,timeout,s)=>{const r=readThreadWithTimeout(thread,false,timeout);return PortableAppServerSession.prototype.request.call(session,r.method,r.params,r.timeoutMs,undefined,s);},nowSeconds:()=>{const now=Date.now();if(!Number.isSafeInteger(now)||now<0)throw new RangeError('Invalid restart readiness wall clock');return BigInt(now)/1000n;}},quiet,request,signal),wait,5000,signal);
 }catch(error){failed=true;outcome=error;}
 try{await completeBeforeRuntimeShutdownDeadline(performance.now()+close,'restart-readiness-close',PortableAppServerSession.prototype.dispose.call(session));}
 catch(cleanup){throw new RestartReadinessCleanupError(session,cleanup,failed,outcome);}
 if(failed)throw outcome;
}
