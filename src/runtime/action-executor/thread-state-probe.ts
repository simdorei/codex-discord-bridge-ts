import {types} from 'node:util';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {readThread} from '../../app-server/requests.ts';
import {serdeField} from '../../app-server/value.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {requireDiscordText} from '../../discord/text.ts';
export const THREAD_STATE_QUERY_LIMIT=50;
export const THREAD_STATE_TOTAL_MS=3000;
export const THREAD_STATE_SINGLE_MS=600;
const field=(v:unknown,...keys:string[]):unknown=>keys.reduce((value,key)=>serdeField(value,key),v);
/** No cache absence -> idle inference. Only exact returned original ID and explicit
 * server status can produce an execution label. Timestamp is JS millisecond UTC. */
export function parseThreadState(value:unknown,expected:string,timestamp:string):string {
 requireDiscordText(expected);requireDiscordText(timestamp);const v=cloneOwnedSerdeValue(value);
 if(field(v,'thread','id')!==expected)return '조회 실패: thread/read 원본 대화 ID 불일치 또는 누락';
 let status:string;switch(field(v,'thread','status','type')){
  case 'idle':status='idle (작업 없음)';break;
  case 'notLoaded':status='notLoaded (서버에 불러오지 않음; 다른 앱 실행 여부 미확인)';break;
  case 'systemError':status='systemError (서버 오류)';break;
  case 'active':{const flags=field(v,'thread','status','activeFlags');if(!Array.isArray(flags))return '조회 실패: activeFlags 누락 또는 배열 아님';let approval=false,input=false;for(const flag of flags){if(flag==='waitingOnApproval')approval=true;else if(flag==='waitingOnUserInput')input=true;else return '조회 실패: 미지원 activeFlags';}status=approval?(input?'active (승인 대기 · 사용자 입력 대기)':'active (승인 대기)'):(input?'active (사용자 입력 대기)':'active (진행 중)');break;}
  default:return '조회 실패: thread/read 실행 상태 누락 또는 미지원 값';
 }
 return `${status} · 서버 조회 시점; ${timestamp}`;
}
/** Sequential observational reads share a 3s total budget, 600ms each, at most50.
 * Pending request cancellation is joined; no resume, load, mutation or retry. */
export async function readThreadStates(server:PortableResidentLifecycle|null,input:readonly {readonly id:string}[],limit:number,renderError:(error:unknown)=>string,signal?:AbortSignal):Promise<ReadonlyMap<string,string>> {
 if(!Number.isSafeInteger(limit)||limit<0)throw new TypeError('Expected nonnegative thread display limit');if(typeof renderError!=='function'||types.isProxy(renderError)||types.isAsyncFunction(renderError)||types.isGeneratorFunction(renderError))throw new TypeError('Expected synchronous error renderer');
 const threads=cloneOwnedSerdeValue(input);if(!Array.isArray(threads))throw new TypeError('Expected thread list');const ids=threads.map(value=>{const id=serdeField(value,'id');requireDiscordText(id);return id;});signal?.throwIfAborted();if(server===null)return new Map();
 const generation=PortableResidentLifecycle.prototype.generation.call(server),deadline=performance.now()+THREAD_STATE_TOTAL_MS,states=new Map<string,string>();
 for(let index=0;index<Math.min(ids.length,limit);index++){
  signal?.throwIfAborted();const id=ids[index]!,remaining=deadline-performance.now();let status:string;
  if(index>=THREAD_STATE_QUERY_LIMIT||remaining<=0)status='미확인 (서버 조회 한도 50개/전체 3초)';
  else {const timeout=new AbortController(),reason=new Error('thread state query deadline'),timer=setTimeout(()=>timeout.abort(reason),Math.min(THREAD_STATE_SINGLE_MS,remaining)),owned=signal===undefined?timeout.signal:AbortSignal.any([signal,timeout.signal]);
   try{const response=await PortableResidentLifecycle.prototype.execute.call(server,readThread(id,false),generation,owned);signal?.throwIfAborted();status=timeout.signal.aborted?'조회 실패: thread/read 시간 제한 초과; 요청 취소':parseThreadState(response,id,new Date().toISOString().replace('Z','+00:00'));}
   catch(error){signal?.throwIfAborted();if(timeout.signal.aborted)status='조회 실패: thread/read 시간 제한 초과; 요청 취소';else{const detail=renderError(error);requireDiscordText(detail);status=`조회 실패: ${detail}`;}}
   finally{clearTimeout(timer);}
  }
  states.set(id,status.replace(/[\r\n]/gu,' '));
 }
 if(PortableResidentLifecycle.prototype.generation.call(server)!==generation)for(const id of states.keys())states.set(id,'미확인 (조회 중 서버 세대 변경)');
 return new Map([...states.entries()].sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b))));
}
