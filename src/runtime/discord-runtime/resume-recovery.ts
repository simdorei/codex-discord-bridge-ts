import {performance} from 'node:perf_hooks';import {types} from 'node:util';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
const slot=new OwnedWorkerSlot('Control');let active=false;
export class ResumeRecoveryUnconfirmed extends Error{constructor(cause:unknown){super('Resume recovery native outcome is unconfirmed; keep startup stopped',{cause});this.name='ResumeRecoveryUnconfirmed';}}
export interface ResumeRecoveryReport{readonly scanned:number;readonly recovered:number;readonly clearedJobs:number;readonly held:number;readonly budgetExhausted:boolean;readonly diagnostics:readonly string[]}
interface Candidate{attemptId:string;target:string;original:string}
function text(v:unknown,max:number):string{requireDiscordText(v);if(Buffer.byteLength(v)>max||v.includes('\0'))throw new RangeError('Resume recovery native text exceeds limit');return v;}
/** Actual pre-worker cold-start binding. RPC observations come from this exact
 * resident; existing DB work runs in a joined Control worker. A worker uncertainty
 * stops startup, rather than treating a rejected Promise as a rollback. */
export async function recoverRuntimeResumesOffThread(server:PortableResidentLifecycle,path:string,runtime:string,render:(error:unknown)=>string,signal?:AbortSignal):Promise<ResumeRecoveryReport>{
 if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected startup signal');signal?.throwIfAborted();
 const pinned=text(pinNativeRuntimePath(text(path,32768)),32768);text(runtime,4096);if(typeof render!=='function'||types.isProxy(render)||types.isAsyncFunction(render)||types.isGeneratorFunction(render))throw new TypeError('Expected synchronous public-safe recovery renderer');
 PortableResidentLifecycle.prototype.generation.call(server);const resident=text(own(server,'instanceId'),4096);if(active)throw new OwnedWorkerBusyError();active=true;
 const diagnostics:string[]=[],report={scanned:0,recovered:0,clearedJobs:0,held:0,budgetExhausted:false};
 const diagnostic=(e:unknown)=>{const value=render(e);if(types.isPromise(value))void Promise.prototype.then.call(value,undefined,()=>undefined);requireDiscordText(value);diagnostics.push([...value].slice(0,2048).join(''));};
 const native=async(operation:'scan'|'recover',extra:object):Promise<unknown>=>{
  const input={path:pinned,runtime,operation,...extra};if(boundedSerdeByteCount(input,8388608)===null)throw new RangeError('Resume native input exceeds budget');
  const pending=slot.run(new URL('./resume-recovery-worker.ts',import.meta.url),input,10000,signal),joined=slot.join(),submitted=slot.busy;let raw:unknown;
  try{try{raw=await pending;}finally{await joined;}}catch(error){if(operation==='recover'&&submitted)throw new ResumeRecoveryUnconfirmed(error);throw error;}
  if(signal?.aborted){if(operation==='recover')throw new ResumeRecoveryUnconfirmed(signal.reason);throw signal.reason;}
  if(boundedSerdeByteCount(raw,4198400)===null)throw new ResumeRecoveryUnconfirmed('Invalid native response');
  if(own(raw,'ok')===true)return own(raw,'result');
  if(own(raw,'ok')!==false||own(raw,'uncertain')!==false)throw new ResumeRecoveryUnconfirmed('Native recovery outcome unavailable');
  throw new Error(text(own(raw,'detail'),16384));
 };
 try{
  let raw:unknown;try{raw=await native('scan',{});}catch(error){signal?.throwIfAborted();diagnostic(error);return Object.freeze({...report,diagnostics:Object.freeze(diagnostics)});}
  if(!Array.isArray(raw)||raw.length>64)throw new ResumeRecoveryUnconfirmed('Invalid candidate list');
  const candidates:Candidate[]=raw.map(c=>({attemptId:text(own(c,'attemptId'),4194304),target:text(own(c,'target'),4194304),original:text(own(c,'original'),4194304)}));report.scanned=candidates.length;
  const deadline=performance.now()+30000;
  for(const candidate of candidates){
   signal?.throwIfAborted();if(performance.now()>=deadline){report.budgetExhausted=true;break;}
   const generation=PortableResidentLifecycle.prototype.generation.call(server);let metadata:unknown,latest:unknown;
   try{
    const timeout=()=>Math.max(1,Math.min(10000,Math.floor(deadline-performance.now())));
    metadata=await PortableResidentLifecycle.prototype.execute.call(server,{method:'thread/read',params:{threadId:candidate.target,includeTurns:false},timeoutMs:timeout()},generation,signal);
    if(performance.now()>=deadline){report.budgetExhausted=true;break;}
    latest=await PortableResidentLifecycle.prototype.execute.call(server,{method:'thread/turns/list',params:{threadId:candidate.target,limit:1n,sortDirection:'desc',itemsView:'notLoaded',cursor:null},timeoutMs:timeout()},generation,signal);
   }catch(error){signal?.throwIfAborted();diagnostic(error);report.held++;if(performance.now()>=deadline){report.budgetExhausted=true;break;}continue;}
   if(performance.now()>=deadline){report.budgetExhausted=true;break;}
   if(PortableResidentLifecycle.prototype.generation.call(server)!==generation||generation>9223372036854775807n)break;
   try{const count=await native('recover',{candidate,resident,generation,metadata:cloneOwnedSerdeValue(metadata),latest:cloneOwnedSerdeValue(latest)});if(typeof count!=='number'||!Number.isSafeInteger(count)||count<0)throw new ResumeRecoveryUnconfirmed('Invalid committed recovery count');report.recovered++;report.clearedJobs+=count;}
   catch(error){if(error instanceof ResumeRecoveryUnconfirmed)throw error;signal?.throwIfAborted();diagnostic(error);report.held++;}
  }
  return Object.freeze({...report,diagnostics:Object.freeze(diagnostics)});
 }finally{active=false;}
}
