import assert from "node:assert/strict";
import {test} from "node:test";
import {CommentaryBuffer} from "../../src/runtime/commentary-stream.ts";
const delta=(b:CommentaryBuffer,text:string,thread="t",turn="u",item="i")=>b.observe("item/reasoning/summaryTextDelta",{threadId:thread,turnId:turn,itemId:item,delta:text});
const complete=(b:CommentaryBuffer,item:Record<string,unknown>,threadId="t",turnId="u")=>b.observe("item/completed",{threadId,turnId,item:{id:"i",...item}});
test("reasoning summaries never become commentary replies",()=>{
  const b=new CommentaryBuffer();assert.equal(delta(b,"private reasoning summary"),null);assert.equal(b.activeItems,1);
  assert.equal(complete(b,{type:"reasoning",text:"reasoning",summary:["reasoning"]}),null);assert.equal(b.activeItems,0);
});
test("only completed commentary emits; body comes from completed item not retained deltas",()=>{
  const b=new CommentaryBuffer();delta(b,"different retained text");assert.deepEqual(complete(b,{type:"agentMessage",phase:"commentary",text:" \u0085visible progress "}),{threadId:"t",turnId:"u",text:"visible progress"});assert.equal(b.activeItems,0);
  for(const item of [{type:"agentMessage",phase:"final_answer",text:"final"},{type:"agent_message",phase:"commentary",text:"alias"},{type:"agentMessage",phase:"commentary",text:" \u0085"}])assert.equal(complete(b,item),null);
});
test("async commentary is excluded independent of renderable question options",()=>{
  const b=new CommentaryBuffer();delta(b,"x");assert.equal(complete(b,{type:"agentMessage",phase:"commentary",delivery:"async",questions:"bad",text:"question"}),null);assert.equal(b.activeItems,0);
});
test("item capacity is 128 and per-item summary bytes never split a Unicode scalar",()=>{
  const b=new CommentaryBuffer();delta(b,"a".repeat(16383));delta(b,"🦊");assert.equal(b.retainedSummaryBytes,16383);delta(b,"x🦊");assert.equal(b.retainedSummaryBytes,16384);delta(b,"overflow");assert.equal(b.retainedSummaryBytes,16384);
  for(let i=1;i<128;i++)delta(b,"한","t","u",String(i));assert.equal(b.activeItems,128);delta(b,"ignored","new","u","overflow");assert.equal(b.activeItems,128);assert.equal(b.retainedSummaryBytes,16384+127*3);
});
test("discard turn retains other thread and turn items, key delimiters cannot collide",()=>{
  const b=new CommentaryBuffer();delta(b,"a","a;b","c","i");delta(b,"b","a","b;c","i");delta(b,"c","a;b","other","i");assert.equal(b.activeItems,3);
  b.discardTurn("a;b","c");assert.equal(b.activeItems,2);assert.equal(b.retainedSummaryBytes,2);
});
test("invalid fields do not create entries; empty delta creates source-compatible empty item",()=>{
  const b=new CommentaryBuffer();b.observe("item/reasoning/summaryTextDelta",{threadId:"",turnId:"u",itemId:"i",delta:"x"});b.observe("other",{});assert.equal(b.activeItems,0);
  delta(b,"");assert.equal(b.activeItems,1);assert.equal(b.retainedSummaryBytes,0);assert.equal(complete(b,{type:"tool"}),null);assert.equal(b.activeItems,0);
});
