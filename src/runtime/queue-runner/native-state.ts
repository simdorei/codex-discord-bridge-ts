import {types} from 'node:util';
import {type IStateAccessFacade} from '../../store/state-access-facade.ts';
import {snapshotStoredQueueJob,type StoredQueueJob} from '../../store/queue-read.ts';
import {createNativeQueueReadState} from './native-read-state.ts';
import {OwnedWorkerSlot} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
type Operation='Preflight'|'Claim'|'Failure'|'Running';
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
/** Four reads and four serializable attempt writes only. Original store functions
 * own the entire synchronous transaction. No backend awaits occur inside a TX.
 * An admitted operation is joined even after its result deadline. */
export function createNativeQueueState(path:string,timeoutMs=5000):IStateAccessFacade{
 const reads=createNativeQueueReadState(path,timeoutMs),fixed=pinNativeRuntimePath(path);
 function requirePath(given:string):void{if(given!==path)throw new TypeError('Queue facade differs from original installation binding');}
 async function run(operation:Operation,fields:object):Promise<StoredQueueJob|null>{
  const data={path:fixed,operation,...fields};if(boundedSerdeByteCount(data,LIMIT)===null)throw new RangeError('Queue attempt input exceeds native wire boundary');
  const slot=new OwnedWorkerSlot('Control');let admitted=false;
  try{
   const url=new URL('./native-attempt-worker.ts',import.meta.url);
   // Already-dispatched outcomes may wait in the bounded completion FIFO.
   // Caller cancellation must not discard an accepted backend outcome.
   const pending=operation==='Failure'||operation==='Running'?slot.runControlCompletion(url,data,timeoutMs):slot.run(url,data,timeoutMs);admitted=slot.busy;
   let raw:unknown;try{raw=await pending;}finally{await slot.join();}
   if(boundedSerdeByteCount(raw,LIMIT)===null||own(raw,'ok')!==true)throw new Error('No complete native attempt acknowledgement');
   const value=own(raw,'value');return value===null?null:snapshotStoredQueueJob(value as StoredQueueJob);
  }catch(error){if(admitted)throw new NativeQueueAttemptUnconfirmedError(operation,error);throw error;}
 }
 return Object.freeze({...reads,
  async recordPreflightFailure(given:string,jobId:string,gen:bigint,error:string):Promise<StoredQueueJob|null>{requirePath(given);requireDiscordText(jobId);generation(gen);requireDiscordText(error);return run('Preflight',{jobId,generation:gen,error});},
  async tryBeginAttempt(given:string,jobId:string,baselineTurnIds:readonly string[],gen:bigint):Promise<StoredQueueJob|null>{requirePath(given);requireDiscordText(jobId);generation(gen);const ids=baseline(baselineTurnIds);return run('Claim',{jobId,baseline:ids,generation:gen});},
  async recordStartFailureIfClaimed(given:string,claimed:StoredQueueJob,error:string,ambiguous:boolean):Promise<StoredQueueJob|null>{requirePath(given);const claim=snapshotStoredQueueJob(claimed);requireDiscordText(error);if(typeof ambiguous!=='boolean')throw new TypeError('Expected ambiguity boolean');return run('Failure',{claim,error,ambiguous});},
  async markRunningWithResidentIfClaimed(given:string,claimed:StoredQueueJob,turnId:string,residentId:string|null):Promise<StoredQueueJob|null>{requirePath(given);const claim=snapshotStoredQueueJob(claimed);requireDiscordText(turnId);if(residentId!==null)requireDiscordText(residentId);return run('Running',{claim,turnId,residentId});},
 });
}
