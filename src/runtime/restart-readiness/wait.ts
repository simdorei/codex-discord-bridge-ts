import {setTimeout as delay} from 'node:timers/promises';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {RestartReadinessState} from '../../restart/thread-state.ts';
import {inspectRuntimeRestartReadiness} from './inspect.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
export interface RestartWaitClock{readonly nowNs:()=>bigint;readonly sleep:(milliseconds:number,signal?:AbortSignal)=>Promise<void>;}
const nativeClock:RestartWaitClock=Object.freeze({nowNs:()=>process.hrtime.bigint(),sleep:async(ms:number,signal?:AbortSignal)=>{try{await delay(ms,undefined,{signal});}catch(error){if(signal?.aborted)throw signal.reason;throw error;}}});
export class RestartReadinessDeadlineError extends Error{
 readonly lastReason:string;
 constructor(lastReason:string){super(`restart readiness timed out: ${lastReason}`);this.name='RestartReadinessDeadlineError';this.lastReason=lastReason;}
}
function duration(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<0n||value>18446744073709551615n)throw new RangeError('Expected u64 restart wait seconds');}
/** Source wait_with_client ordering: inspect first, return on Ready, then compare
 * elapsed and sleep at most remaining. The wait bound is NOT a forced native-I/O
 * termination deadline. In-flight checks/sleeps must settle on cancellation; this
 * owner never fabricates their termination or closes the borrowed resident. */
export async function waitForRestartReadiness(check:()=>Promise<RestartReadinessState>,waitSeconds:bigint,pollIntervalMs=5000,signal?:AbortSignal,clock:RestartWaitClock=nativeClock):Promise<void>{
 signal?.throwIfAborted();duration(waitSeconds);
 if(!Number.isSafeInteger(pollIntervalMs)||pollIntervalMs<0||pollIntervalMs>2147483647)throw new RangeError('Invalid restart polling interval');
 const now=own(clock,'nowNs'),sleep=own(clock,'sleep');
 for(const fn of [check,now,sleep])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected passive restart wait callback');
 if(types.isAsyncFunction(now))throw new TypeError('Expected synchronous monotonic restart clock');
 let previous=0n;const time=()=>{const t=Reflect.apply(now as Function,clock,[]);if(typeof t!=='bigint'||t<previous)throw new RangeError('Invalid or backwards restart monotonic clock');previous=t;return t;};
 const started=time(),budget=waitSeconds*1000000000n,poll=BigInt(pollIntervalMs)*1000000n;
 for(;;){
  signal?.throwIfAborted();const work=check();if(!types.isPromise(work))throw new TypeError('Restart inspection must return native Promise');const state=await work;signal?.throwIfAborted();
  const status=own(state,'status');if(status==='Ready')return;if(status!=='Blocked')throw new TypeError('Unknown restart readiness state');const reason=own(state,'reason');requireDiscordText(reason);if(reason.length>65536)throw new RangeError('Restart blocker diagnostic exceeds budget');
  const elapsed=time()-started;if(elapsed>=budget)throw new RestartReadinessDeadlineError(reason);
  const remaining=budget-elapsed,nanos=poll<remaining?poll:remaining,milliseconds=Number((nanos+999999n)/1000000n);
  const sleeping=Reflect.apply(sleep as Function,clock,[milliseconds,signal]);if(!types.isPromise(sleeping))throw new TypeError('Restart sleep must return native Promise');await sleeping;signal?.throwIfAborted();
 }
}
/** Concrete maintenance wait over the same borrowed resident and bounded central
 * snapshot reader. No startup, close, admission seal or process restart occurs. */
export async function waitRuntimeRestartReadiness(path:string,server:PortableResidentLifecycle,quietSeconds:bigint,waitSeconds:bigint,requestTimeoutMs:number,signal?:AbortSignal):Promise<void>{
 requireDiscordText(path);duration(quietSeconds);duration(waitSeconds);
 const generation=PortableResidentLifecycle.prototype.generation.call(server);
 const same=()=>{if(PortableResidentLifecycle.prototype.generation.call(server)!==generation)throw new Error('Restart readiness resident generation changed');};
 await waitForRestartReadiness(async()=>{same();const result=await inspectRuntimeRestartReadiness(path,server,quietSeconds,requestTimeoutMs,signal);same();return result;},waitSeconds,5000,signal);
}
