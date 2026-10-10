import {requireDiscordText} from '../../discord/text.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {getGoal} from '../../app-server/requests.ts';
import {parseThreadGoalStatus} from '../../app-server/goal.ts';
import {serdeField} from '../../app-server/value.ts';
import {renderContextView} from '../../codex-state/context-reader.ts';
import {ActionThreadSelection} from './thread-selection.ts';
import {readThreadStates} from './thread-state-probe.ts';
import {InvalidActionRequestError} from './errors.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
export class ThreadStatusAction {
 readonly #selection:ActionThreadSelection;readonly #server:PortableResidentLifecycle|null;readonly #render:(error:unknown)=>string;
 constructor(selection:ActionThreadSelection,server:PortableResidentLifecycle|null,renderError:(error:unknown)=>string){this.#selection=selection;this.#server=server;this.#render=renderError;Object.freeze(this);}
 async status(channel:bigint,reference:string|null,signal?:AbortSignal):Promise<ActionResult>{
  if(typeof channel!=='bigint'||channel<0n||channel>=(1n<<64n))throw new TypeError('Expected u64 channel');if(reference!==null)requireDiscordText(reference);signal?.throwIfAborted();const thread=await this.#selection.resolveThread(channel,reference),id=thread.id;signal?.throwIfAborted();const lines=[`Codex thread status\nthread_id: ${id}`,`title: ${thread.title}`,`cwd: ${thread.cwd}`,`마지막 저장 model: ${thread.model}`,`마지막 저장 reasoning: ${thread.reasoningEffort}`,'현재 실행 설정: 미확인 (저장값과 다를 수 있음)',`tokens_used: ${thread.tokensUsed!==null&&thread.tokensUsed>=0n?thread.tokensUsed:'미확인'} (누적 사용량)`],server=this.#server;
  if(server!==null){const generation=server.generation(),states=await readThreadStates(server,[thread],1,this.#render,signal);lines.push(`state: ${states.get(id)??'미확인'}`);signal?.throwIfAborted();const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(new Error('goal deadline')),3000),owned=signal?AbortSignal.any([signal,timeout.signal]):timeout.signal;let goal:string;
   try{const value=await server.execute(getGoal(id),generation,owned);signal?.throwIfAborted();if(timeout.signal.aborted)goal='goal 조회 실패: 전체 조회 시간 3초 초과; 요청 취소';else if(generation!==server.generation()||serdeField(value,'goal')===undefined)goal='goal 조회 실패: 서버 세대 변경 또는 goal 응답 필드 누락';else{try{const status=parseThreadGoalStatus(value,id);goal=status===null?'goal: 등록된 목표 없음 (서버 조회)':`goal: ${status} (서버 조회)`;}catch(error){goal=`goal 조회 실패: ${this.#render(error)}`;}}}
   catch(error){signal?.throwIfAborted();goal=timeout.signal.aborted?'goal 조회 실패: 전체 조회 시간 3초 초과; 요청 취소':`goal 조회 실패: ${this.#render(error)}`;}finally{clearTimeout(timer);}lines.push(goal);
  }else lines.push('현재 실행 상태 미확인: app-server 연결 없음','goal 미확인: app-server 연결 없음');
  signal?.throwIfAborted();try{lines.push(await renderContextView([thread],true,5,'UserAndFinal',signal));}catch(error){signal?.throwIfAborted();lines.push(`최근 대화 조회 실패: ${error instanceof Error?error.message:'context read failed'}`);}signal?.throwIfAborted();if(reference===null&&(await this.#selection.target(channel))[0]!==id)throw new InvalidActionRequestError('status target changed during read');signal?.throwIfAborted();return snapshotActionResult({text:lines.join('\n'),waitsForFinal:false,ui:null});
 }
}
Object.freeze(ThreadStatusAction.prototype);
