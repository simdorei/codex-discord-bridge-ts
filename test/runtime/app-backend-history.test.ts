import assert from "node:assert/strict";
import {test} from "node:test";
import {readBackendAsyncHistory as history,readBackendAsyncTerminal as terminal,type BackendHistoryPort} from "../../src/runtime/app-backend-history.ts";
import {BackendFailureError} from "../../src/runtime/queue-runner/errors.ts";
import type {AppRequest} from "../../src/app-server/requests.ts";
import {boundedSerdeByteCount} from "../../src/core/serde-byte-count.ts";
function fixture(pages:unknown[],options:{metadata?:unknown;goal?:unknown;after?:(method:string)=>void}={}){
  let index=0,g=1n;const calls:{request:AppRequest;generation:bigint}[]=[];
  const port:BackendHistoryPort={generation:()=>g,request:async(request,generation)=>{calls.push({request,generation});const result=request.method==="thread/turns/list"?pages[index++]:request.method==="thread/goal/get"?options.goal??{goal:null}:options.metadata??{thread:{id:"T"}};options.after?.(request.method);return result;}};
  return {port,calls,change:()=>{g++;}};
}
const rejects=(text:string)=>(e:unknown)=>e instanceof BackendFailureError&&!e.failure.ambiguous&&e.failure.message.includes(text);
test("empty originals perform no requests and duplicate original IDs remain legal",async()=>{
  const f=fixture([{data:[{id:"x"}],nextCursor:null}]);assert.equal(await history(f.port,"T",[],5000),null);assert.equal(await terminal(f.port,"T",[],5000),null);assert.equal(f.calls.length,0);assert.deepEqual(await history(f.port,"T",["x","x"],5000),{threadId:"T",turns:[{id:"x"}],history_exhausted:true});
  assert.deepEqual(f.calls.map(x=>x.request.timeoutMs),[2000,2000]);assert.deepEqual(f.calls[1]!.request.params,{threadId:"T",limit:16n,sortDirection:"desc",itemsView:"full",cursor:null});
});
test("wanted turns preserve arrival order and early success validates cursor before completion",async()=>{
  const f=fixture([{data:[{id:"other"},{id:"z"}],nextCursor:"c"},{data:[{id:"a"}],nextCursor:"c"}]);assert.deepEqual(await history(f.port,"T",["a","z"],700),{threadId:"T",turns:[{id:"z"},{id:"a"}],history_exhausted:false});assert.equal(f.calls.length,3);assert.ok(f.calls.every(c=>c.generation===1n&&c.request.timeoutMs===700));
  await assert.rejects(history(fixture([{data:[{id:"x"}],nextCursor:3n}]).port,"T",["x"],500),rejects("invalid historical cursor"));
});
test("missing or null cursor means exhausted even when wanted originals are absent",async()=>{
  for(const page of [{data:[]},{data:[],nextCursor:null}])assert.deepEqual(await history(fixture([page]).port,"T",["missing"],500),{threadId:"T",turns:[],history_exhausted:true});
});
for(const [label,pages,message] of [
  ["truncated",[{data:[],truncated:true}],"truncated"],
  ["truncated null",[{data:[],truncated:null}],"truncated"],
  ["not array",[{data:{}}],"bounded turn array"],
  ["seventeen",[{data:Array.from({length:17},(_,i)=>({id:String(i)}))}],"bounded turn array"],
  ["missing ID",[{data:[{}]}],"identity missing"],
  ["empty ID",[{data:[{id:""}]}],"identity missing"],
  ["multibyte ID",[{data:[{id:"한".repeat(171)}]}],"identity missing"],
  ["duplicate unwanted",[{data:[{id:"u"}],nextCursor:"a"},{data:[{id:"u"}]}],"duplicate"],
  ["empty cursor",[{data:[],nextCursor:""}],"invalid historical cursor"],
  ["multibyte cursor",[{data:[],nextCursor:"한".repeat(683)}],"invalid historical cursor"],
  ["cursor cycle",[{data:[],nextCursor:"a"},{data:[],nextCursor:"a"}],"cursor repeated"],
  ["eight pages",Array.from({length:8},(_,i)=>({data:[{id:String(i)}],nextCursor:String(i)})),"eight pages"],
] as const)test(`bounded history rejects ${label}`,async()=>{await assert.rejects(history(fixture([...pages]).port,"T",["wanted"],500),rejects(message));});
test("maximum originals checked before RPC; generation and metadata identities cannot drift",async()=>{
  const f=fixture([]);await assert.rejects(history(f.port,"T",Array(129).fill("x"),500),rejects("too many"));assert.equal(f.calls.length,0);
  await assert.rejects(history(fixture([],{metadata:{thread:{id:"other"}}}).port,"T",["x"],500),rejects("different"));
  const changed=fixture([{data:[]}],{after:m=>{if(m==="thread/turns/list")changed.change();}});await assert.rejects(history(changed.port,"T",["x"],500),rejects("connection changed"));
});
test("serialized UTF-8 page budget is exact and cumulative, metadata excluded by source contract",async()=>{
  const max=1048576,base={data:[],padding:""},overhead=boundedSerdeByteCount(base,max)!;
  const exact={...base,padding:"a".repeat(max-overhead)};assert.equal(boundedSerdeByteCount(exact,max),max);assert.ok(await history(fixture([exact]).port,"T",["x"],500));await assert.rejects(history(fixture([{...exact,padding:exact.padding+"a"}]).port,"T",["x"],500),rejects("byte bound"));
  await assert.rejects(history(fixture([{data:[],padding:"a".repeat(600000),nextCursor:"a"},{data:[],padding:"b".repeat(600000)}]).port,"T",["x"],500),rejects("byte bound"));
  assert.ok(await history(fixture([{data:[]}],{metadata:{thread:{id:"T"},padding:"a".repeat(max)}}).port,"T",["x"],500));
});
test("terminal evidence rereads metadata, keeps raw goal, rejects changed generation and combined overflow",async()=>{
  const f=fixture([{data:[{id:"x",status:"inProgress"}]}],{goal:{anything:1n}});const result=await terminal(f.port,"T",["x"],500);assert.deepEqual(result!.goal_observation,{anything:1n});assert.deepEqual(f.calls.map(c=>c.request.method),["thread/read","thread/turns/list","thread/goal/get","thread/read"]);
  const changed=fixture([{data:[]}],{after:m=>{if(m==="thread/goal/get")changed.change();}});await assert.rejects(terminal(changed.port,"T",["x"],500),rejects("terminal connection changed"));
  await assert.rejects(terminal(fixture([{data:[]}],{goal:{padding:"한".repeat(350000)}}).port,"T",["x"],500),rejects("terminal observation exceeds"));
});
test("aborted caller never performs a read and page poison is rejected without getter execution",async()=>{
  const f=fixture([]),c=new AbortController(),reason={cancel:true};c.abort(reason);await assert.rejects(history(f.port,"T",["x"],500,c.signal),e=>e===reason);assert.equal(f.calls.length,0);
  let calls=0;await assert.rejects(history(fixture([{get data(){calls++;return [];}}]).port,"T",["x"],500));assert.equal(calls,0);
});
