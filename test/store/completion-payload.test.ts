import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {initialCompletionCursor,type CompletionEntry} from "../../src/store/completion-metadata.ts";
import type {CompletionSource} from "../../src/store/completion-metadata-sql.ts";
import {serializeSerdeValue as json} from "../../src/core/serde-json.ts";
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
const entry=async(path:string,source:CompletionSource)=>(await state.completionPage(path,source,initialCompletionCursor(),"runtime",1n)).page.entries[0]!;
const load=(path:string,e:CompletionEntry)=>state.loadCompletionPayload(path,e,"runtime",1n);
async function final(path:string,content="body"){await edit(path,db=>db.prepare("INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES ('d','j','t','turn',1,?,1,1)").run(content));}
test("current final loads exact typed record without deleting outbox",async()=>storeFixture(async path=>{
  await final(path);const p=await load(path,await entry(path,"Final"));assert.equal(p?.kind,"Final");if(p?.kind!=="Final")throw new Error("missing final");assert.equal(p.value.content,"body");assert.equal(p.value.channelId,1n);assert.equal((await state.listPendingDeliveries(path)).length,1);
}));
test("stale channel, size, sort stamp or new earlier head refuses payload",async()=>{
  for(const sql of ["UPDATE codex_delivery_outbox SET channel_id=2","UPDATE codex_delivery_outbox SET content='longer'","UPDATE codex_delivery_outbox SET created_at=2","INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES ('earlier','j2','t2','turn2',1,'new',0,0)"])
    await storeFixture(async path=>{await final(path);const e=await entry(path,"Final");await edit(path,db=>db.exec(sql));assert.equal(await load(path,e),null);});
});
test("new unknown receipt suppresses previously discovered head",async()=>storeFixture(async path=>{
  await final(path);const e=await entry(path,"Final");await edit(path,db=>db.prepare("INSERT INTO codex_delivery_receipts(receipt_key,content_hash) VALUES (?,'hash')").run(json([1n,"completion/v1","d",0n])));assert.equal(await load(path,e),null);
}));
test("selected body byte boundary is inclusive and oversized evidence remains saved",async()=>{
  for(const size of [2*1024*1024,2*1024*1024+1])await storeFixture(async path=>{
    await final(path,"x".repeat(size));const e=await entry(path,"Final");if(size===2*1024*1024)assert.equal((await load(path,e))?.kind,"Final");else await assert.rejects(load(path,e),/exceeds in-memory budget/);
    await edit(path,db=>assert.equal(db.prepare("SELECT length(content) AS n FROM codex_delivery_outbox").get()?.n,size));
  });
});
test("same-length body change demonstrates metadata equality is not content authorization",async()=>storeFixture(async path=>{
  await final(path);const e=await entry(path,"Final");await edit(path,db=>db.exec("UPDATE codex_delivery_outbox SET content='edit'"));const p=await load(path,e);assert.equal(p?.kind,"Final");if(p?.kind==="Final")assert.equal(p.value.content,"edit");
}));
test("Observed, commentary, Goal and start payloads use exact typed read paths",async()=>storeFixture(async path=>{
  await edit(path,db=>db.exec("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload,resident_owner) VALUES ('t','turn',9007199254740993,'{}','runtime'); INSERT INTO codex_commentary_outbox(delivery_key,job_id,target_thread_id,turn_id,channel_id,text) VALUES ('c','j','t','turn',1,'progress'); INSERT INTO codex_goal_progress(thread,turn,channel,content,job_id) VALUES ('t','turn',1,'goal',NULL); INSERT INTO codex_reserve_start_notices(job_id,target_thread_id,channel_id,app_server_generation,attempt_count,content) VALUES ('j','t',1,1,0,'failure')"));
  assert.deepEqual(await load(path,await entry(path,"Observed")),{kind:"Observed",generation:9007199254740993n,json:"{}"});
  const c=await load(path,await entry(path,"Commentary"));assert.equal(c?.kind,"Commentary");if(c?.kind==="Commentary")assert.equal(c.value.text,"progress");
  const g=await load(path,await entry(path,"Goal"));assert.equal(g?.kind,"Goal");if(g?.kind==="Goal")assert.equal(g.value.jobId,null);
  const s=await load(path,await entry(path,"StartFailure"));assert.deepEqual(s,{kind:"StartFailure",value:{jobId:"j",threadId:"t",channelId:1n,content:"failure"}});
}));
test("question loader rechecks runtime scope and uses strict body decoder",async()=>storeFixture(async path=>{
  await edit(path,db=>db.prepare("INSERT INTO cdr_async_questions(id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,created_at,updated_at) VALUES ('q','runtime',1,'t','turn','item','j',1,2,?,1,1)").run('{"index":1,"title":"q","options":["yes"]}'));
  const e=await entry(path,"Question"),p=await load(path,e);assert.equal(p?.kind,"Question");if(p?.kind==="Question")assert.deepEqual(p.value.body.options,["yes"]);
  assert.equal(await state.loadCompletionPayload(path,e,"other",1n),null);assert.equal(await state.loadCompletionPayload(path,e,"runtime",2n),null);
}));
test("state work hint returns no delivery payload",async()=>storeFixture(async path=>{
  await state.enqueue(path,queueJob());assert.equal(await load(path,await entry(path,"Queue")),null);
}));
test("snapshot captures input before await and rejects getter hints",async()=>storeFixture(async path=>{
  await final(path);const e=await entry(path,"Final"),mutable={...e,position:{...e.position}};
  const work=load(path,mutable);mutable.id="other";mutable.position.stamp=99;assert.equal((await work)?.kind,"Final");
  let reads=0;Object.defineProperty(mutable,"id",{get(){reads++;return "d";}});await assert.rejects(load(path,mutable),TypeError);assert.equal(reads,0);
}));
