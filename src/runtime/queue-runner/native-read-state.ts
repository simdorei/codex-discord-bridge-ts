import {createNativePromptIntakeState} from '../prompt-intake/native-state.ts';
import {types} from 'node:util';import {StateAccessFacade,type IStateAccessFacade} from '../../store/state-access-facade.ts';import {snapshotStoredQueueJob,type StoredQueueJob} from '../../store/queue-read.ts';import {OwnedWorkerSlot} from '../owned-worker-slot.ts';import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';import {requireDiscordText} from '../../discord/text.ts';import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
type Operation='List'|'Eligible'|'DeadTarget'|'AsyncDispatch';const LIMIT=16*1024*1024;
export class NativeQueueReadUnavailableError extends Error{readonly operation:Operation;constructor(operation:Operation,cause:unknown){super('Queue read unavailable after actual native join; no partial state or fallback',{cause});this.name='NativeQueueReadUnavailableError';this.operation=operation;}}
function jobs(input:unknown):StoredQueueJob[]{
 if(types.isProxy(input)||!Array.isArray(input)||boundedSerdeByteCount(input,LIMIT)===null)throw new TypeError('Expected bounded queue data array');const result:StoredQueueJob[]=[];
 for(let i=0;i<input.length;i++)result.push(snapshotStoredQueueJob(own(input,String(i)) as StoredQueueJob));return result;
}
/** Override only five explicit serializable async reads. Other facade functions retain
 * their exact identities and original execution. Every invocation owns and joins
 * its own short native slot; no persistent worker or lifetime is detached. */
export function createNativeQueueReadState(path:string,timeoutMs=5000):IStateAccessFacade{
 requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid queue store path');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid queue read deadline');const fixed=pinNativeRuntimePath(path);
 const requirePath=(given:string)=>{if(given!==path)throw new TypeError('Queue facade differs from original installation binding');};
 async function run(operation:Operation,fields:object):Promise<unknown>{
  const data={path:fixed,operation,...fields};if(boundedSerdeByteCount(data,LIMIT)===null)throw new RangeError('Queue read input exceeds native wire boundary');const slot=new OwnedWorkerSlot('Control');let admitted=false;
  try{const pending=slot.run(new URL('./native-read-state-worker.ts',import.meta.url),data,timeoutMs);admitted=slot.busy;let raw:unknown;try{raw=await pending;}finally{await slot.join();}if(boundedSerdeByteCount(raw,LIMIT)===null||own(raw,'ok')!==true)throw new Error('No complete native queue read');return own(raw,'value');}catch(error){if(admitted)throw new NativeQueueReadUnavailableError(operation,error);throw error;}
 }
 async function held(operation:'DeadTarget'|'AsyncDispatch',target:string):Promise<boolean>{
  requireDiscordText(target);if(Buffer.byteLength(target)>65536)throw new RangeError('Queue target exceeds native boundary');
  const result=await run(operation,{target});if(typeof result!=='boolean')throw new NativeQueueReadUnavailableError(operation,new TypeError('Expected exact admission boolean'));return result;
 }
 // Reuse the direct bound intake worker port. No worker calls another worker.
 const completed=createNativePromptIntakeState(path,timeoutMs).completedAppServerForkTargetForSource;
 return Object.freeze({...StateAccessFacade,
  completedAppServerForkTargetForSource:completed,
  async deadTargetHeld(given:string,target:string):Promise<boolean>{requirePath(given);return held('DeadTarget',target);},
  async asyncTargetDispatchHeld(given:string,target:string):Promise<boolean>{requirePath(given);return held('AsyncDispatch',target);},
  async listFiltered(given:string,target:string|null,generation:bigint|null):Promise<StoredQueueJob[]>{
   requirePath(given);if(target!==null){requireDiscordText(target);if(Buffer.byteLength(target)>65536)throw new RangeError('Queue target exceeds native boundary');}if(generation!==null&&(typeof generation!=='bigint'||generation<-(1n<<63n)||generation>=(1n<<63n)))throw new TypeError('Expected signed i64 generation or null');
   const raw=await run('List',{target,generation});try{return jobs(raw);}catch(error){throw new NativeQueueReadUnavailableError('List',error);}
  },
  async eligibleJobs(given:string,input:readonly StoredQueueJob[]):Promise<StoredQueueJob[]>{
   requirePath(given);const fixedJobs=jobs(input),raw=await run('Eligible',{jobs:fixedJobs});try{
    if(types.isProxy(raw)||!Array.isArray(raw))throw new TypeError('Invalid eligible queue indexes');const result:StoredQueueJob[]=[];let previous=-1;
    for(let i=0;i<raw.length;i++){const index=own(raw,String(i));if(typeof index!=='number'||!Number.isSafeInteger(index)||index<=previous||index>=fixedJobs.length)throw new TypeError('Invalid eligible queue position');previous=index;result.push(fixedJobs[index]!);}return result;
   }catch(error){throw new NativeQueueReadUnavailableError('Eligible',error);}
  },
 });
}
