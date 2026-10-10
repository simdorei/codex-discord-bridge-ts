import type {ThreadInfo} from '../../codex-state/thread.ts';
import type {ContextBatch} from '../../codex-state/context-batch.ts';
import {workspaceReferenceMap} from '../../codex-state/thread-reference.ts';
const clip=(s:string,n:number)=>{const c=[...s];return c.slice(0,n).join('').replace(/[\r\n]/gu,' ')+(c.length>n?'…':'');};
export function listTimestamp(value:bigint):string {
 if(typeof value!=='bigint'||value<=0n)return '미확인';const maximum=new Date(0);maximum.setUTCFullYear(262143,0,1);maximum.setUTCHours(0,0,0,0);if(value>=BigInt(maximum.getTime()/1000))return '미확인';const d=new Date(Number(value)*1000),year=d.getUTCFullYear(),pad=(n:number)=>String(n).padStart(2,'0');return `${year>9999?'+'+year:String(year).padStart(4,'0')}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`;
}
export function listTokens(value:bigint):string{const divisor=value>=1000000n?1000000n:1000n,unit=value>=1000000n?'M':'K';return `${value/divisor}.${((value%divisor)*1000n/divisor).toString().padStart(3,'0')}${unit}`;}
/** Preserve the complete local inventory and reference numbering regardless of
 * missing rollout files, notLoaded status, or the separate 50-file probe limit. */
export function formatThreadList(input:readonly ThreadInfo[],selected:string|null,limit:number,archived:boolean,states:ReadonlyMap<string,string>,batch:ContextBatch|null):string {
 const threads=input.map(t=>({...t,title:clip(t.title,100)})),refs=workspaceReferenceMap(threads),count=limit===0?threads.length:Math.min(limit,threads.length),lines:string[]=[];
 for(let index=0;index<count;index++){
  const t=threads[index]!,reference=refs.get(t.id)??t.cwd.split(/[\\/]/u).filter(Boolean).at(-1)??'-',header=`${t.id===selected?'*':' '}${index+1} | ${reference} | ${t.id} | ${t.title}`;
  if(archived){lines.push(`${header} | archived_at: ${listTimestamp(t.archivedAt)}`);continue;}
  const entry=batch?.entries[index];if(entry&&entry.thread!==t.id)throw new Error('List context original target mismatch');const usage=entry?.error===null?entry.snapshot?.usage:null,ctx=usage?`${listTokens(usage.lastInputTokens)}/${listTokens(usage.peakInputTokens)}`:'미확인/미확인',cumulative=t.tokensUsed!==null&&t.tokensUsed>=0n?t.tokensUsed:null,used=cumulative===null?'미확인':listTokens(cumulative),recommend=cumulative!==null&&cumulative>=50000000n||!!usage&&(usage.lastInputTokens>=200000n||usage.peakInputTokens>=200000n);
  const row=`${header} | state ${states.get(t.id)??'미확인 (현재 실행 상태 조회 안 됨)'} | ctx ${ctx} (마지막/최대 입력) | used ${used} (누적) | rec ${recommend?'archive':!usage||cumulative===null?'미확인':'-'} | 마지막 저장 model ${clip(t.model,80)} effort ${clip(t.reasoningEffort,40)} | updated_at: ${listTimestamp(t.updatedAt)}`;
  const evidence=entry===undefined?'ctx 미조회 (파일 조회 한도 50개)':entry.error!==null?`ctx 조회 실패: ${entry.error}`:usage?`ctx 관측 시각: ${usage.observedAt===null?'미확인':clip(usage.observedAt,64)} · 실시간 아님`:'ctx 측정 기록 없음';lines.push(`${row} | ${evidence.replace(/[\r\n]/gu,' ')}`);
 }
 lines.push(`목록: ${count}/${threads.length}개 표시 · 범위: 설정된 로컬 Codex DB의 ${archived?'아카이브된':'활성·미아카이브'} 대화 (다른 PC/CODEX_HOME은 포함하지 않음)\n실행 상태 관측은 실행 권한 확인이 아닙니다. 조회 실패/notLoaded여도 목록에서 제외하지 않습니다.`);return lines.join('\n');
}
