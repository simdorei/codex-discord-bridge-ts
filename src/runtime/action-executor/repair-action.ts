import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {ownedRequestFailure} from '../../app-server/request-client.ts';
import {serdeField} from '../../app-server/value.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {parseSerdeValue} from '../../core/serde-json-parse.ts';
import {asU64} from '../../store/async-resolution-json-helpers.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {TargetLocks,type TargetLease} from '../../core/keyed-locks.ts';
import {BridgeState} from '../bridge-state.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {claimAdmittedRecovery,type RecoveryGuard} from './recovery-custody.ts';
import type {LifecycleActor} from './lifecycle-admission.ts';
import {InvalidActionRequestError} from './errors.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
export const REPAIR_INIT='if (!globalThis.sky) { const { sky } = await import("@oai/sky"); globalThis.sky = sky; }';
export const REPAIR_PROBE="nodeRepl.write(JSON.stringify({cdrRepair: 'ready', apps: (await sky.list_apps()).length}));";
const field=(v:unknown,...keys:string[])=>keys.reduce<unknown>((v,k)=>serdeField(v,k),v);
function contentText(value:unknown):string{const c=serdeField(value,'content');return Array.isArray(c)?c.filter(v=>serdeField(v,'type')==='text'&&typeof serdeField(v,'text')==='string').map(v=>serdeField(v,'text') as string).join('\n'):'';}
function available(value:unknown):boolean{const data=serdeField(value,'data');return Array.isArray(data)&&data.some(s=>serdeField(s,'name')==='node_repl'&&serdeField(s,'runtimeStatus')==='connected'&&(serdeField(s,'toolsError')===undefined||serdeField(s,'toolsError')===null)&&field(s,'tools','js','name')==='js'&&field(s,'tools','js_reset','name')==='js_reset');}
function probeReady(value:unknown):boolean{return contentText(value).split(/\r?\n/u).some(line=>{let v;try{v=parseSerdeValue(line);}catch{return false;}return serdeField(v,'cdrRepair')==='ready'&&asU64(serdeField(v,'apps'))!==undefined;});}
function busy():InvalidActionRequestError{return new InvalidActionRequestError('이 채팅에 진행 중·대기 중 요청이 있거나 유휴 상태를 확인할 수 없어 도구를 초기화하지 않았습니다. 요청 취소와 앱 재시작은 !recover를 사용하세요.');}
interface Budgets{readonly totalMs:number;readonly callMs:number;readonly lockMs:number;}
/** Original admitted Repair only. Never starts a model turn or restarts the app.
 * Diagnostic JSON is not recovery authority; native mutation ledger retains
 * uncertain effects across cold coordinators, new instances and late replies. */
export class AdmittedRepairExecutor{
 readonly #path:string;readonly #bridge:BridgeState;readonly #server:PortableResidentLifecycle;readonly #locks:TargetLocks;readonly #render:(e:unknown)=>string;readonly #budgets:Budgets;
 readonly #held=new Map<TargetLease,{generation:bigint;timer:ReturnType<typeof setInterval>}>();
 constructor(path:string,bridge:BridgeState,server:PortableResidentLifecycle,locks:TargetLocks,render:(e:unknown)=>string,budgets:Budgets={totalMs:25000,callMs:12000,lockMs:1000}){
  requireDiscordText(path);for(const [v,max] of [[budgets.totalMs,25000],[budgets.callMs,12000],[budgets.lockMs,1000]])if(!Number.isSafeInteger(v)||v!<=0||v!>max!)throw new TypeError('Expected positive bounded repair budgets');this.#path=path;this.#bridge=bridge;this.#server=server;this.#locks=locks;this.#render=render;this.#budgets=Object.freeze({...budgets});Object.freeze(this);
 }
 async execute(actor:LifecycleActor,reference:string|null,key:string,signal?:AbortSignal):Promise<ActionResult>{
  signal?.throwIfAborted();const guard=await claimAdmittedRecovery(this.#path,this.#bridge,actor,'Repair',reference,key,this.#render,signal);
  return guard.runWithOriginalStopOrigin(()=>this.#run(guard,signal));
 }
 async #run(guard:RecoveryGuard,signal?:AbortSignal):Promise<ActionResult>{
  const c=new AbortController(),expired=new Error('repair total deadline'),abort=()=>c.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)c.abort(signal.reason);
  const timer=setTimeout(()=>c.abort(expired),this.#budgets.totalMs);let lease:TargetLease|undefined,uncertain=false,generation=this.#server.generation(),stage='preflight';
  try{
   const wait=new AbortController(),lockTimer=setTimeout(()=>wait.abort(busy()),this.#budgets.lockMs);
   try{lease=await this.#locks.acquire(guard.target,AbortSignal.any([c.signal,wait.signal]));}finally{clearTimeout(lockTimer);}
   guard.check();c.signal.throwIfAborted();
   if((await state.listFiltered(this.#path,guard.target,null)).length!==0||(await state.listPromptIntakes(this.#path)).some(v=>v.targetThreadId===guard.target))throw busy();
   c.signal.throwIfAborted();generation=this.#server.generation();const health=this.#server.lifecycleSnapshot();if(!health.healthy||health.quarantined||health.restartPending)throw new InvalidActionRequestError('앱서버 연결이 비정상이라 채팅별 도구 초기화를 보낼 수 없습니다. !recover를 사용하세요.');
   const rpc=(method:string,params:unknown,check=guard.rpcCheck().check)=>this.#server.requestForToolRepairChecked(method,params,this.#budgets.callMs,generation,check,c.signal);
   const status=await rpc('thread/read',{threadId:guard.target,includeTurns:false});if(field(status,'thread','status','type')!=='idle'||field(status,'thread','id')!==guard.target||this.#server.activeTurnId(guard.target)!==null)throw busy();
   let cursor:unknown=null,found=false;for(let page=0;page<4;page++){const inventory=await rpc('mcpServerStatus/list',{threadId:guard.target,detail:'toolsAndAuthOnly',limit:100n,cursor});found=available(inventory);cursor=serdeField(inventory,'nextCursor')??null;if(found||cursor===null)break;}
   if(!found)throw new InvalidActionRequestError('이 채팅에서 node_repl의 js/js_reset 연결을 확인하지 못했습니다. 지원되지 않는 도구는 초기화하지 않았습니다.');
   guard.check();c.signal.throwIfAborted();this.#server.checkActualTargetMutation(null,generation,'mcpServer/tool/call',{threadId:guard.target,server:'node_repl',tool:'js_reset',arguments:{}});const folder=join(dirname(this.#path),'maintenance_backups','tool-repair');await mkdir(folder,{recursive:true});const operation=randomUUID(),receipt=join(folder,operation+'.json');
   const record=async(phase:string)=>writeFile(receipt,serializeSerdeValue({phase,stage,operation_id:operation,thread_id:guard.target,generation,server_instance:this.#server.instanceId,app_restarted:false}),{encoding:'utf8',mode:0o600});
   const call=async(next:string,tool:string,args:unknown)=>{
    stage=next;await record('tool_call_pending');uncertain=true;const proof=guard.rpcCheck();let value:unknown;
    try{value=await rpc('mcpServer/tool/call',{threadId:guard.target,server:'node_repl',tool,arguments:args},proof.check);uncertain=false;}
    catch(error){if(proof.rejected()||ownedRequestFailure(error)?.kind==='Remote')uncertain=false;await record(proof.rejected()?'admission_refused_before_send':uncertain?'outcome_unknown':'failed');if(c.signal.aborted)throw c.signal.reason;const detail=this.#render(error);requireDiscordText(detail);throw new InvalidActionRequestError(`도구 복구 단계 ${stage} 응답을 확인하지 못했습니다: ${detail}. 결과가 불명확하면 이 채팅의 새 실행을 보류합니다. !recover를 사용하세요.`);}
    await record('tool_call_returned');const flag=serdeField(value,'isError');if((flag!==undefined&&typeof flag!=='boolean')||!Array.isArray(serdeField(value,'content'))){await record('failed');throw new InvalidActionRequestError(`도구 복구 단계 ${stage} 응답 형식이 올바르지 않습니다. 앱은 재시작하지 않았습니다.`);}
    if(flag===true){await record('failed');const text=contentText(value);throw new InvalidActionRequestError(`도구 복구 단계 ${stage} (${tool}) 실패: ${Array.from(text).slice(0,1200).join('')}. 앱은 재시작하지 않았습니다.${text.includes('native pipe')?' 앱 연결 복구는 !recover를 사용하세요.':''}`);}return value;
   };
   const reset=await call('reset','js_reset',{});if(!contentText(reset).includes('js kernel reset')){await record('failed');throw new InvalidActionRequestError('도구 복구 단계 reset 응답 형식이 달라 완료를 확인하지 못했습니다. 앱은 재시작하지 않았습니다.');}
   await call('initialize','js',{code:REPAIR_INIT,timeout_ms:8000n,title:'Initialize Computer Use after repair'});
   const probe=await call('probe','js',{code:REPAIR_PROBE,timeout_ms:8000n,title:'Verify repaired Computer Use connection'});
   if(!probeReady(probe)||this.#server.generation()!==generation){await record('failed');throw new InvalidActionRequestError('도구 복구 단계 probe 실패: JS 세션은 초기화했지만 Computer Use 연결을 확인하지 못했습니다. 앱은 재시작하지 않았습니다.');}
   guard.check();c.signal.throwIfAborted();await record('verified');c.signal.throwIfAborted();
   return snapshotActionResult({text:`도구 복구 완료: ${guard.target}\n이 채팅의 JS 세션을 초기화하고 Computer Use 연결을 확인했습니다. 앱 재시작·요청 취소는 하지 않았습니다. 기존 JS 변수와 도구 핸들은 다시 만들어야 합니다.`,waitsForFinal:false,ui:null});
  }catch(error){if(c.signal.reason===expired)throw new InvalidActionRequestError('도구 복구 제한시간을 넘겼습니다. 결과가 불명확한 채팅은 보류하며 !recover를 사용하세요.');throw error;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(lease!==undefined){if(uncertain)this.#retain(lease,generation);else lease.release();}}
 }
 #retain(lease:TargetLease,generation:bigint):void{
  if(this.#server.generation()!==generation){lease.release();return;}
  const timer=setInterval(()=>{if(this.#server.generation()!==generation){clearInterval(timer);this.#held.delete(lease);lease.release();}},1000);timer.unref();this.#held.set(lease,{generation,timer});
 }
}
Object.freeze(AdmittedRepairExecutor.prototype);
