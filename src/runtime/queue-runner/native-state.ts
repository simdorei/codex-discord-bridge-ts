import {snapshotStoredDelivery,type StoredDelivery} from '../../store/delivery.ts';
import type {PendingGoalProgress} from '../../store/goal-progress.ts';
import type {TerminalReleaseOwner} from '../../store/async-resolution-terminal.ts';
import {types} from 'node:util';
import {type IStateAccessFacade} from '../../store/state-access-facade.ts';
import {snapshotStoredQueueJob,type StoredQueueJob} from '../../store/queue-read.ts';
import {createNativeQueueSubmissionState} from './native-submission-state.ts';
import {OwnedWorkerSlot} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
type Operation='Preflight'|'Claim'|'Failure'|'Running'|'GoalWaiting'|'GoalAttach'|'StageFinal'|'StageGoal';
const LIMIT=16*1024*1024;
export class NativeQueueAttemptUnconfirmedError extends Error{
 readonly operation:Operation;
 constructor(operation:Operation,cause:unknown){super('Queue attempt result unconfirmed after actual native join; no inferred lost claim or automatic retry',{cause});this.name='NativeQueueAttemptUnconfirmedError';this.operation=operation;}
}
function generation(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<-(1n<<63n)||value>=(1n<<63n))throw new TypeError('Expected signed i64 generation');}
function baseline(input:readonly string[]):string[]{
 if(types.isProxy(input)||!Array.isArray(input)||boundedSerdeByteCount(input,LIMIT)===null)throw new TypeError('Expected bounded baseline data array');
 const result:string[]=[];for(let i=0;i<input.length;i++){const value=own(input,String(i));requireDiscordText(value);result.push(value);}return result;
}
/** Five reads, three submissions and eight explicit serializable lifecycle writes. Original store functions
 * own the entire synchronous transaction. No backend awaits occur inside a TX.
 * An admitted operation is joined even after its result deadline. */
export function createNativeQueueState(path:string,timeoutMs=5000):IStateAccessFacade{
 const reads=createNativeQueueSubmissionState(path,timeoutMs),fixed=pinNativeRuntimePath(path);
 function requirePath(given:string):void{if(given!==path)throw new TypeError('Queue facade differs from original installation binding');}
 async function run(operation:Operation,fields:object):Promise<unknown>{
  const data={path:fixed,operation,...fields};if(boundedSerdeByteCount(data,LIMIT)===null)throw new RangeError('Queue attempt input exceeds native wire boundary');
  const slot=new OwnedWorkerSlot('Control');let admitted=false;
  try{
   const url=new URL('./native-attempt-worker.ts',import.meta.url);
   // Already-dispatched outcomes may wait in the bounded completion FIFO.
   // Caller cancellation must not discard an accepted backend outcome.
   const pending=operation==='Preflight'||operation==='Claim'?slot.run(url,data,timeoutMs):slot.runControlCompletion(url,data,timeoutMs);admitted=slot.busy;
   let raw:unknown;try{raw=await pending;}finally{await slot.join();}
   if(boundedSerdeByteCount(raw,LIMIT)===null||own(raw,'ok')!==true)throw new Error('No complete native attempt acknowledgement');
   return own(raw,'value');
  }catch(error){if(admitted)throw new NativeQueueAttemptUnconfirmedError(operation,error);throw error;}
 }
 async function row(operation:'Preflight'|'Claim'|'Failure'|'Running',fields:object):Promise<StoredQueueJob|null>{
  const value=await run(operation,fields);try{return value===null?null:snapshotStoredQueueJob(value as StoredQueueJob);}catch(error){throw new NativeQueueAttemptUnconfirmedError(operation,error);}
 }
 async function goal(operation:'GoalWaiting'|'GoalAttach',fields:object):Promise<boolean>{
  const value=await run(operation,fields);if(typeof value!=='boolean')throw new NativeQueueAttemptUnconfirmedError(operation,new TypeError('Expected exact goal mutation boolean'));return value;
 }
 function progress(value:unknown):PendingGoalProgress|null{
  if(value===null)return null;
  const jobId=own(value,'jobId'),thread=own(value,'thread'),turn=own(value,'turn'),channel=own(value,'channel'),content=own(value,'content'),lastError=own(value,'lastError');
  if(jobId!==null)requireDiscordText(jobId);requireDiscordText(thread);requireDiscordText(turn);generation(channel);requireDiscordText(content);requireDiscordText(lastError);
  return {jobId,thread,turn,channel,content,lastError};
 }
 return Object.freeze({...reads,
  async stageOwnedQueueCompletion(given:string,input:StoredQueueJob,content:string,now:number,releaseInput:TerminalReleaseOwner|null=null):Promise<StoredDelivery>{
   requirePath(given);const expected=snapshotStoredQueueJob(input);requireDiscordText(content);if(typeof now!=='number')throw new TypeError('Expected timestamp number');
   let release:TerminalReleaseOwner|null=null;if(releaseInput!==null){const observer=own(releaseInput,'observer'),gen=own(releaseInput,'generation');requireDiscordText(observer);generation(gen);release={observer,generation:gen};}
   const result=await run('StageFinal',{expected,content,now,release});try{return snapshotStoredDelivery(result as StoredDelivery);}catch(error){throw new NativeQueueAttemptUnconfirmedError('StageFinal',error);}
  },
  async stageOwnedGoalProgress(given:string,input:StoredQueueJob,content:string):Promise<PendingGoalProgress|null>{
   requirePath(given);const expected=snapshotStoredQueueJob(input);requireDiscordText(content);const result=await run('StageGoal',{expected,content});try{
    const pending=progress(result);
    if(content===''?pending!==null:pending===null||pending.jobId!==expected.jobId||pending.thread!==expected.targetThreadId||pending.turn!==expected.turnId||pending.channel!==expected.channelId||pending.content!==content)throw new TypeError('Goal acknowledgement differs from captured custody');
    return pending;
   }catch(error){throw new NativeQueueAttemptUnconfirmedError('StageGoal',error);}
  },
  async markGoalWaiting(given:string,jobId:string,turnId:string,gen:bigint):Promise<boolean>{requirePath(given);requireDiscordText(jobId);requireDiscordText(turnId);generation(gen);return goal('GoalWaiting',{jobId,turnId,generation:gen});},
  async attachGoalTurnObservedIfOwned(given:string,input:StoredQueueJob,turnId:string,observationGeneration:bigint):Promise<boolean>{requirePath(given);const expected=snapshotStoredQueueJob(input);requireDiscordText(turnId);generation(observationGeneration);return goal('GoalAttach',{expected,turnId,observationGeneration});},
  async recordPreflightFailure(given:string,jobId:string,gen:bigint,error:string):Promise<StoredQueueJob|null>{requirePath(given);requireDiscordText(jobId);generation(gen);requireDiscordText(error);return row('Preflight',{jobId,generation:gen,error});},
  async tryBeginAttempt(given:string,jobId:string,baselineTurnIds:readonly string[],gen:bigint):Promise<StoredQueueJob|null>{requirePath(given);requireDiscordText(jobId);generation(gen);const ids=baseline(baselineTurnIds);return row('Claim',{jobId,baseline:ids,generation:gen});},
  async recordStartFailureIfClaimed(given:string,claimed:StoredQueueJob,error:string,ambiguous:boolean):Promise<StoredQueueJob|null>{requirePath(given);const claim=snapshotStoredQueueJob(claimed);requireDiscordText(error);if(typeof ambiguous!=='boolean')throw new TypeError('Expected ambiguity boolean');return row('Failure',{claim,error,ambiguous});},
  async markRunningWithResidentIfClaimed(given:string,claimed:StoredQueueJob,turnId:string,residentId:string|null):Promise<StoredQueueJob|null>{requirePath(given);const claim=snapshotStoredQueueJob(claimed);requireDiscordText(turnId);if(residentId!==null)requireDiscordText(residentId);return row('Running',{claim,turnId,residentId});},
 });
}
