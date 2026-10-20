import assert from "node:assert/strict";
import {test} from "node:test";
import {CompletionReady,COMPLETION_READY_CAP,COMPLETION_TARGET_CAP,COMPLETION_NATIVE_SLOTS,type ReadyLive,type ReadyStateWork} from "../../../../src/runtime/completion/scheduler/ready.ts";
import type {CompletionEntry} from "../../../../src/store/completion-metadata.ts";
function entry(id:string,source:CompletionEntry["source"]="Queue",channel=1n,target=id):CompletionEntry{return {source,id,target,turn:"turn",channel,bytes:1n,position:{stamp:0,ordinal:1n,id}};}
function live(target:string,payload=target,needsNative=false,released: string[]=[]):ReadyLive<string>{let done=false;return Object.freeze({target,payload,needsNative,dispose(){if(!done){done=true;released.push(payload);}}});}
function take(q:CompletionReady<string>,active:ReadonlySet<string>=new Set(),native=0){return q.takeStateAdmitted(active,native,w=>({permit:undefined,needsNative:w.kind==="Durable"||w.live.needsNative,release(){}}))?.work??null;}
const name=(w:ReadyStateWork<string>|null)=>w?.kind==="Live"?w.live.payload:w?.entry.id;
test("ready and per-target counts are bounded; rejected and queued live owners release explicitly",()=>{
  const q=new CompletionReady<string>(),released:string[]=[];
  for(let i=0;i<COMPLETION_TARGET_CAP;i++)assert.equal(q.live(live("a",String(i),false,released)),true);
  assert.equal(q.live(live("a","target overflow",false,released)),false);
  for(let i=COMPLETION_TARGET_CAP;i<COMPLETION_READY_CAP;i++)assert.equal(q.live(live(String(i),String(i),false,released)),true);
  assert.equal(q.length,128);assert.equal(q.live(live("overflow","overflow",false,released)),false);assert.equal(released.length,2);
  q.dispose();assert.equal(q.length,0);assert.equal(released.length,130);q.dispose();assert.equal(released.length,130);
});
test("native saturation cannot overtake same-target head but another target proceeds",()=>{
  const q=new CompletionReady<string>();q.live(live("a","completion",true));q.live(live("a","start"));q.live(live("b","other"));
  assert.equal(name(take(q,new Set(),3)),"other");assert.equal(take(q,new Set(),3),null);assert.equal(name(take(q,new Set(),2)),"completion");assert.equal(take(q,new Set(["a"])),null);assert.equal(name(take(q)),"start");
});
test("live supersedes rediscoverable same-target metadata and capacity evicts durable before HTTP",()=>{
  const q=new CompletionReady<string>();q.durable(entry("a"),new Set());q.live(live("a"));assert.equal(q.stateLength,1);assert.equal(name(take(q)),"a");
  q.durable(entry("d"),new Set());for(let i=0;i<127;i++)q.durable(entry(String(i),"Final",BigInt(i)),new Set());
  q.live(live("new"));assert.equal(q.length,128);assert.equal(q.httpLength,127);assert.equal(name(take(q)),"new");
});
test("full live-only queue never evicts live work for durable or priority metadata",()=>{
  const q=new CompletionReady<string>();for(let i=0;i<128;i++)q.live(live(String(i)));
  q.durable(entry("extra"),new Set());q.prioritize(entry("priority","Final"));assert.equal(q.stateLength,128);assert.equal(q.httpLength,0);q.dispose();
});
test("durable suppresses active targets and duplicate state, HTTP dedup uses exact source identity",()=>{
  const q=new CompletionReady<string>();q.durable(entry("busy"),new Set(["busy"]));assert.equal(q.length,0);
  q.durable(entry("a"),new Set());q.durable(entry("other","Observed",1n,"a"),new Set());assert.equal(q.stateLength,1);
  q.durable(entry("f","Final"),new Set());q.durable({...entry("f","Final"),bytes:99n},new Set());q.durable(entry("f","Goal"),new Set());assert.equal(q.httpLength,2);
});
test("HTTP selection is channel serialized, priority replacement retains bounded order",()=>{
  const q=new CompletionReady<string>();q.durable(entry("a","Final",1n),new Set());q.durable(entry("b","Final",2n),new Set());
  assert.equal(q.takeHttp(new Map([[1n,true]]))?.id,"b");q.prioritize({...entry("a","Final",1n),bytes:9n});assert.equal(q.httpLength,1);assert.equal(q.takeHttp(new Map())?.bytes,9n);
});
test("busy durable hints are discarded while busy live heads block only own target",()=>{
  const q=new CompletionReady<string>();q.durable(entry("d"),new Set());q.live(live("a","first"));q.live(live("a","second"));q.live(live("b","other"));
  const calls:string[]=[];const selected=q.takeStateAdmitted(new Set(),0,w=>{const key=name(w)!;calls.push(key);return key==="other"?{permit:"p",needsNative:false,release(){}}:null;});
  assert.equal(selected?.permit,"p");assert.deepEqual(calls,["d","first","other"]);assert.deepEqual(q.stateSnapshot().map(name),["first","second"]);
});
test("native-blocked admission permit is released; selected permit belongs to caller",()=>{
  const q=new CompletionReady<string>();q.live(live("a","native",true));q.live(live("b","local"));const released:string[]=[];
  const chosen=q.takeStateAdmitted(new Set(),COMPLETION_NATIVE_SLOTS,w=>({permit:name(w),needsNative:w.kind==="Live"&&w.live.needsNative,release(){released.push(name(w)!);}}));
  assert.deepEqual(released,["native"]);assert.equal(chosen?.permit,"local");assert.equal(q.stateLength,1);
});
test("durable input mutation cannot change saved routing or sort metadata",()=>{
  const q=new CompletionReady<string>(),e={...entry("f","Final"),position:{stamp:0,ordinal:1n,id:"f"}};q.durable(e,new Set());e.channel=99n;e.position.id="changed";const got=q.takeHttp(new Map());assert.equal(got?.channel,1n);assert.equal(got?.position.id,"f");
});
test("queued live routing is captured from trusted adapter at insertion",()=>{
  const q=new CompletionReady<string>();const e={target:"a",needsNative:true,payload:"original",dispose(){}};q.live(e);e.target="b";e.needsNative=false;
  assert.equal(take(q,new Set(),3),null);assert.equal(name(take(q,new Set(["b"]),0)),"original");
});
