import type {ContextUsage} from '../codex-state/context-usage.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
const BILLION=1000000000n,MAX_U64=(1n<<64n)-1n;
const floor=(x:bigint,d:bigint)=>{const q=x/d;return x%d<0n?q-1n:q;};
const days=(y:number,m:number)=>[31,y%4===0&&(y%100!==0||y%400===0)?29:28,31,30,31,30,31,31,30,31,30,31][m-1]!;
/** Chrono 0.4.45 RFC3339 subset used by context_report: complete fixed date,
 * T/t/space, Unicode offset minus, nanosecond truncation and retained leap second.
 * This intentionally does not use the distinct Twilight timestamp semantics. */
function parseObservation(value:string):{seconds:bigint;nanos:bigint;display:string}|null{
 const m=/^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt ]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?([Zz]|([+\-−])([0-9]{2}):([0-9]{2}))$/u.exec(value);if(m===null||m[0]!==value)return null;
 const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]),hour=Number(m[4]),minute=Number(m[5]),second=Number(m[6]),oh=Number(m[10]??0),om=Number(m[11]??0);
 if(month<1||month>12||day<1||day>days(year,month)||hour>23||minute>59||second>60||oh>23||om>59)return null;
 const fraction=BigInt((m[7]??'').padEnd(9,'0').slice(0,9)),offset=(oh*60+om)*(m[9]==='-'||m[9]==='−'?-1:1),date=new Date(0);date.setUTCFullYear(year,month-1,day);date.setUTCHours(hour,minute,Math.min(second,59),0);
 const seconds=BigInt(date.getTime()/1000)-BigInt(offset*60),nanos=fraction+(second===60?BILLION:0n),digits=fraction===0n?'':fraction%1000000n===0n?'.'+(fraction/1000000n).toString().padStart(3,'0'):fraction%1000n===0n?'.'+(fraction/1000n).toString().padStart(6,'0'):'.'+fraction.toString().padStart(9,'0');
 const zone=offset===0?'+00:00':`${offset<0?'-':'+'}${String(oh).padStart(2,'0')}:${String(om).padStart(2,'0')}`;
 return {seconds,nanos,display:`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${digits}${zone}`};
}
function age(value:string|null,nowMs:number):string{
 const observed=value===null?null:parseObservation(value);if(observed===null)return '관측 시각 미확인 · 최신 여부 판단 불가';
 const ms=BigInt(nowMs),seconds=floor(ms,1000n),nanos=(ms-seconds*1000n)*1000000n,nowTime=seconds-floor(seconds,86400n)*86400n,thenTime=observed.seconds-floor(observed.seconds,86400n)*86400n;
 let delta=(seconds-observed.seconds)*BILLION+nanos-observed.nanos;if(nowTime>thenTime&&observed.nanos>=BILLION)delta+=BILLION;
 const elapsed=delta/BILLION;return elapsed<0n?`관측 시각이 미래: ${observed.display} · 최신 여부 판단 불가`:`관측: ${observed.display} · ${elapsed}초 전`;
}
function u64(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<0n||value>MAX_U64)throw new TypeError('Expected context u64');}
export function contextUsageLines(input:ContextUsage|null,cumulative:bigint|null,nowMs=Date.now()):string{
 if(!Number.isSafeInteger(nowMs)||Math.abs(nowMs)>8640000000000000)throw new TypeError('Expected valid observation clock');if(cumulative!==null&&(typeof cumulative!=='bigint'||cumulative<-(1n<<63n)||cumulative>=(1n<<63n)))throw new TypeError('Expected cumulative i64');
 const usage=cloneOwnedSerdeValue(input) as ContextUsage|null,lines=[`used: ${cumulative!==null&&cumulative>=0n?cumulative:'미확인'} · 누적 사용량, 현재 context 아님`];
 if(usage===null){lines.push('last_input: 미확인 · 확인된 측정값 없음\npeak_input: 미확인\nwindow: 미확인');return lines.join('\n');}
 for(const v of [usage.lastInputTokens,usage.peakInputTokens,usage.inferredCompactions])u64(v);for(const v of [usage.lastTotalTokens,usage.modelContextWindow])if(v!==null)u64(v);if(usage.observedAt!==null&&typeof usage.observedAt!=='string')throw new TypeError('Expected optional observation text');
 lines.push(`last_input: ${usage.lastInputTokens} · 마지막 관측, 현재 실시간 값 아님`,`peak_input: ${usage.peakInputTokens} · 기록 내 최대`,`last_total: ${usage.lastTotalTokens??'미확인'}`);
 const window=usage.modelContextWindow;if(window!==null&&window>0n){const hundredths=usage.lastInputTokens*10000n/window;lines.push(`window: ${window} · 마지막 입력 비율 ${hundredths/100n}.${(hundredths%100n).toString().padStart(2,'0')}%`);}else lines.push('window: 미확인 · 비율 계산 불가');
 lines.push(age(usage.observedAt,nowMs),`압축 추정: ${usage.inferredCompactions} · 입력 감소로 추정, 실제 압축 횟수 확정 아님`);if(usage.lastCompaction!==null){if(!Array.isArray(usage.lastCompaction)||usage.lastCompaction.length!==2)throw new TypeError('Expected original compaction pair');u64(usage.lastCompaction[0]);u64(usage.lastCompaction[1]);lines.push(`마지막 추정 감소: ${usage.lastCompaction[0]} → ${usage.lastCompaction[1]}`);}return lines.join('\n');
}
