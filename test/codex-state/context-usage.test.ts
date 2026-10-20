import test from 'node:test';
import assert from 'node:assert/strict';
import {ContextUsageAccumulator,ContextUsageError,contextUsageFromEvents} from '../../src/codex-state/context-usage.ts';
import {parseSerdeValue} from '../../src/core/serde-json-parse.ts';
const token=(n:unknown,extra:Record<string,unknown>={},timestamp:unknown='stamp')=>({type:'event_msg',timestamp,payload:{type:'token_count',info:{last_token_usage:{input_tokens:n},...extra}}});
const window=(n:unknown)=>({type:'event_msg',payload:{type:'task_started',model_context_window:n}});
test('absent usage stays unknown and unrelated event kinds never fabricate counters',()=>{
 assert.equal(contextUsageFromEvents([null,{},window(100n),{type:'response_item',payload:{type:'token_count',info:1n}},{type:'event_msg',payload:{type:'token_count'}}]),null);
 assert.equal(contextUsageFromEvents([{type:'event_msg',payload:{type:'token_count',info:null}}]),null);
});
test('latest observation retains its own window while later task-start changes only future observations',()=>{
 const a=new ContextUsageAccumulator();a.push(window(200000n));a.push(token(90000n,{last_token_usage:{input_tokens:90000n,total_tokens:123000n}}));const before=a.finish();a.push(window(400000n));assert.equal(a.finish(),before);assert.equal(before?.modelContextWindow,200000n);a.push(token(30000n));assert.equal(a.finish()?.inferredCompactions,0n);assert.equal(a.finish()?.modelContextWindow,400000n);assert.equal(a.finish()?.peakInputTokens,90000n);assert.equal(a.finish()?.lastTotalTokens,null);
});
test('compaction requires strict 80-percent and 25000-token drop with qualifying previous input',()=>{
 for(const [prior,next,expected] of [[49999n,1n,0n],[125000n,100000n,0n],[125000n,99999n,1n],[50000n,25001n,0n],[50000n,25000n,1n],[50000n,0n,0n]] as const){const result=contextUsageFromEvents([token(prior),token(next)])!;assert.equal(result.inferredCompactions,expected);assert.deepEqual(result.lastCompaction,expected?[prior,next]:null);}
});
test('zero observation preserves nonzero predecessor and repeated drops accumulate without losing peak',()=>{
 const r=contextUsageFromEvents([token(200000n),token(0n),token(100000n),token(40000n)])!;assert.equal(r.inferredCompactions,2n);assert.deepEqual(r.lastCompaction,[100000n,40000n]);assert.equal(r.peakInputTokens,200000n);assert.equal(r.lastInputTokens,40000n);
});
test('same window does not reset predecessor but changed, zero and null window do',()=>{
 assert.equal(contextUsageFromEvents([window(200000n),token(100000n),window(200000n),token(40000n)])!.inferredCompactions,1n);
 for(const next of [300000n,0n,null])assert.equal(contextUsageFromEvents([window(200000n),token(100000n),window(next),token(40000n)])!.inferredCompactions,0n);
});
test('u64 values and comparison products remain exact above JS safe-integer range',()=>{
 const max=(1n<<64n)-1n,r=contextUsageFromEvents([token(max),token(max/2n)])!;assert.equal(r.peakInputTokens,max);assert.equal(r.inferredCompactions,1n);assert.deepEqual(r.lastCompaction,[max,max/2n]);
});
test('actual lossless parser rejects float, exponent, negative zero and out-of-u64 token spellings',()=>{
 for(const literal of ['1.0','1e0','-0','-1','18446744073709551616']){const v=parseSerdeValue(`{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":${literal}}}}}`);assert.throws(()=>contextUsageFromEvents([v]),ContextUsageError);}
 assert.equal(contextUsageFromEvents([parseSerdeValue('{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":18446744073709551615}}}}')])!.lastInputTokens,(1n<<64n)-1n);
});
test('malformed info, missing input and invalid optional counts fail with source-specific errors',()=>{
 for(const info of [[],1n,'bad'])assert.throws(()=>contextUsageFromEvents([{type:'event_msg',payload:{type:'token_count',info}}]),/info is not an object/);
 assert.throws(()=>contextUsageFromEvents([token(null)]),/input tokens must/);assert.throws(()=>contextUsageFromEvents([token(1n,{last_token_usage:{}})]),/input tokens missing/);
 for(const value of [-1n,1,{},'1']){assert.throws(()=>contextUsageFromEvents([window(value)]),/token count or window/);assert.throws(()=>contextUsageFromEvents([token(1n,{last_token_usage:{input_tokens:1n,total_tokens:value}})]),/token count or window/);}
});
test('timestamp is optional string and returned snapshots cannot mutate accumulation',()=>{
 const a=new ContextUsageAccumulator();a.push(token(100000n));a.push(token(50000n,{},1n));const r=a.finish()!;assert.equal(r.observedAt,null);assert.ok(Object.isFrozen(r));assert.ok(Object.isFrozen(r.lastCompaction));a.push(token(1n));assert.equal(r.lastInputTokens,50000n);assert.equal(a.finish()!.lastInputTokens,1n);
});
test('accessors and proxies are rejected without executing user hooks',()=>{
 let calls=0;assert.throws(()=>contextUsageFromEvents([{get type(){calls++;return 'event_msg';}}]));assert.equal(calls,0);assert.throws(()=>contextUsageFromEvents([new Proxy({}, {get(){calls++;return null;}})]));assert.equal(calls,0);
});
