import {types} from 'node:util';
import {MirrorSnapshotOwner} from './snapshot-owner.ts';
import type {MirrorDispatchResult} from './dispatch.ts';
import type {MirrorTargetFinished} from './execution.ts';
const SECOND=1000000000n,active=new WeakSet<MirrorSnapshotOwner>();
export class MirrorEpochError extends Error{readonly settled:readonly MirrorTargetFinished[];readonly unreported:readonly MirrorDispatchResult[];constructor(cause:unknown,settled:readonly MirrorTargetFinished[],unreported:readonly MirrorDispatchResult[]){super('Mirror discovery epoch failed after owned work joined',{cause});this.name='MirrorEpochError';this.settled=settled;this.unreported=unreported;}}
function callback(f:unknown):void{if(typeof f!=='function'||types.isProxy(f)||types.isAsyncFunction(f)||types.isGeneratorFunction(f))throw new TypeError('Expected synchronous mirror observer');}
function observed(value:unknown):void{if(value===undefined)return;if(types.isPromise(value))void Promise.prototype.then.call(value,undefined,()=>undefined);throw new TypeError('Mirror observer must return void');}
async function waitNext(owner:MirrorSnapshotOwner,next:bigint,signal:AbortSignal):Promise<void>{
 signal.throwIfAborted();const left=next-process.hrtime.bigint();if(left<=0n)return;const waitAbort=new AbortController(),tick={tick:true};let timer:ReturnType<typeof setTimeout>|undefined;let abort:(()=>void)|undefined;let observation:Promise<boolean>|undefined;
 try{await new Promise<void>((resolve,reject)=>{
  abort=()=>{waitAbort.abort(signal.reason);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});
  timer=setTimeout(resolve,Math.min(1000,Math.max(1,Number((left+999999n)/1000000n))));
  if(owner.activeCount>0){observation=owner.waitForSettlement(waitAbort.signal);void observation.then(()=>resolve(),reject);}
  if(signal.aborted)abort();
 });}finally{if(timer!==undefined)clearTimeout(timer);if(abort!==undefined)signal.removeEventListener('abort',abort);waitAbort.abort(tick);await observation?.catch(()=>undefined);}
}
/** One source background epoch: immediate discovery, then one-second skipped
 * ticks racing a single removable completion observer. A shared discovery error
 * ends the epoch after all owned work joins; outer global backoff is separate.
 * Target failures remain local in MirrorDispatch. No external service starts.
 * Reports must be synchronous bounded observers; slow I/O belongs elsewhere. */
export async function runMirrorEpoch(owner:MirrorSnapshotOwner,onResults:(rows:readonly MirrorDispatchResult[])=>void,onDiscovery:()=>void,signal:AbortSignal):Promise<readonly MirrorTargetFinished[]>{
 if(!(owner instanceof MirrorSnapshotOwner))throw new TypeError('Expected native mirror snapshot owner');callback(onResults);callback(onDiscovery);if(types.isProxy(signal)||!(signal instanceof AbortSignal))throw new TypeError('Expected owned abort signal');if(active.has(owner))throw new TypeError('Mirror epoch already running');active.add(owner);
 const origin=process.hrtime.bigint();let next=origin,failed=false,failure:unknown;let settled:readonly MirrorTargetFinished[]=[];let unreported:readonly MirrorDispatchResult[]=[];let closing:Promise<readonly MirrorTargetFinished[]>|undefined;
 const stop=()=>{closing=owner.close(signal.reason);void closing.catch(()=>undefined);};signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
 try{while(true){
  signal.throwIfAborted();if(process.hrtime.bigint()>=next){await owner.refresh(signal);signal.throwIfAborted();observed(onDiscovery());signal.throwIfAborted();next=origin+((process.hrtime.bigint()-origin)/SECOND+1n)*SECOND;}
  const rows=owner.harvest();unreported=rows;if(rows.length!==0)observed(onResults(rows));unreported=[];signal.throwIfAborted();owner.dispatch();await waitNext(owner,next,signal);
 }}catch(error){if(!signal.aborted||error!==signal.reason){failed=true;failure=error;}}
 finally{try{settled=await (closing??owner.close(signal.aborted?signal.reason:failure));}finally{signal.removeEventListener('abort',stop);active.delete(owner);}}
 if(failed)throw new MirrorEpochError(failure,settled,unreported);return settled;
}
