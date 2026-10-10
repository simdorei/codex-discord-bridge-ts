import assert from "node:assert/strict";
import {test} from "node:test";
import {collectRecoveryObservation} from "../../src/app-server/recovery-collector.ts";
import {boundedSerdeByteCount} from "../../src/core/serde-byte-count.ts";
const idle=()=>({thread:{id:"T",status:{type:"idle"}}});
const turn=(id="V",status="completed")=>({id,status});
function run(pages:unknown[],options:{initial?:unknown;goal?:unknown;final?:unknown;owners?:string[]}={}){
  const calls:{method:string;params:unknown}[]=[],responses=[options.initial??idle(),...pages,options.goal??{goal:null},options.final??idle()];
  const promise=collectRecoveryObservation("T",new Set(options.owners??["V"]),async(method,params)=>{calls.push({method,params});assert.ok(responses.length);return responses.shift();});return {promise,calls};
}
test("collector reads initial/current idle state around owner-scoped terminal history and ended Goal",async()=>{
  const f=run([{data:[turn("unrelated","active"),turn()],nextCursor:"remaining"}]);const result=await f.promise as any;assert.deepEqual(f.calls.map(c=>c.method),["thread/read","thread/turns/list","thread/goal/get","thread/read"]);assert.deepEqual(f.calls[1]!.params,{threadId:"T",limit:16n,sortDirection:"desc",itemsView:"full",cursor:null});assert.deepEqual(result.turns,[turn()]);assert.equal(result.required_owners_complete,true);assert.equal(result.history_exhausted,false);assert.ok(Object.isFrozen(result.turns));
});
test("only explicit null nextCursor certifies exhausted history after all required owners were found",async()=>{
  for(const [page,exhausted]of [[{data:[turn()],nextCursor:null},true],[{data:[turn()]},false],[{data:[turn()],nextCursor:"next"},false]] as const){const result=await run([page]).promise as any;assert.equal(result.history_exhausted,exhausted);}
});
test("all turn identities are unique, including irrelevant owners, and selected owners must be fully terminal",async()=>{
  await assert.rejects(run([{data:[turn("x")],nextCursor:"p2"},{data:[turn("x"),turn()],nextCursor:null}]).promise,/duplicate recovery turn/);
  for(const value of [turn("V","inProgress"),{...turn(),truncated:true},{...turn(),truncated:null}])await assert.rejects(run([{data:[value],nextCursor:null}]).promise,/not fully terminal/);
});
test("wrong target, page truncation, oversized page and incomplete inventory never become absence proof",async()=>{
  for(const page of [{threadId:"other",data:[turn()]},{truncated:null,data:[turn()]},{truncated:true,data:[turn()]},{data:Array.from({length:17},(_,i)=>turn(String(i)))},{data:[]},{data:[{status:"completed"}],nextCursor:null}])await assert.rejects(run([page]).promise);
});
test("Goal and both thread probes must independently confirm exact ended/idle state",async()=>{
  for(const goal of [{},{goal:{threadId:"other",status:"complete"}},{goal:{threadId:"T",status:"paused"}}])await assert.rejects(run([{data:[turn()],nextCursor:null}],{goal}).promise,/Goal/);
  for(const state of [{thread:{id:"other",status:{type:"idle"}}},{thread:{id:"T",status:{type:"active"}}},{thread:{id:"T",status:{type:"idle"},archived:true}},{...idle(),truncated:null}]){await assert.rejects(run([{data:[turn()],nextCursor:null}],{initial:state}).promise,/exact current idle/);await assert.rejects(run([{data:[turn()],nextCursor:null}],{final:state}).promise,/exact current idle/);}
});
test("history cursor shape is checked even when the requested owners are complete",async()=>{
  for(const nextCursor of ["",4n,"x".repeat(2049)])await assert.rejects(run([{data:[turn()],nextCursor}]).promise,/invalid recovery history cursor/);
  await assert.rejects(run([{data:[turn("a")],nextCursor:"loop"},{data:[turn("b")],nextCursor:"loop"}]).promise,/cursor repeated/);
});
test("history is limited to eight pages while an owner found on the eighth page is accepted",async()=>{
  const pages=Array.from({length:8},(_,i)=>({data:[turn("other"+i)],nextCursor:"cursor"+i}));const f=run(pages);await assert.rejects(f.promise,/exceeds eight pages/);assert.equal(f.calls.length,9);
  pages[7]={data:[turn()],nextCursor:"more"};const g=run(pages);assert.equal((await g.promise as any).history_exhausted,false);assert.equal(g.calls.length,11);
});
test("byte budgets charge actual aggregate JSON and the combined output separately",async()=>{
  await assert.rejects(run([{data:[turn()],padding:"x".repeat(600_000)}],{initial:{...idle(),padding:"x".repeat(600_000)}}).promise,/exceeds its byte bound/);
  const page={data:[{...turn(),padding:""}],nextCursor:null},base=[idle(),page,{goal:null},idle()].reduce((n,v)=>n+boundedSerdeByteCount(v,1_048_576)!,0);page.data[0]!.padding="x".repeat(1_048_576-base);await assert.rejects(run([page]).promise,/combined recovery observation exceeds/);
});
