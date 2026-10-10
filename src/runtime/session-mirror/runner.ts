import {types} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import {requireDiscordText} from '../../discord/text.ts';
import {MirrorSnapshotOwner} from './snapshot-owner.ts';
import {runMirrorEpoch,MirrorEpochError} from './epoch.ts';
import {SessionMirrorRetryState,type SessionMirrorRetryDecision} from './retry.ts';
import type {MirrorDispatchResult} from './dispatch.ts';
import type {MirrorTargetFinished} from './execution.ts';
export type MirrorRunnerObservation={readonly kind:'Targets';readonly rows:readonly MirrorDispatchResult[]}|{readonly kind:'SharedFailure';readonly failure:MirrorEpochError;readonly decision:SessionMirrorRetryDecision};
let running=false;
export function mirrorRunnerBusy():boolean{return running;}
function sync(f:unknown):void{if(typeof f!=='function'||types.isProxy(f)||types.isAsyncFunction(f)||types.isGeneratorFunction(f))throw new TypeError('Expected synchronous owned mirror runner callback');}
function returned(value:unknown):unknown{if(types.isPromise(value)){void Promise.prototype.then.call(value,undefined,()=>undefined);throw new TypeError('Mirror runner callback returned Promise');}return value;}
/** Single process runner. Factory must create a fresh configured native owner;
 * it is called only after the preceding epoch joined all discovery/target work.
 * Only shared discovery/epoch failures use global source backoff, reset on every
 * successful discovery. Target retry remains independent inside each owner.
 * Failed reporting is not retried or discarded. This starts no Discord client
 * or service and does not provide the missing durable cursor/effect adapter. */
export async function runMirrorWorker(factory:()=>MirrorSnapshotOwner,render:(error:unknown)=>string,report:(event:MirrorRunnerObservation)=>void,signal:AbortSignal):Promise<readonly MirrorTargetFinished[]>{
 sync(factory);sync(render);sync(report);if(types.isProxy(signal)||!(signal instanceof AbortSignal))throw new TypeError('Expected owned abort signal');if(signal.aborted)return [];if(running)throw new TypeError('Mirror worker already running');running=true;
 const used=new WeakSet<MirrorSnapshotOwner>(),retry=new SessionMirrorRetryState(),origin=process.hrtime.bigint();let delay=0;
 const notify=(event:MirrorRunnerObservation)=>{if(returned(report(Object.freeze(event)))!==undefined)throw new TypeError('Mirror runner reporter must return void');};
 try{while(true){
  if(signal.aborted)return [];if(delay!==0){try{await sleep(delay,undefined,{signal});}catch(error){if(signal.aborted)return [];throw error;}}if(signal.aborted)return [];
  const owner=returned(factory());if(!(owner instanceof MirrorSnapshotOwner))throw new TypeError('Factory did not return native mirror owner');if(used.has(owner))throw new TypeError('Mirror runner requires a fresh owner after each ended epoch');used.add(owner);
  try{return await runMirrorEpoch(owner,rows=>notify({kind:'Targets',rows}),()=>{retry.onSuccess();},signal);}
  catch(error){
   if(!(error instanceof MirrorEpochError)||error.unreported.length!==0)throw error;
   try{const text=returned(render(error.cause));requireDiscordText(text);if(Buffer.byteLength(text)>16384)throw new RangeError('Mirror shared diagnostic budget exceeded');
   const decision=retry.onFailure(process.hrtime.bigint()-origin,text);delay=Number(decision.retryAfterNanoseconds/1000000n);
   notify({kind:'SharedFailure',failure:error,decision});}catch(reportError){throw new AggregateError([error,reportError],'Mirror failure reporter failed; no new epoch started');}
  }
 }}finally{running=false;}
}
