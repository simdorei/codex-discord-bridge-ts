import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {initialCompletionCursor,completionPageIn,sameCompletionIdentity,type CompletionCursor} from "../../src/store/completion-metadata.ts";
import {COMPLETION_SOURCES,completionSourceIsState,type CompletionSource} from "../../src/store/completion-metadata-sql.ts";
import {serializeSerdeValue as json} from "../../src/core/serde-json.ts";
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
const page=(path:string,source:CompletionSource,cursor=initialCompletionCursor())=>state.completionPage(path,source,cursor,"runtime",1n);
async function final(path:string,id:string,channel:bigint,target=id,time=1,content="body"){await edit(path,db=>db.prepare("INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES (?,?,?,'turn',?,?,?,1)").run(id,id,target,channel,content,time));}
async function receipt(path:string,key:string,retryable=0,blocked:string|null=null,message:string|null=null){await edit(path,db=>db.prepare("INSERT INTO codex_delivery_receipts(receipt_key,content_hash,retryable,blocked_reason,message_id) VALUES (?,'hash',?,?,?)").run(key,retryable,blocked,message));}
test("all eight empty sources finish without fabricated metadata",async()=>storeFixture(async path=>{
  for(const source of COMPLETION_SOURCES){const result=await page(path,source);assert.equal(result.cursor.finished,true);assert.deepEqual(result.page,{entries:[],oversizedIdentity:false,heldReceiptHeads:0n});}
  assert.deepEqual(COMPLETION_SOURCES.filter(completionSourceIsState),["Observed","Queue","AsyncOrphan"]);
}));
test("32-entry high-water pagination excludes rows added during unfinished pass",async()=>storeFixture(async path=>{
  for(let i=0;i<33;i++)await final(path,`d${String(i).padStart(2,"0")}`,BigInt(i+1),`target${i}`,i);
  const start=initialCompletionCursor(),first=await page(path,"Final",start);assert.equal(start.finished,false);assert.equal(first.cursor.finished,false);assert.equal(first.page.entries.length,32);
  await final(path,"later",99n,"later",99);const second=await page(path,"Final",first.cursor);assert.equal(second.cursor.finished,true);assert.deepEqual(second.page.entries.map(e=>e.id),["d32"]);
  const fresh=await page(path,"Final");const tail=await page(path,"Final",fresh.cursor);assert.deepEqual(tail.page.entries.map(e=>e.id),["d32","later"]);
}));
test("one channel head only; unknown receipt holds head without promoting later sibling",async()=>storeFixture(async path=>{
  await final(path,"a",1n,"a",1);await final(path,"b",1n,"b",2);await final(path,"c",2n,"c",3);
  assert.deepEqual((await page(path,"Final")).page.entries.map(e=>e.id),["a","c"]);
  await receipt(path,json([1n,"completion/v1","a",0n]));const held=await page(path,"Final");assert.deepEqual(held.page.entries.map(e=>e.id),["c"]);assert.equal(held.page.heldReceiptHeads,1n);
  await edit(path,db=>db.exec("UPDATE codex_delivery_receipts SET retryable=1"));assert.deepEqual((await page(path,"Final")).page.entries.map(e=>e.id),["a","c"]);
  await edit(path,db=>db.exec("UPDATE codex_delivery_receipts SET blocked_reason='blocked'"));assert.equal((await page(path,"Final")).page.heldReceiptHeads,1n);
  await edit(path,db=>db.exec("UPDATE codex_delivery_receipts SET message_id='confirmed'"));assert.equal((await page(path,"Final")).page.heldReceiptHeads,0n);
}));
test("malformed receipt JSON is ignored, oversized identity flagged without payload materialization",async()=>storeFixture(async path=>{
  await final(path,"ok",1n);await final(path,"x".repeat(1400),2n,"x".repeat(1400));await receipt(path,"not json");
  const r=await page(path,"Final");assert.equal(r.page.oversizedIdentity,true);assert.deepEqual(r.page.entries.map(e=>e.id),["ok"]);
}));
test("payload is represented only by byte length, including over-budget bytes",async()=>storeFixture(async path=>{
  await final(path,"large",1n,"target",1,"🦊".repeat(600000));const r=await page(path,"Final");assert.equal(r.page.entries[0]?.bytes,2400000n);assert.equal("content" in r.page.entries[0]!,false);
}));
test("queue discovery deduplicates target and excludes quarantined jobs",async()=>storeFixture(async path=>{
  await state.enqueue(path,queueJob({jobId:"a",targetThreadId:"target"}));await state.enqueue(path,queueJob({jobId:"b",targetThreadId:"target"}));await state.enqueue(path,queueJob({jobId:"c",targetThreadId:"excluded"}));await edit(path,db=>db.exec("UPDATE codex_turn_queue SET state='quarantined' WHERE job_id='c'"));
  assert.deepEqual((await page(path,"Queue")).page.entries.map(e=>e.target),["target"]);
}));
test("question discovery scopes runtime/generation and numeric question index",async()=>storeFixture(async path=>{
  await edit(path,db=>{for(const [id,runtime,gen,index]of [["late","runtime",1,2],["early","runtime",1,1],["foreign","other",1,0],["generation","runtime",2,0]] as const)
    db.prepare("INSERT INTO cdr_async_questions(id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,created_at,updated_at) VALUES (?,?,?,'target','turn','item','job',1,2,?,1,1)").run(id,runtime,gen,JSON.stringify({index}));});
  assert.deepEqual((await page(path,"Question")).page.entries.map(e=>e.id),["early"]);
}));
test("commentary and Goal held identities use UTF-8 key prefixes",async()=>storeFixture(async path=>{
  await edit(path,db=>db.exec("INSERT INTO codex_commentary_outbox(delivery_key,job_id,target_thread_id,turn_id,channel_id,text) VALUES ('c','j','한','🦊',1,'x'); INSERT INTO codex_goal_progress(thread,turn,channel,content,job_id) VALUES ('한','🦊',2,'g','j')"));
  await receipt(path,json([1n,"completion/commentary/v1","3:한;4:🦊;64:"+"a".repeat(64)+";",0n]));await receipt(path,json([2n,"completion/goal-progress/v1","3:한;4:🦊;",0n]));
  assert.equal((await page(path,"Commentary")).page.heldReceiptHeads,1n);assert.equal((await page(path,"Goal")).page.heldReceiptHeads,1n);
}));
test("phase-one heads retain channel ranking before target filter",async()=>storeFixture(async path=>{
  await final(path,"older",1n,"other",1);await final(path,"wanted",1n,"target",2);assert.deepEqual(await state.completionHeadsForTarget(path,"target","runtime",1n),[]);
  await edit(path,db=>db.exec("DELETE FROM codex_delivery_outbox WHERE delivery_id='older'"));assert.deepEqual((await state.completionHeadsForTarget(path,"target","runtime",1n)).map(e=>e.id),["wanted"]);
}));
test("borrowed page keeps outer transaction, failures do not advance opaque cursor",async()=>storeFixture(async path=>{
  await final(path,"a",1n);const cursor=initialCompletionCursor();await edit(path,db=>{
    db.exec("BEGIN");assert.equal(completionPageIn(db,"Final",cursor,"runtime",1n).page.entries.length,1);assert.equal(db.isTransaction,true);db.exec("ROLLBACK");
    db.exec("UPDATE codex_delivery_outbox SET channel_id='bad'");
    assert.throws(()=>completionPageIn(db,"Final",cursor,"runtime",1n),/integer bigint/);assert.equal(cursor.finished,false);
    db.exec("UPDATE codex_delivery_outbox SET channel_id=1");assert.deepEqual(completionPageIn(db,"Final",cursor,"runtime",1n).page.entries.map(e=>e.id),["a"]);
  });
}));
test("entry identity excludes channel/size/position and cursors reject forgeries without traps",async()=>storeFixture(async path=>{
  await final(path,"a",1n);const entry=(await page(path,"Final")).page.entries[0]!;assert.ok(sameCompletionIdentity(entry,{...entry,channel:2n,bytes:99n,position:{stamp:9,ordinal:9n,id:"other"}}));assert.equal(sameCompletionIdentity(entry,{...entry,turn:"other"}),false);
  let traps=0;const forged=new Proxy({}, {get(){traps++;throw new Error("trap");}});await assert.rejects(page(path,"Final",forged as CompletionCursor),TypeError);assert.equal(traps,0);assert.ok(Object.isFrozen(entry));
}));
test("observed metadata chooses one target head and reports payload bytes",async()=>storeFixture(async path=>{
  await edit(path,db=>db.exec("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload,resident_owner) VALUES ('t','first',1,'{}','runtime'),('t','second',1,'large','runtime')"));
  const r=await page(path,"Observed");assert.deepEqual(r.page.entries.map(e=>[e.target,e.turn,e.bytes]),[["t","first",2n]]);
}));
test("orphan metadata excludes owned origin and nonpending target queue",async()=>storeFixture(async path=>{
  await edit(path,db=>db.exec("INSERT INTO cdr_async_execution_obligations(question_id,thread_id,origin_job_id,turn_id,channel_id,format_version,revision,answer_state,execution_state,admission_state,policy,claim_json,original_error,created_at,updated_at) VALUES ('q','orphan','missing','turn',1,1,1,'waiting','unresolved','held','normal','{}','',1,1)"));
  assert.deepEqual((await page(path,"AsyncOrphan")).page.entries.map(e=>e.target),["orphan"]);
  await state.enqueue(path,queueJob({jobId:"missing",targetThreadId:"other"}));assert.deepEqual((await page(path,"AsyncOrphan")).page.entries,[]);
  await edit(path,db=>db.exec("DELETE FROM codex_turn_queue"));await state.enqueue(path,queueJob({jobId:"different",targetThreadId:"orphan"}));assert.equal((await page(path,"AsyncOrphan")).page.entries.length,1);
  await edit(path,db=>db.exec("UPDATE codex_turn_queue SET state='running'"));assert.deepEqual((await page(path,"AsyncOrphan")).page.entries,[]);
}));
test("start notice head is held by matching unknown rejection receipt",async()=>storeFixture(async path=>{
  await edit(path,db=>db.exec("INSERT INTO codex_reserve_start_notices(job_id,target_thread_id,channel_id,app_server_generation,attempt_count,content,created_at) VALUES ('start','t',1,1,0,'failure',1)"));
  assert.deepEqual((await page(path,"StartFailure")).page.entries.map(e=>e.id),["start"]);
  await receipt(path,json([1n,"reserve/start-failure/v1","start",0n]));const held=await page(path,"StartFailure");assert.equal(held.page.heldReceiptHeads,1n);assert.deepEqual(held.page.entries,[]);
}));
