import type {ThreadInfo} from '../codex-state/thread.ts';
import type {ContextBatch} from '../codex-state/context-batch.ts';
import {contextUsageLines} from './context-report.ts';
const clipped=(text:string,limit:number):string=>{const chars=[...text];return chars.slice(0,limit).join('').replace(/[\r\n]/gu,' ')+(chars.length>limit?'…':'');};
/** Called inside owned context worker; historical observations never imply live
 * execution, current context measurement, or authority to mutate a thread. */
export function formatContextView(threads:readonly ThreadInfo[],batch:ContextBatch,refresh:boolean,nowMs=Date.now()):string {
 const lines=['Codex context · 마지막 기록 조회, 현재 실시간 측정 아님'];if(threads.length===0)lines.push('활성 대화 없음');let textBudget=12000;
 for(let i=0;i<Math.min(threads.length,batch.entries.length);i++){
  const thread=threads[i]!,entry=batch.entries[i]!;if(entry.thread!==thread.id)throw new Error('Context batch original target mismatch');lines.push(`\n${thread.id} | ${clipped(thread.title,240)} | 마지막 저장 model=${clipped(thread.model,80)} effort=${clipped(thread.reasoningEffort,40)}`);
  if(entry.error!==null){lines.push(`조회 실패: ${entry.error}`,contextUsageLines(null,thread.tokensUsed,nowMs));continue;}
  if(entry.snapshot===null)throw new Error('Context batch missing successful snapshot');lines.push(contextUsageLines(entry.snapshot.usage,thread.tokensUsed,nowMs));if(refresh){if(entry.snapshot.recentItems.length===0)lines.push('최근 표시 가능한 대화 없음');for(const item of entry.snapshot.recentItems){if(textBudget===0){lines.push('최근 대화 표시 한도 초과 · 이후 내용 생략');break;}const chars=[...item.text],shown=Math.min(chars.length,textBudget);textBudget-=shown;lines.push(`[${item.label}] ${chars.slice(0,shown).join('')}${item.truncated||shown<chars.length?' … [잘림]':''}`);}}
 }
 if(batch.skipped>0)lines.push(`조회 한도 50개 · 미조회 대화: ${batch.skipped}`);return lines.join('\n');
}
