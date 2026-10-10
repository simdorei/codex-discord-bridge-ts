import test from 'node:test';
import assert from 'node:assert/strict';
import {formatUsage} from '../../../src/runtime/action-executor/usage-format.ts';
const bucket=(startDate:string,tokens:unknown)=>({startDate,tokens});
test('UTC period filters valid outside rows and preserves exact totals above f64 precision',()=>{
 const text=formatUsage(2,{rateLimits:{planType:'pro',primary:{usedPercent:25n,windowDurationMins:300n,resetsAt:0n}}},{dailyUsageBuckets:[bucket('2026-09-06',9007199254740993n),bucket('2026-09-05',2n),bucket('2026-09-04',900000n),bucket('2026-09-07',800000n)],summary:{lifetimeTokens:5000000n}},'2026-09-06');
 assert.ok(text.includes('period: 2026-09-05 to 2026-09-06 UTC'));assert.ok(text.includes('primary: used=25% window=5h resets=unavailable'));assert.ok(text.includes('total_tokens: 9007199254740995'));assert.ok(text.includes('lifetime_tokens: 5000000'));assert.ok(!text.includes('900000\n'));assert.ok(!text.includes('800000\n'));
});
test('malformed bucket date or noninteger count marks partial without inventing zero',()=>{
 const text=formatUsage(2,{rateLimits:{primary:{usedPercent:-1n,resetsAt:-1n}}},{dailyUsageBuckets:[bucket('2026-09-07',17n),bucket('2026-02-30',50n),bucket('2026-09-06','200'),bucket('2026-09-06',-20n),bucket('2026-09-06',20)]},'2026-09-07');
 assert.ok(text.includes('partial_total_tokens: 17'));assert.ok(text.includes('Warning: malformed usage buckets'));assert.ok(!text.split('\n').some(l=>l.startsWith('total_tokens:')));assert.ok(text.includes('primary: used=unavailable window=unavailable resets=unavailable'));
});
test('missing and empty usage never claims zero consumption or available Reserve quota',()=>{
 for(const usage of [{},{dailyUsageBuckets:[]},{dailyUsageBuckets:{}},{replacementBuckets:[{tokens:20n}]}]){const text=formatUsage(30,{},usage,'2026-09-07');assert.ok(text.includes('usage data unavailable'));assert.ok(!text.includes('total_tokens:'));assert.ok(text.includes('Luna Reserve: quota unavailable'));assert.ok(!text.includes('reserve primary: used=0%'));}
});
test('duplicate dated buckets are retained and sorted by date then exact token count',()=>{
 const text=formatUsage(1,{}, {dailyUsageBuckets:[bucket('2026-09-07',3n),bucket('2026-09-07',1n),bucket('2026-09-07',3n)]},'2026-09-07');assert.ok(text.includes('2026-09-07: 1\n2026-09-07: 3\n2026-09-07: 3\ntotal_tokens: 7'));
});
test('Chrono numeric padding and signed years are preserved without accepting trailing or preseparator spaces',()=>{
 const valid=['2026-9-7',' 2026- 9-\u00857','+002026-09-07'];for(const date of valid){const text=formatUsage(1,{}, {dailyUsageBuckets:[bucket(date,2n)]},'2026-09-07');assert.ok(text.includes('total_tokens: 2'),date);assert.ok(!text.includes('Warning:'),date);}
 for(const date of ['2026 -09-07','2026-09-07 ','2026-09-07\n','2026-09-07\r','\ufeff2026-09-07','2026-009-07','２０２６-09-07','2026-02-29'])assert.ok(formatUsage(1,{}, {dailyUsageBuckets:[bucket(date,2n)]},'2026-09-07').includes('Warning:'),date);
 assert.ok(formatUsage(0,{}, {dailyUsageBuckets:[bucket('-0001-12-31',1n)]},'-0001-12-31').includes('period: -0001-12-31 to -0001-12-31 UTC'));assert.ok(formatUsage(30,{}, {},'-262143-01-01').includes('period: -262143-01-01 to -262143-01-01 UTC'));
});
test('Reserve observations remain separate from active settings and ordinary recovery',()=>{
 const text=formatUsage(1,{ordinaryUsageAllowed:null,rateLimits:{primary:{usedPercent:100n}},rateLimitsByLimitId:{a:{limitName:'gpt-reserve',normalModelSlug:'gpt-luna',primary:{usedPercent:100n,windowDurationMins:10080n}}}}, {},'2026-09-15');
 assert.ok(text.includes('reserve primary: used=100% window=7d'));assert.ok(text.includes('ordinary included usage allowed: unavailable'));assert.ok(text.includes('현재 대화의 사용 모드가 아님'));assert.ok(text.includes('설정 성공과 실제 실행 성공은 별도 확인'));
});
test('window reset is UTC and bounded, numeric scalar uses Serde while percent uses Rust Display',()=>{
 const text=formatUsage(999,{rateLimits:{primary:{usedPercent:0.000001,windowDurationMins:61n,resetsAt:1n},secondary:{usedPercent:-0,windowDurationMins:60n,resetsAt:9223372036854775807n},credits:{balance:2,unlimited:false}}},{summary:{lifetimeTokens:18446744073709551615n}},'2026-09-15');
 assert.ok(text.includes('Codex usage (30d live)'));assert.ok(text.includes('primary: used=0.000001% window=61m resets=1970-01-01 00:00 UTC'));assert.ok(text.includes('secondary: used=-0% window=1h resets=unavailable'));assert.ok(text.includes('credits: balance=2.0 unlimited=false'));assert.ok(text.includes('lifetime_tokens: 18446744073709551615'));
});
test('invalid explicit date and non-u32 range fail; hostile account getters never execute',()=>{
 for(const days of [-1,1.5,4294967296,NaN])assert.throws(()=>formatUsage(days,{}, {},'2026-09-15'));
 assert.throws(()=>formatUsage(1,{}, {},'2026-02-30'));let calls=0;assert.throws(()=>formatUsage(1,{get rateLimits(){calls++;return {};}},{},'2026-09-15'));assert.equal(calls,0);
});
