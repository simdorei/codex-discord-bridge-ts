import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {formatRustF64Display} from '../../core/rust-f64-display.ts';
import {serdeField,serdeObject} from '../../app-server/value.ts';
import {asU64,asI64} from '../../store/async-resolution-json-helpers.ts';
import {reserveSnapshot} from './model-catalog.ts';
import {listTimestamp} from './thread-list-format.ts';

const unavailable='unavailable';
const whitespace='\\p{White_Space}*';
// Chrono 0.4.45 Numeric items ignore padding, trim leading Unicode whitespace,
// accept 1..width ASCII digits, and allow unlimited digits for a signed year.
// Literal '-' separators consume no preceding whitespace; trailing input fails.
const datePattern=new RegExp(`^${whitespace}([+-][0-9]+|[0-9]{1,4})-${whitespace}([0-9]{1,2})-${whitespace}([0-9]{1,2})$`,'u');
function parsedDate(value:unknown):Date|null {
 if(typeof value!=='string')return null;
 const m=datePattern.exec(value);if(!m||m[0]!==value)return null;
 const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]);
 if(!Number.isInteger(year)||year < -262143||year>262142||month<1||month>12||day<1||day>31)return null;
 const d=new Date(0);d.setUTCHours(0,0,0,0);d.setUTCFullYear(year,month-1,day);
 return d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day?d:null;
}
function dateLabel(d:Date):string {
 const y=d.getUTCFullYear(),year=y<0?'-'+String(-y).padStart(4,'0'):y>9999?'+'+y:String(y).padStart(4,'0');
 return `${year}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function scalar(value:unknown):string {
 if(typeof value==='string')return value;
 if(typeof value==='number'||typeof value==='bigint'||typeof value==='boolean')return serializeSerdeValue(value);
 return unavailable;
}
function windowLine(label:string,value:unknown):string {
 if(!serdeObject(value))return `${label}: ${unavailable}`;
 const raw=serdeField(value,'usedPercent'),used=typeof raw==='number'?raw:typeof raw==='bigint'?Number(raw):NaN;
 const percent=Number.isFinite(used)&&used>=0?`${formatRustF64Display(used)}%`:unavailable;
 const minutes=asU64(serdeField(value,'windowDurationMins'));
 const duration=minutes===undefined||minutes===0n?unavailable:minutes%1440n===0n?`${minutes/1440n}d`:minutes%60n===0n?`${minutes/60n}h`:`${minutes}m`;
 const seconds=asI64(serdeField(value,'resetsAt')),timestamp=seconds===undefined?'미확인':listTimestamp(seconds);
 const reset=timestamp==='미확인'?unavailable:timestamp.slice(0,-9).replace('T',' ')+' UTC';
 return `${label}: used=${percent} window=${duration} resets=${reset}`;
}
/** Pure account-observation report. Unknown and malformed observations never
 * become zero usage or an authorization to change model or retry execution. */
export function formatUsage(days:number,ratesInput:unknown,usageInput:unknown,todayInput:string):string {
 if(!Number.isSafeInteger(days)||days<0||days>0xffffffff)throw new TypeError('Expected u32 days');
 const rates=cloneOwnedSerdeValue(ratesInput),usage=cloneOwnedSerdeValue(usageInput),today=parsedDate(todayInput);
 if(today===null)throw new TypeError('Expected valid Chrono date');
 days=Math.min(30,Math.max(1,days));const first=new Date(today);first.setUTCDate(first.getUTCDate()-(days-1));
 if(first.getUTCFullYear() < -262143)first.setTime(today.getTime());
 const limits=serdeField(rates,'rateLimits'),plan=serdeField(limits,'planType');
 const lines=[`Codex usage (${days}d live)`,`period: ${dateLabel(first)} to ${dateLabel(today)} UTC`,`plan: ${typeof plan==='string'?plan:unavailable}`,windowLine('primary',serdeField(limits,'primary')),windowLine('secondary',serdeField(limits,'secondary'))];
 const credits=serdeField(limits,'credits');if(serdeObject(credits))lines.push(`credits: balance=${scalar(serdeField(credits,'balance'))} unlimited=${scalar(serdeField(credits,'unlimited'))}`);
 lines.push(`ordinary included usage allowed: ${scalar(serdeField(rates,'ordinaryUsageAllowed'))}`);
 let reserve:Readonly<Record<string,unknown>>|null=null;
 try{reserve=reserveSnapshot(rates);}catch{/* Invalid/missing account Reserve snapshot is a display uncertainty. */}
 if(reserve!==null){lines.push('\nLuna Reserve (별도 한도 · 현재 대화의 사용 모드가 아님)',`request model: ${scalar(serdeField(reserve,'limitName'))} / normal model: ${scalar(serdeField(reserve,'normalModelSlug'))}`,windowLine('reserve primary',serdeField(reserve,'primary')),windowLine('reserve secondary',serdeField(reserve,'secondary')),`reserve limit state: ${scalar(serdeField(reserve,'rateLimitReachedType'))}`,'선택: !settings --model reserve · 설정 성공과 실제 실행 성공은 별도 확인');}
 else lines.push('Luna Reserve: quota unavailable or ambiguous (미확인은 잔량 0이 아님)');
 lines.push('\nDaily token usage');let invalid=false;const rows:{date:Date;tokens:bigint}[]=[],buckets=serdeField(usage,'dailyUsageBuckets');
 if(Array.isArray(buckets))for(const bucket of buckets){const date=parsedDate(serdeField(bucket,'startDate')),tokens=asU64(serdeField(bucket,'tokens'));if(date===null||tokens===undefined)invalid=true;else if(date>=first&&date<=today)rows.push({date,tokens});}
 rows.sort((a,b)=>a.date.getTime()-b.date.getTime()||(a.tokens<b.tokens?-1:a.tokens>b.tokens?1:0));
 if(rows.length===0)lines.push('usage data unavailable: no valid usage buckets returned for this period');
 else {let total=0n;for(const row of rows){total+=row.tokens;lines.push(`${dateLabel(row.date)}: ${row.tokens}`);}lines.push(`${invalid?'partial_total_tokens':'total_tokens'}: ${total}`);}
 if(invalid)lines.push('Warning: malformed usage buckets; totals may be incomplete.');
 lines.push('\nAccount summary');const summary=serdeField(usage,'summary');
 if(serdeObject(summary))for(const [key,label] of [['currentStreakDays','current_streak_days'],['longestStreakDays','longest_streak_days'],['lifetimeTokens','lifetime_tokens'],['peakDailyTokens','peak_daily_tokens'],['longestRunningTurnSec','longest_running_turn_sec']] as const)lines.push(`${label}: ${scalar(serdeField(summary,key))}`);
 else lines.push(unavailable);
 return lines.join('\n');
}
