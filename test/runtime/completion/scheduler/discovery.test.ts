import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {test} from "node:test";
import {storeFixture} from "../../../helpers/store-fixture.ts";
import {queueJob} from "../../../helpers/queue-job.ts";
import {StateAccessFacade as state} from "../../../../src/store/state-access-facade.ts";
import {openInitialized,CheckedRead} from "../../../../src/store/owned-driver.ts";
import {CompletionReady} from "../../../../src/runtime/completion/scheduler/ready.ts";
import {CompletionDiscovery} from "../../../../src/runtime/completion/scheduler/discovery.ts";
import type {CompletionEntry} from "../../../../src/store/completion-metadata.ts";
const empty=new Set<string>();
async function seed(path:string,count:number){for(let i=0;i<count;i++){const id=`job-${String(i).padStart(3,"0")}`;await state.enqueue(path,queueJob({jobId:id,targetThreadId:id}));}}
const read=(s:CompletionDiscovery,path:string,q:CompletionReady<string>,active=empty)=>s.read(path,"runtime",1n,q,active);
const e=(id:string,source:CompletionEntry["source"]="Queue"):CompletionEntry=>({source,id,target:id,turn:"",channel:1n,bytes:0n,position:{stamp:0,ordinal:1n,id}});
test("no due page leaves absent database untouched and rotates sources",async()=>storeFixture(async path=>{
  await seed(path,1);const s=new CompletionDiscovery(["Queue","Observed"],()=>0),q=new CompletionReady<string>();read(s,path,q);const before=s.snapshot();
  const absent=path+".absent";const report=read(s,absent,q);assert.ok(report.every(r=>r.ok&&r.metadata===null));assert.equal(existsSync(absent),false);assert.deepEqual(s.snapshot(),before);assert.equal(s.rotation,0);
}));
test("common schema failure rolls back scan state and existing ready ownership remains",async()=>storeFixture(async path=>{
  await seed(path,2);const s=new CompletionDiscovery(["Queue","Observed"],()=>0),q=new CompletionReady<string>();let disposed=0;q.live({target:"live",needsNative:false,payload:"live",dispose(){disposed++;}});q.durable(e("old-http","Final"),empty);
  const before=s.snapshot();const db=await openInitialized(path);try{db.exec("DROP INDEX codex_mutation_prepared_target");}finally{db.close();}
  assert.throws(()=>read(s,path,q));assert.deepEqual(s.snapshot(),before);assert.equal(s.rotation,0);assert.equal(q.stateLength,1);assert.equal(q.httpLength,1);assert.equal(disposed,0);q.dispose();assert.equal(disposed,1);
}));
test("failed duplicate source keeps its cursor while other sources progress",async()=>storeFixture(async path=>{
  await seed(path,2);const s=new CompletionDiscovery(["Queue","Queue","Observed"],()=>0),q=new CompletionReady<string>();const original=s.snapshot()[1]!.cursor;
  const report=read(s,path,q);assert.deepEqual(report.map(r=>r.ok),[true,false,true]);assert.strictEqual(s.snapshot()[1]!.cursor,original);assert.equal(q.stateLength,2);assert.equal(s.rotation,1);
}));
test("full ready retains entire new page; pending tail prevents another database read",async()=>storeFixture(async path=>{
  await seed(path,34);const s=new CompletionDiscovery(["Queue"],()=>0),q=new CompletionReady<string>();for(let i=0;i<128;i++)q.live({target:`live-${i}`,needsNative:false,payload:"live",dispose(){}});
  read(s,path,q);assert.equal(s.snapshot()[0]!.pending.length,32);assert.equal(s.snapshot()[0]!.cursor.finished,false);const before=s.snapshot();
  read(s,path+".absent",q);assert.deepEqual(s.snapshot(),before);assert.equal(existsSync(path+".absent"),false);
  q.dispose();read(s,path,q);assert.equal(q.stateLength,34);assert.equal(s.snapshot()[0]!.pending.length,0);assert.equal(s.drained,true);
}));
test("wake finishes current finite pass before restarting with newly added rows",async()=>storeFixture(async path=>{
  await seed(path,34);let now=0;const s=new CompletionDiscovery(["Queue"],()=>now),q=new CompletionReady<string>();read(s,path,q);
  await state.enqueue(path,queueJob({jobId:"job-999",targetThreadId:"job-999"}));s.wake();read(s,path,q);assert.equal(q.stateLength,34);assert.equal(s.snapshot()[0]!.wake,true);
  read(s,path,q);assert.equal(q.stateLength,34);assert.equal(s.snapshot()[0]!.wake,false);read(s,path,q);assert.equal(q.stateLength,35);now=30001;assert.ok(read(s,path,q)[0]?.ok);
}));
test("rotated source order preserves live FIFO and skips active targets only as hints",async()=>storeFixture(async path=>{
  await seed(path,2);const s=new CompletionDiscovery(["Observed","Queue"],()=>0),q=new CompletionReady<string>();q.live({target:"live",needsNative:false,payload:"first",dispose(){}});q.live({target:"live",needsNative:false,payload:"second",dispose(){}});
  assert.deepEqual(read(s,path,q,new Set(["job-000"])).map(r=>r.source),["Observed","Queue"]);assert.equal(q.stateLength,3);assert.deepEqual(q.stateSnapshot().slice(0,2).map(w=>w.kind==="Live"?w.live.payload:"bad"),["first","second"]);
  assert.deepEqual(read(s,path,q).map(r=>r.source),["Queue","Observed"]);const db=await openInitialized(path);try{assert.equal(db.prepare("SELECT count(*) AS n FROM codex_turn_queue").get()?.n,2);}finally{db.close();}
}));
test("finish failure publishes neither cursor nor speculative ready tail",async()=>storeFixture(async path=>{
  await seed(path,2);const s=new CompletionDiscovery(["Queue"],()=>0),q=new CompletionReady<string>();q.durable(e("existing","Final"),empty);const before=s.snapshot(),finish=CheckedRead.prototype.finish,sentinel=new Error("finish failed");
  CheckedRead.prototype.finish=function(){throw sentinel;};try{assert.throws(()=>read(s,path,q),error=>error===sentinel);}finally{CheckedRead.prototype.finish=finish;}
  assert.deepEqual(s.snapshot(),before);assert.equal(q.stateLength,0);assert.equal(q.httpLength,1);assert.equal(s.rotation,0);
}));
test("nested append-only draft rollback removes only speculative hints",()=>{
  const q=new CompletionReady<string>();q.durable(e("original","Final"),empty);
  assert.throws(()=>q.draft(()=>{q.durable(e("a"),empty);q.draft(()=>q.durable(e("b","Final"),empty));throw new Error("rollback");}));assert.equal(q.stateLength,0);assert.deepEqual(q.httpSnapshot().map(x=>x.id),["original"]);
  assert.throws(()=>q.draft(()=>q.takeHttp(new Map())),/append-only/);assert.equal(q.httpLength,1);
});
async function orphan(path:string){const db=await openInitialized(path);try{db.exec("INSERT INTO cdr_async_execution_obligations(question_id,thread_id,origin_job_id,turn_id,channel_id,format_version,revision,answer_state,execution_state,admission_state,policy,claim_json,original_error,created_at,updated_at) VALUES ('q','orphan','lost','turn',1,1,0,'unresolved','unresolved','held','ordinary','{}','original uncertainty',0,0)");}finally{db.close();}}
test("negative sidecar removes only exact newly appended orphan hint and retains DB evidence",async()=>storeFixture(async path=>{
  await orphan(path);const s=new CompletionDiscovery(["AsyncOrphan"],()=>0),q=new CompletionReady<string>();q.live({target:"live",needsNative:false,payload:"original",dispose(){}});
  const reports=read(s,path,q),r=reports[0]!;assert.equal(r.ok,true);if(!r.ok||r.metadata===null)throw new Error("missing metadata");assert.equal(r.metadata.deferred.length,1);
  assert.equal(q.discardOrphanHints(r.metadata.deferred),1);assert.equal(q.stateLength,1);assert.equal(q.discardOrphanHints(r.metadata.deferred),0);
  const db=await openInitialized(path);try{assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_async_execution_obligations").get()?.n,1);}finally{db.close();}
}));
test("backpressured orphan page does not carry negative sidecar into a later snapshot",async()=>storeFixture(async path=>{
  await orphan(path);const s=new CompletionDiscovery(["AsyncOrphan"],()=>0),q=new CompletionReady<string>();for(let i=0;i<128;i++)q.live({target:`live-${i}`,needsNative:false,payload:"live",dispose(){}});
  const first=read(s,path,q)[0]!;assert.ok(first.ok&&first.metadata?.deferred.length===0);assert.equal(s.snapshot()[0]!.pending.length,1);
  q.dispose();const second=read(s,path+".absent",q)[0]!;assert.ok(second.ok&&second.metadata===null);assert.equal(q.stateLength,1);assert.equal(existsSync(path+".absent"),false);
}));
