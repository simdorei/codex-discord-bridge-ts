import assert from "node:assert/strict";
import {test} from "node:test";
import {serializeSerdeValue} from "../../../../src/core/serde-json.ts";
import {boundedSerdeByteCount} from "../../../../src/core/serde-byte-count.ts";
import {CompletionEventBudget,extractCompletionThreadId} from "../../../../src/runtime/completion/scheduler/envelope.ts";
import {CompletionReady} from "../../../../src/runtime/completion/scheduler/ready.ts";
const event=(params:unknown={threadId:"t"},method="turn/started")=>({kind:"Notification",generation:1n,notification:{method,params}});
test("byte counter matches canonical Serde output for escaping, UTF8, floats and integers",()=>{
  for(const value of [null,true,false,"\u0000\b\t\n\f\r\"\\/한🦊\u2028",0,-0,1.5,9007199254740993n,-9223372036854775808n,{z:"x",a:[1n,1.0,"한"]}]){
    const size=Buffer.byteLength(serializeSerdeValue(value));assert.equal(boundedSerdeByteCount(value,size),size);assert.equal(boundedSerdeByteCount(value,size-1),null);
  }
});
test("unsupported values, cycles, sparse arrays, accessors and proxies reject without traps",()=>{
  let calls=0;const proxy=new Proxy({}, {ownKeys(){calls++;throw new Error("trap");},get(){calls++;throw new Error("trap");}}),cycle:Record<string,unknown>={};cycle.self=cycle;
  for(const value of [undefined,NaN,Infinity,1n<<64n,new Date(),cycle,new Array(2),{get x(){calls++;return 1;}},proxy])assert.equal(boundedSerdeByteCount(value,1000),null);assert.equal(calls,0);
});
test("target precedence exactly follows top-level then thread then turn with Rust trim",()=>{
  assert.equal(extractCompletionThreadId({threadId:" a ",conversationId:"b"}),"a");assert.equal(extractCompletionThreadId({threadId:" \u0085",conversationId:"b"}),"b");assert.equal(extractCompletionThreadId({thread:{id:" c "},turn:{threadId:"d"}}),"c");assert.equal(extractCompletionThreadId({turn:{conversationId:" e "}}),"e");assert.equal(extractCompletionThreadId({}),null);
});
test("exact method+target+JSON bytes are shared until explicit release",()=>{
  const input=event({threadId:"한",turn:{id:"u"}}),size=Buffer.byteLength("turn/started")+Buffer.byteLength("한")+Buffer.byteLength(serializeSerdeValue(input.notification.params));
  const b=new CompletionEventBudget(size),owned=b.chargeOwned(input);assert.ok(owned);assert.equal(b.availableBytes,0);assert.equal(b.chargeOwned(event()),null);owned.dispose();assert.equal(b.availableBytes,size);owned.dispose();assert.equal(b.availableBytes,size);
});
test("oversized payload/identity and gaps do not acquire budget",()=>{
  const b=new CompletionEventBudget(128);assert.equal(b.chargeOwned(event({threadId:"t",text:"x".repeat(129)})),null);assert.equal(b.chargeOwned(event({threadId:"x".repeat(4097)})),null);assert.equal(b.chargeOwned({kind:"Gap",generation:1n,skipped:1n}),null);assert.equal(b.availableBytes,128);
});
test("owned payload is immutable and native hint follows exact event method/status",()=>{
  const b=new CompletionEventBudget(),params={threadId:"t",turn:{status:"completed"}},e=b.chargeOwned(event(params,"turn/completed"))!;assert.equal(e.needsNative,true);assert.ok(Object.isFrozen(params.turn));assert.throws(()=>{params.turn.status="failed";},TypeError);e.dispose();
  for(const [method,status,native]of [["turn/completed","failed",false],["turn/started","completed",false],["thread/goal/updated","failed",true]] as const){const item=b.chargeOwned(event({threadId:"t",turn:{status}},method))!;assert.equal(item.needsNative,native);item.dispose();}
});
test("ready rejection and explicit queue disposal release charged envelope ownership",()=>{
  const b=new CompletionEventBudget(),q=new CompletionReady<ReturnType<typeof event>>();
  for(let i=0;i<16;i++)assert.equal(q.live(b.chargeOwned(event())!),true);
  const available=b.availableBytes;assert.equal(q.live(b.chargeOwned(event())!),false);assert.equal(b.availableBytes,available);q.dispose();assert.equal(b.availableBytes,b.capacity);
});
test("4MiB serialized ownership budget accepts its exact boundary and refuses one byte more",()=>{
  const method="turn/started",base=Buffer.byteLength(method)+1,empty=Buffer.byteLength(serializeSerdeValue({threadId:"t",text:""})),size=4*1024*1024-base-empty;
  const budget=new CompletionEventBudget(),owned=budget.chargeOwned(event({threadId:"t",text:"x".repeat(size)},method));assert.ok(owned);assert.equal(budget.availableBytes,0);owned.dispose();
  assert.equal(budget.chargeOwned(event({threadId:"t",text:"x".repeat(size+1)},method)),null);assert.equal(budget.availableBytes,budget.capacity);
});
test("target limit counts UTF8 bytes rather than JavaScript code units",()=>{
  const b=new CompletionEventBudget(),target="한".repeat(1365)+"x",item=b.chargeOwned(event({threadId:target}));assert.ok(item);assert.equal(Buffer.byteLength(item.target),4096);item.dispose();assert.equal(b.chargeOwned(event({threadId:target+"x"})),null);
});
